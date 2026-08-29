import type { TransferSide, TransferCandidateView, LinkedTransferView } from '@kanean/shared'
export type { TransferSide, TransferCandidateView, LinkedTransferView }
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { accounts, journalEntries, rawTransactions, subAccounts } from '../db/data/schema.js'
import { requireOpenFiscalYear } from '../db/lookups.js'
import { deleteEntry } from '../journal/entries.js'
import { resolveSourceAccount, journalizeRawById } from '../journal/journalize.js'
import { resolveLineTax } from '../journal/lineTax.js'
import { createTwoLineDraftEntry } from '../journal/draftEntry.js'

/**
 * 取込元をまたぐ決済リンク／名寄せ（roadmap Phase3・csv-format §4.3/§5・data-model 追補）。
 * 本MVP は**口座間振替**（自分の口座Aから口座Bへの資金移動）に限定する:
 *   同額・逆方向（一方が出金・他方が入金）・別 account_ref・日付近接 のペアを検知し、
 *   利用者が承認すると 2本の未確定 draft を 1本の振替仕訳（借)入金側口座 / 貸)出金側口座）へ名寄せする。
 * これにより、振替が両口座のCSVに現れて二重に未確定計上される（誤区分＝PL歪み）のを防ぐ。
 *
 * ⚠ legalRisk:high（二重計上防止の会計的妥当性は税理士サインオフ対象）。本機能は候補提示と draft 起票に
 *   留め、確定はしない。確定済みの仕訳が絡む名寄せ/解除は拒否（先に確定取消が必要）。
 */

export interface TransferMatchRow {
  id: number
  accountRef: string | null
  amount: number
  direction: 'in' | 'out'
  txnDate: string // ISO YYYY-MM-DD
  description?: string | null
}

export interface TransferCandidate {
  outId: number
  inId: number
  amount: number
  dateDiffDays: number
  /** strong=いずれかの摘要に振替系の語あり / weak=同額・逆方向・近接のみ（偶然一致の可能性）。 */
  confidence: 'strong' | 'weak'
}

/** 振替とみなす日付近接の上限（出金日と入金日のズレ）。 */
const MAX_TRANSFER_DAYS = 3

/** 振替を裏付ける摘要キーワード（NFKC 正規化後に部分一致。半角カナ ﾌﾘｺﾐ 等も合成される）。 */
const TRANSFER_KEYWORDS = ['振替', '振込', 'フリカエ', 'フリコミ', '口座振替']

function hasTransferKeyword(desc: string | null | undefined): boolean {
  if (!desc) return false
  const n = desc.normalize('NFKC')
  return TRANSFER_KEYWORDS.some((k) => n.includes(k))
}

function daysBetween(a: string, b: string): number {
  return Math.round(Math.abs(Date.parse(a) - Date.parse(b)) / 86_400_000)
}

/**
 * 口座間振替の候補ペアを純関数で抽出する（同額・逆方向・別 account_ref・日付近接±MAX_TRANSFER_DAYS）。
 * 各明細は高々1ペア（貪欲）。入金の選好は「振替系摘要を持つ入金 → 日付が近い入金」の順（偶然同額の無関係入金が
 * 真の振替を横取りするのを抑える）。決定的（同条件は id 昇順で先勝ち）。confidence で摘要の裏付け有無を示す。
 * ⚠ 同額・逆方向・近接は偽陽性（無関係な経費出金/売上入金の偶然一致）を含みうる。候補提示に過ぎず、確定は人手＋
 * 税理士サインオフ（legalRisk:high）。weak は摘要の裏付けが無く特に確認を要する。
 */
export function matchTransferCandidates(rows: TransferMatchRow[]): TransferCandidate[] {
  const outs = rows.filter((r) => r.direction === 'out').sort((a, b) => a.id - b.id)
  const ins = rows.filter((r) => r.direction === 'in').sort((a, b) => a.id - b.id)
  const usedIn = new Set<number>()
  const candidates: TransferCandidate[] = []
  for (const o of outs) {
    if (!o.accountRef) continue
    let best: { row: TransferMatchRow; diff: number; kw: boolean } | null = null
    for (const i of ins) {
      if (usedIn.has(i.id)) continue
      if (i.amount !== o.amount) continue
      if (!i.accountRef || i.accountRef === o.accountRef) continue
      const diff = daysBetween(o.txnDate, i.txnDate)
      if (diff > MAX_TRANSFER_DAYS) continue
      const kw = hasTransferKeyword(i.description)
      // 振替系摘要の入金を優先、その中で日付が近いものを選ぶ。
      if (!best || (kw && !best.kw) || (kw === best.kw && diff < best.diff)) best = { row: i, diff, kw }
    }
    if (best) {
      usedIn.add(best.row.id)
      const strong = hasTransferKeyword(o.description) || best.kw
      candidates.push({ outId: o.id, inId: best.row.id, amount: o.amount, dateDiffDays: best.diff, confidence: strong ? 'strong' : 'weak' })
    }
  }
  return candidates
}

