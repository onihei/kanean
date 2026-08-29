import type { RolloverResult, RolloverPrecheck } from '@kanean/shared'
export type { RolloverResult, RolloverPrecheck }
import { and, asc, eq, gt, gte, lte, sql } from 'drizzle-orm'
import { yen } from '@kanean/shared'
import { accountBalance, rolloverOpeningBalances, type RolloverAccountRow } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { fiscalYears, journalEntries, journalLines, openingBalances, rawTransactions } from '../db/data/schema.js'
import { requireAccountIdByName as accountIdByName } from '../db/lookups.js'
import { accountAggregates, balanceSheet } from '../reports/reports.js'
import { previewCapitalTransfer } from './capitalTransfer.js'

/**
 * 年度繰越（year-end close & rollover。accounting-spec §1.3 / §5.2）。
 *
 * (1) 当期(open)の貸借一致を確認 → (2) 翌期 fiscal_year を作成(暦年・open) →
 * (3) 翌期 opening_balances を生成（資産・負債の期末残高を**補助科目別**に繰越 + 元入金=§1.3翌期首元入金。
 *     事業主貸・事業主借・控除前所得は元入金へ吸収＝繰越さない） → (4) 当期を closed にロック。
 * 全体を db.transaction で原子化（途中失敗で中途半端な繰越を残さない）。
 *
 * close 後の編集は既存ガード（requireOpenYearFor 等）が status='open' でなくなったことで自動的に拒否する。
 *
 * legalRisk:high — close は確定操作。API は {confirm:true} を要求し、税理士サインオフ後の実行を促す。
 */

const ASSET_LIABILITY_SECTIONS = new Set(['流動資産', '固定資産', '繰延資産', '流動負債', '固定負債'])
const MOTOIRE = '元入金'

interface SideTotals {
  debit: number
  credit: number
}

/**
 * 当期の (勘定科目, 補助科目) 別の借貸合計（開始残高＋confirmed 仕訳）。補助科目なし分は null キー。
 * accountAggregates と同じ入力（開始残高＋confirmed 仕訳）なので、科目内の補助別残高の合計は
 * 科目残高と常に一致する（＝繰越後の BS 合計は科目レベル繰越と不変）。
 */
function subAccountAggregates(db: DataDb, fiscalYearId: number): Map<number, Map<number | null, SideTotals>> {
  const agg = new Map<number, Map<number | null, SideTotals>>()
  const bump = (accountId: number, subAccountId: number | null, side: string, amount: number) => {
    let subs = agg.get(accountId)
    if (!subs) {
      subs = new Map()
      agg.set(accountId, subs)
    }
    const a = subs.get(subAccountId) ?? { debit: 0, credit: 0 }
    if (side === 'debit') a.debit += amount
    else a.credit += amount
    subs.set(subAccountId, a)
  }
  for (const ob of db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, fiscalYearId)).all()) {
    bump(ob.accountId, ob.subAccountId, ob.side, ob.amount)
  }
  const lines = db
    .select({ accountId: journalLines.accountId, subAccountId: journalLines.subAccountId, side: journalLines.side, amount: journalLines.amount })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(eq(journalEntries.fiscalYearId, fiscalYearId), eq(journalEntries.status, 'confirmed')))
    .all()
  for (const l of lines) bump(l.accountId, l.subAccountId, l.side, l.amount)
  return agg
}

/** 翌期（当期末日の翌日〜その暦年末12/31）の日付。個人は暦年原則。 */
function nextYearDates(endDate: string): { start: string; end: string } {
  const d = new Date(`${endDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  const start = d.toISOString().slice(0, 10)
  return { start, end: `${start.slice(0, 4)}-12-31` }
}

/**
 * 当期（open 年度の日付範囲）に未処理のまま残っている取込明細を数える（read-only）。
 *
 * 繰越そのものは止めない。`ignored` は利用者が意図して残す状態であり、阻却条件にすると繰越が詰まる。
 * ただし繰越を跨ぐと会計期間ゲート（[[journal]]）でこれらは仕訳化できなくなるため、確定の前に知らせる。
 */
export function rolloverPrecheck(db: DataDb, fiscalYearId: number): RolloverPrecheck {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fiscalYearId} が見つかりません`)
  const countByStatus = (status: string): number =>
    db
      .select({ c: sql<number>`count(*)` })
      .from(rawTransactions)
      .where(and(eq(rawTransactions.status, status), gte(rawTransactions.txnDate, fy.startDate), lte(rawTransactions.txnDate, fy.endDate)))
      .all()[0].c
  return { unprocessedRaw: { pending: countByStatus('pending'), ignored: countByStatus('ignored') } }
}

