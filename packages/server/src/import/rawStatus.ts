import type { RawStatus, RawTransactionListResponse, RawTransactionView, RawYearScope } from '@kanean/shared'
export type { RawTransactionView }
import { and, desc, eq, gt, gte, lt, lte, or, sql, type SQL } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { importBatches, journalEntries, rawTransactions } from '../db/data/schema.js'
import { getOpenFiscalYear, requireOpenFiscalYear } from '../db/lookups.js'
import { deleteEntry } from '../journal/entries.js'
import { journalizeRawById } from '../journal/journalize.js'
import { assertInFiscalPeriod, type FiscalPeriod } from '../journal/fiscalPeriod.js'

/**
 * 取込明細（raw_transactions）の状態ライフサイクル（roadmap Phase3「未確定明細の溜め込み強化」）。
 *
 * 状態（data-model §2.10.2）:
 * - pending: 取込済み・未仕訳（draft 削除で戻ってくる過渡状態含む）
 * - journalized: draft または confirmed の仕訳に紐づく
 * - ignored: 利用者が「事業の取引でない／計上しない」と判断して退避（レビュー待ち行列から除外）
 *
 * ignored はスキーマに定義されていたが配線が無かった（dead scaffolding）。ここで退避/復帰/可視化を配線する。
 * 会計期間ゲート（C-8）で翌期分はそもそも取り込まれない（保留しない）ため、ignored は期間内明細の除外専用。
 */

/** 一覧返却の上限（先頭のみ）。importer の SAMPLE_LIMIT と同様、ペイロードは絞るが総件数は必ず返す（黙って切らない）。 */
const LIST_LIMIT = 500

// 状態・年スコープ・応答の wire 型は shared（api/imports.ts）が正（issue #245。フィールドのドリフトを型検査で止める）。
export interface RawListOptions {
  status?: RawStatus
  years?: RawYearScope
}

/** 取込明細を状態・年スコープ付きで一覧（状態フィルタUI）。新しい順。総件数・truncated を併せて返す。 */
export function listRawTransactions(db: DataDb, opts: RawListOptions = {}): RawTransactionListResponse {
  const { status, years = 'open' } = opts
  // 年スコープは open 年度の日付範囲で決める（raw_transactions に fiscal_year_id は持たない）。
  // 開いている会計年度が無ければ絞らない（取込明細は open 年度があった時期にしか作られないが、
  // 万一残っていたときに見えなくなる方が悪い）。
  const openYear = years === 'all' ? undefined : getOpenFiscalYear(db)
  const period: FiscalPeriod | undefined = openYear && { startDate: openYear.startDate, endDate: openYear.endDate }

  const statusCond = status ? eq(rawTransactions.status, status) : undefined
  const inYear = period && and(gte(rawTransactions.txnDate, period.startDate), lte(rawTransactions.txnDate, period.endDate))
  const outOfYear = period && or(lt(rawTransactions.txnDate, period.startDate), gt(rawTransactions.txnDate, period.endDate))

  const count = (cond: SQL | undefined): number => {
    const q = db.select({ c: sql<number>`count(*)` }).from(rawTransactions)
    return (cond ? q.where(cond) : q).all()[0].c
  }
  const total = count(and(statusCond, inYear))
  const outOfYearTotal = outOfYear ? count(and(statusCond, outOfYear)) : 0

  const base = db
    .select({
      id: rawTransactions.id,
      txnDate: rawTransactions.txnDate,
      amount: rawTransactions.amount,
      direction: rawTransactions.direction,
      description: rawTransactions.description,
      status: rawTransactions.status,
      sourceType: importBatches.sourceType,
      accountRef: rawTransactions.accountRef,
      journalEntryId: rawTransactions.journalEntryId,
      entryStatus: journalEntries.status,
    })
    .from(rawTransactions)
    .innerJoin(importBatches, eq(rawTransactions.batchId, importBatches.id))
    .leftJoin(journalEntries, eq(rawTransactions.journalEntryId, journalEntries.id))
  const where = and(statusCond, inYear)
  const rows = (where ? base.where(where) : base)
    .orderBy(desc(rawTransactions.txnDate), desc(rawTransactions.id))
    .limit(LIST_LIMIT)
    .all()
  return {
    rawTransactions: rows.map((r) => ({ ...r, direction: r.direction as 'in' | 'out' })),
    total,
    truncated: total > LIST_LIMIT,
    outOfYearTotal,
  }
}