/** account_ref → 「親勘定/補助科目名」ラベルの対応表（取込口座のみ）。 */
function accountLabelByRef(db: DataDb): Map<string, string> {
  const subs = db
    .select({ ref: subAccounts.linkedAccountRef, subName: subAccounts.name, accName: accounts.name })
    .from(subAccounts)
    .innerJoin(accounts, eq(subAccounts.accountId, accounts.id))
    .all()
  const m = new Map<string, string>()
  for (const s of subs) if (s.ref) m.set(s.ref, `${s.accName}/${s.subName}`)
  return m
}

/** 未名寄せ（settlement_raw_id=null）かつ ignored でない明細から振替候補を抽出して表示用に整形する。 */
export function listTransferCandidates(db: DataDb): TransferCandidateView[] {
  const all = db
    .select({
      id: rawTransactions.id,
      accountRef: rawTransactions.accountRef,
      amount: rawTransactions.amount,
      direction: rawTransactions.direction,
      txnDate: rawTransactions.txnDate,
      description: rawTransactions.description,
      entryStatus: journalEntries.status,
    })
    .from(rawTransactions)
    .leftJoin(journalEntries, eq(rawTransactions.journalEntryId, journalEntries.id))
    .where(and(isNull(rawTransactions.settlementRawId), inArray(rawTransactions.status, ['pending', 'journalized'])))
    .all()
  // 確定済みの個別仕訳を持つ明細は名寄せできない（linkTransfer が拒否）。押せないボタンを出さないよう候補から除外。
  const rows = all.filter((r) => r.entryStatus !== 'confirmed')
  const byId = new Map(rows.map((r) => [r.id, r]))
  const labels = accountLabelByRef(db)
  const side = (id: number): TransferSide => {
    const r = byId.get(id)!
    return { id, accountRef: r.accountRef, label: r.accountRef ? labels.get(r.accountRef) ?? r.accountRef : '—', txnDate: r.txnDate, description: r.description }
  }
  return matchTransferCandidates(
    rows.map((r) => ({ id: r.id, accountRef: r.accountRef, amount: r.amount, direction: r.direction as 'in' | 'out', txnDate: r.txnDate, description: r.description })),
  ).map((c) => ({
    amount: c.amount,
    dateDiffDays: c.dateDiffDays,
    confidence: c.confidence,
    out: side(c.outId),
    in: side(c.inId),
  }))
}

/** 名寄せ済み（settlement_raw_id あり）の振替ペアを一覧（解除UI用）。出金側を各ペアの代表行とする。 */
export function listLinkedTransfers(db: DataDb): LinkedTransferView[] {
  const linked = db
    .select({
      id: rawTransactions.id,
      accountRef: rawTransactions.accountRef,
      amount: rawTransactions.amount,
      direction: rawTransactions.direction,
      txnDate: rawTransactions.txnDate,
      description: rawTransactions.description,
      settlementRawId: rawTransactions.settlementRawId,
      journalEntryId: rawTransactions.journalEntryId,
    })
    .from(rawTransactions)
    .where(isNotNull(rawTransactions.settlementRawId))
    .all()
  const byId = new Map(linked.map((r) => [r.id, r]))
  const labels = accountLabelByRef(db)
  const side = (r: (typeof linked)[number]): TransferSide => ({
    id: r.id,
    accountRef: r.accountRef,
    label: r.accountRef ? labels.get(r.accountRef) ?? r.accountRef : '—',
    txnDate: r.txnDate,
    description: r.description,
  })
  const out: LinkedTransferView[] = []
  for (const r of linked) {
    if (r.direction !== 'out') continue // 代表＝出金側（ペアは2行あるため重複回避）
    const other = r.settlementRawId != null ? byId.get(r.settlementRawId) : undefined
    if (!other) continue
    const entry = r.journalEntryId != null ? db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, r.journalEntryId)).all()[0] : undefined
    out.push({ amount: r.amount, out: side(r), in: side(other), entryId: r.journalEntryId, entryStatus: entry?.status ?? null })
  }
  return out
}

function getRaw(db: DataDb, id: number) {
  const r = db.select().from(rawTransactions).where(eq(rawTransactions.id, id)).all()[0]
  if (!r) throw new Error(`取込明細 ${id} が見つかりません`)
  return r
}

/** draft 仕訳が紐づくなら削除（確定済みは拒否）。deleteEntry は raw を pending に戻す。 */
function detachDraft(db: DataDb, raw: typeof rawTransactions.$inferSelect): void {
  if (raw.journalEntryId == null) return
  const entry = db.select().from(journalEntries).where(eq(journalEntries.id, raw.journalEntryId)).all()[0]
  if (entry?.status === 'confirmed') throw new Error('確定済みの仕訳がある明細は名寄せできません（先に確定取消・削除してください）')
  if (entry) deleteEntry(db, raw.journalEntryId, '口座間振替の名寄せ')
}