/** 当期(open)を締めて翌期へ繰越す。冪等: 翌期が仕訳ゼロなら opening_balances を洗い替えで再実行可。 */
export function executeRollover(db: DataDb, currentFyId: number): RolloverResult {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, currentFyId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${currentFyId} が見つかりません`)
  if (fy.status !== 'open') throw new Error('会計年度が open ではありません（既に繰越済みの可能性）')

  // 最重要ガード: 当期の貸借不一致を翌期に持ち越さない。
  const bs = balanceSheet(db, currentFyId)
  if (!bs.balanced) throw new Error('当期の貸借が一致していないため繰越できません（開始残高・仕訳を確認してください）')

  const nextMotoire = previewCapitalTransfer(db, currentFyId).nextMotoire
  const motoireId = accountIdByName(db, MOTOIRE)

  // 資産・負債科目の期末残高（資本セクションは除外＝事業主貸/借はリセット、元入金は nextMotoire）。
  // 補助科目別の内訳で繰越す（売掛金の取引先別など補助元帳の残高を翌期に引き継ぐ。補助なし分は null 行）。
  const subAgg = subAccountAggregates(db, currentFyId)
  const assetLiabilityRows: RolloverAccountRow[] = accountAggregates(db, currentFyId)
    .filter((r) => r.reportType === 'BS' && ASSET_LIABILITY_SECTIONS.has(r.section))
    .flatMap((r) =>
      [...(subAgg.get(r.accountId) ?? new Map<number | null, SideTotals>())].map(([subAccountId, a]) => ({
        accountId: r.accountId,
        subAccountId,
        normalBalance: r.normalBalance,
        balance: accountBalance(r.normalBalance, yen(a.debit), yen(a.credit)),
      })),
    )

  const candidates = rolloverOpeningBalances({ assetLiabilityRows, motoireAccountId: motoireId, nextMotoire })
  const dates = nextYearDates(fy.endDate)
  const now = new Date().toISOString()

  return db.transaction((tx) => {
    let nextFy = tx.select().from(fiscalYears).where(eq(fiscalYears.startDate, dates.start)).all()[0]
    if (nextFy) {
      const existing = tx.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.fiscalYearId, nextFy.id)).all()
      if (existing.length > 0) throw new Error('翌期に仕訳が存在するため繰越できません')
    } else {
      nextFy = tx.insert(fiscalYears).values({ startDate: dates.start, endDate: dates.end, status: 'open', createdAt: now }).returning().all()[0]
    }
    // 翌期 opening_balances を洗い替え（再実行の冪等性）。
    tx.delete(openingBalances).where(eq(openingBalances.fiscalYearId, nextFy.id)).run()
    for (const c of candidates) {
      tx.insert(openingBalances).values({ fiscalYearId: nextFy.id, accountId: c.accountId, subAccountId: c.subAccountId, side: c.side, amount: c.amount }).run()
    }
    tx.update(fiscalYears).set({ status: 'closed' }).where(eq(fiscalYears.id, currentFyId)).run()
    return { nextFiscalYearId: nextFy.id, nextMotoire, generated: candidates.length }
  })
}

/**
 * 年度繰越の取消。安全条件＝対象が closed かつ 翌期FY（あれば）が仕訳ゼロ件。
 * 満たせば翌期FYと翌期 opening_balances を削除し、対象を open に戻す（原子的）。
 */
export function reopenFiscalYear(db: DataDb, fyId: number): void {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fyId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fyId} が見つかりません`)
  if (fy.status !== 'closed') throw new Error('closed の会計年度のみ取消できます')
  const nextFy = db
    .select()
    .from(fiscalYears)
    .where(gt(fiscalYears.startDate, fy.startDate))
    .orderBy(asc(fiscalYears.startDate))
    .all()[0]

  db.transaction((tx) => {
    if (nextFy) {
      const existing = tx.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.fiscalYearId, nextFy.id)).all()
      if (existing.length > 0) throw new Error('翌期に仕訳があるため取消できません（管理者対応が必要です）')
      tx.delete(openingBalances).where(eq(openingBalances.fiscalYearId, nextFy.id)).run()
      tx.delete(fiscalYears).where(eq(fiscalYears.id, nextFy.id)).run()
    }
    tx.update(fiscalYears).set({ status: 'open' }).where(eq(fiscalYears.id, fyId)).run()
  })
}