/**
 * 明細を ignored（退避）にする。
 * - draft 仕訳が紐づく場合はその draft を削除（監査ログ delete・取込明細は pending へ戻る）してから ignored にする。
 * - confirmed 仕訳が紐づく場合は拒否（先に確定取消/削除が必要。確定済み帳簿を黙って崩さない）。
 * - 既に ignored なら no-op（冪等）。
 */
export function ignoreRawTransaction(db: DataDb, rawId: number, note?: string | null): void {
  const raw = db.select().from(rawTransactions).where(eq(rawTransactions.id, rawId)).all()[0]
  if (!raw) throw new Error(`取込明細 ${rawId} が見つかりません`)
  if (raw.status === 'ignored') return
  // 名寄せ済み（口座間振替）の明細は単独で除外できない。片側だけ ignored 化すると相手側の settlement_raw_id が
  // 宙吊りになり整合が崩れる（二重計上の再発・片側の会計消失）。先に名寄せ（振替）を解除させる。
  if (raw.settlementRawId != null) throw new Error('名寄せ（振替）済みの明細です。先に名寄せタブで解除してください')
  if (raw.journalEntryId != null) {
    const entry = db.select().from(journalEntries).where(eq(journalEntries.id, raw.journalEntryId)).all()[0]
    if (entry?.status === 'confirmed') {
      throw new Error('確定済みの仕訳がある明細は除外できません（先に確定取消・削除してください）')
    }
    if (entry) deleteEntry(db, raw.journalEntryId, note ?? '取込明細を除外(ignored)')
  }
  // 注: deleteEntry は自前の db.transaction を持つ（better-sqlite3 はネスト不可）ため外側で包めない。
  // この更新を別個に行う非原子性は許容する: deleteEntry コミット後にプロセスが落ちても、draft は削除済み・
  // raw は pending（deleteEntry が戻す）で参照の宙吊りは無く、再度 ignore できる良性の失敗で済む。
  db.update(rawTransactions).set({ status: 'ignored', journalEntryId: null }).where(eq(rawTransactions.id, rawId)).run()
}

/** ignored を解除して再び draft 仕訳化する（pending 経由で draft を作り直す）。 */
export function restoreRawTransaction(db: DataDb, rawId: number): void {
  const raw = db.select().from(rawTransactions).where(eq(rawTransactions.id, rawId)).all()[0]
  if (!raw) throw new Error(`取込明細 ${rawId} が見つかりません`)
  if (raw.status !== 'ignored') throw new Error('除外(ignored)状態の明細のみ復帰できます')
  // 会計期間ゲート（[[journal]]）を書込みの前に当てる。繰越を跨いで残った過年度の明細を復帰すると、
  // 自分の会計年度の範囲外に立つ仕訳ができる。仕訳化側にも同じゲートがある（下の catch は二重の壁）。
  const openYear = requireOpenFiscalYear(db)
  assertInFiscalPeriod(openYear, raw.txnDate, '取込明細の日付')
  // pending 化と再仕訳はセット。再仕訳が失敗（開いている会計年度が無い等。journalizeRawById は
  // 書込み前に検証を read で行うため、失敗時は未書込み）したら ignored へ戻し、pending 取り残しを防ぐ。
  db.update(rawTransactions).set({ status: 'pending' }).where(eq(rawTransactions.id, rawId)).run()
  try {
    journalizeRawById(db, rawId)
  } catch (err) {
    db.update(rawTransactions).set({ status: 'ignored' }).where(eq(rawTransactions.id, rawId)).run()
    throw err
  }
}