/**
 * 出金明細(account A) と入金明細(account B) を口座間振替として名寄せする。
 * 既存の個別 draft を削除し、1本の振替 draft（借)B / 貸)A）を作って両明細を相互リンクする。
 */
export function linkTransfer(db: DataDb, outRawId: number, inRawId: number): void {
  const out = getRaw(db, outRawId)
  const inn = getRaw(db, inRawId)
  if (out.direction !== 'out' || inn.direction !== 'in') throw new Error('出金明細と入金明細のペアを指定してください')
  if (!out.accountRef || !inn.accountRef || out.accountRef === inn.accountRef) throw new Error('別口座の明細を指定してください')
  if (out.amount !== inn.amount) throw new Error('金額が一致しません')
  // 日付近接も書込み側で検証する（候補抽出と同じ不変条件を write gate に集約。API 直叩きで離れたペアの併合を防ぐ）。
  if (daysBetween(out.txnDate, inn.txnDate) > MAX_TRANSFER_DAYS) throw new Error('出金日と入金日が離れすぎています（振替とみなせません）')
  if (out.settlementRawId != null || inn.settlementRawId != null) throw new Error('既に名寄せ済みの明細です')
  if (out.status === 'ignored' || inn.status === 'ignored') throw new Error('除外済みの明細は名寄せできません')

  // 既存の個別 draft を削除（確定済みは detachDraft が拒否）。deleteEntry は自前 db.transaction を持ち
  // better-sqlite3 はネスト不可のため、後段の振替作成トランザクションの外で先に実行する。両者は非原子だが、
  // 後段が失敗しても deleteEntry が両明細を pending(settlement_raw_id=null) に戻すため、個別 draft も振替も無い
  // 宙吊りは残らず再び候補に戻る良性の失敗で済む（rawStatus.ignoreRawTransaction と同方針）。
  detachDraft(db, out)
  detachDraft(db, inn)

  // 振替仕訳の科目・税区分・年度を読取で解決（書込み前）。
  const aAcc = resolveSourceAccount(db, out.accountRef) // 出金側 A
  const bAcc = resolveSourceAccount(db, inn.accountRef) // 入金側 B
  const openYear = requireOpenFiscalYear(db)
  const debit = resolveLineTax(db, { accountId: bAcc.accountId, subAccountId: bAcc.subAccountId, amount: out.amount })
  const credit = resolveLineTax(db, { accountId: aAcc.accountId, subAccountId: aAcc.subAccountId, amount: out.amount })
  const description = `口座間振替 ${out.accountRef}→${inn.accountRef}`

  // create + link を1トランザクションに（tx で全書込み。読取は前段で完了済み）。
  db.transaction((tx) => {
    const entryId = createTwoLineDraftEntry(
      tx,
      { fiscalYearId: openYear.id, entryDate: out.txnDate, description, source: 'transfer', sourceRef: `${out.id}:${inn.id}` },
      { side: 'debit', accountId: bAcc.accountId, subAccountId: bAcc.subAccountId, tax: debit, amount: out.amount },
      { side: 'credit', accountId: aAcc.accountId, subAccountId: aAcc.subAccountId, tax: credit, amount: out.amount },
    )
    tx.update(rawTransactions).set({ status: 'journalized', journalEntryId: entryId, settlementRawId: inn.id, suggestedAccountId: bAcc.accountId }).where(eq(rawTransactions.id, out.id)).run()
    tx.update(rawTransactions).set({ status: 'journalized', journalEntryId: entryId, settlementRawId: out.id, suggestedAccountId: aAcc.accountId }).where(eq(rawTransactions.id, inn.id)).run()
  })
}

/** 振替名寄せを解除する。振替 draft を削除し、両明細を個別 draft に戻す（確定済みは拒否）。 */
export function unlinkTransfer(db: DataDb, rawId: number): void {
  const raw = getRaw(db, rawId)
  if (raw.settlementRawId == null) throw new Error('この明細は名寄せされていません')
  const otherId = raw.settlementRawId
  if (raw.journalEntryId != null) {
    const entry = db.select().from(journalEntries).where(eq(journalEntries.id, raw.journalEntryId)).all()[0]
    if (entry?.status === 'confirmed') throw new Error('確定済みの振替仕訳は解除できません（先に確定取消してください）')
    // deleteEntry は当該 entry を参照する全 raw（両明細）を pending に戻す。
    if (entry) deleteEntry(db, raw.journalEntryId, '口座間振替の名寄せ解除')
  }
  // 相互リンクを解除し、両明細を pending として個別 draft に作り直す。
  db.update(rawTransactions).set({ settlementRawId: null }).where(inArray(rawTransactions.id, [rawId, otherId])).run()
  for (const id of [rawId, otherId]) {
    const r = getRaw(db, id)
    if (r.status !== 'pending') db.update(rawTransactions).set({ status: 'pending', journalEntryId: null }).where(eq(rawTransactions.id, id)).run()
    journalizeRawById(db, id)
  }
}
