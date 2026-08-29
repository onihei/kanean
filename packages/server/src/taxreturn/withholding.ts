import type { IncomeDetailRow } from '@kanean/shared'
export type { IncomeDetailRow }
import { and, eq, inArray } from 'drizzle-orm'
import { type Yen, yen } from '@kanean/shared'
import { rewardWithholding } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { accountCategories, accounts, counterparties, journalEntries, journalLines, statementItems, subAccounts } from '../db/data/schema.js'
import { requireAccountIdByName as accountIdByName } from '../db/lookups.js'
import { createManualEntry, type ManualEntryLineInput } from '../journal/manualEntry.js'

/**
 * 報酬・料金の源泉徴収（accounting-spec §5）。
 * - postRewardSale: 源泉徴収された報酬売上の複合仕訳を起票（createManualEntry 再利用）。
 *     借) 普通預金 (税込 − 源泉)   借) 事業主貸(源泉所得税) 源泉   /  貸) 売上 (税込)
 * - withholdingDetail: 確定申告書 第二表「所得の内訳」（支払者別 収入金額・源泉徴収税額）。
 *   income-tax 第一表の源泉徴収税額（事業主貸/源泉所得税 集計）の内訳に対応。
 *
 * legalRisk:high — 源泉税率・基礎（本体/税込）・申告転記は税理士サインオフ対象。
 */

const DEPOSIT = '普通預金'
const SALE = '売上高'
const OWNER_DRAW = '事業主貸'
const WITHHOLDING_SUB = '源泉所得税'
const SALES_SECTION = '売上'

function withholdingSubId(db: DataDb, ownerDrawId: number): number {
  const s = db
    .select({ id: subAccounts.id })
    .from(subAccounts)
    .where(and(eq(subAccounts.accountId, ownerDrawId), eq(subAccounts.name, WITHHOLDING_SUB)))
    .all()[0]
  if (!s) throw new Error(`補助科目 "${WITHHOLDING_SUB}" が見つかりません`)
  return s.id
}

export interface PostRewardSaleInput {
  entryDate: string
  counterpartyId?: number | null
  /** 売上計上額（税込経理の税込）。 */
  gross: number
  /** 源泉計算の基礎（消費税区分明記なら本体、なければ税込）。 */
  withholdingBase: number
  saleAccountId?: number
  depositAccountId?: number
  taxCategoryId?: number | null
  description?: string | null
}

export interface PostRewardSaleResult {
  entryId: number
  withholding: Yen
  deposit: Yen
}

/** 源泉徴収された報酬売上を複合仕訳で起票する（confirmed）。 */
export function postRewardSale(db: DataDb, fiscalYearId: number, input: PostRewardSaleInput): PostRewardSaleResult {
  if (!Number.isSafeInteger(input.gross) || input.gross <= 0) throw new Error('売上額は正の整数（円）で指定してください')
  if (!Number.isSafeInteger(input.withholdingBase) || input.withholdingBase < 0) throw new Error('源泉計算の基礎は0以上の整数（円）で指定してください')
  // 源泉計算の基礎は 本体(≤税込) または 税込(=gross)。税込を超える入力は不整合（源泉控除の過大計上を防ぐ）。
  if (input.withholdingBase > input.gross) throw new Error('源泉計算の基礎は売上額（税込）以下である必要があります')

  // base ≤ gross かつ源泉率<100% なので deposit は常に正。
  const withholding = rewardWithholding(yen(input.withholdingBase))
  const deposit = input.gross - withholding

  const depositId = input.depositAccountId ?? accountIdByName(db, DEPOSIT)
  const saleId = input.saleAccountId ?? accountIdByName(db, SALE)
  const ownerDrawId = accountIdByName(db, OWNER_DRAW)
  const subId = withholdingSubId(db, ownerDrawId)
  const cp = input.counterpartyId ?? null

  const allLines: ManualEntryLineInput[] = [
    { side: 'debit', accountId: depositId, amount: deposit, counterpartyId: cp },
    { side: 'debit', accountId: ownerDrawId, subAccountId: subId, amount: withholding, counterpartyId: cp },
    { side: 'credit', accountId: saleId, amount: input.gross, counterpartyId: cp, taxCategoryId: input.taxCategoryId ?? null },
  ]
  const lines = allLines.filter((l) => l.amount > 0)

  const entryId = createManualEntry(db, {
    fiscalYearId,
    entryDate: input.entryDate,
    description: input.description ?? '報酬売上（源泉徴収）',
    status: 'confirmed',
    lines,
  })
  return { entryId, withholding, deposit: yen(deposit) }
}

/** 確定申告書 第二表「所得の内訳」: 事業主貸(源泉所得税) を支払者別に集計し、同一仕訳の売上を収入金額とする。 */
export function withholdingDetail(db: DataDb, fiscalYearId: number): IncomeDetailRow[] {
  const ownerDrawId = accountIdByName(db, OWNER_DRAW)
  const sub = db
    .select({ id: subAccounts.id })
    .from(subAccounts)
    .where(and(eq(subAccounts.accountId, ownerDrawId), eq(subAccounts.name, WITHHOLDING_SUB)))
    .all()[0]
  if (!sub) return []

  // 源泉所得税 行（confirmed・当年度）。
  const whLines = db
    .select({ entryId: journalLines.entryId, side: journalLines.side, amount: journalLines.amount, counterpartyId: journalLines.counterpartyId })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.fiscalYearId, fiscalYearId),
        eq(journalEntries.status, 'confirmed'),
        eq(journalLines.accountId, ownerDrawId),
        eq(journalLines.subAccountId, sub.id),
      ),
    )
    .all()
  if (whLines.length === 0) return []

  // 仕訳ごとに源泉額（借方−貸方）と支払者を集約。
  const whByEntry = new Map<number, { wh: number; cp: number | null }>()
  for (const l of whLines) {
    const cur = whByEntry.get(l.entryId) ?? { wh: 0, cp: l.counterpartyId }
    cur.wh += l.side === 'debit' ? l.amount : -l.amount
    if (cur.cp == null && l.counterpartyId != null) cur.cp = l.counterpartyId
    whByEntry.set(l.entryId, cur)
  }

  // 同一仕訳の売上（収入金額）を集計。
  const saleAccountIds = db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(statementItems, eq(accounts.statementItemId, statementItems.id))
    .innerJoin(accountCategories, eq(statementItems.categoryId, accountCategories.id))
    .where(eq(accountCategories.section, SALES_SECTION))
    .all()
    .map((a) => a.id)
  const entryIds = [...whByEntry.keys()]
  const saleByEntry = new Map<number, number>()
  if (saleAccountIds.length > 0) {
    const saleLines = db
      .select({ entryId: journalLines.entryId, side: journalLines.side, amount: journalLines.amount })
      .from(journalLines)
      .where(and(inArray(journalLines.entryId, entryIds), inArray(journalLines.accountId, saleAccountIds)))
      .all()
    for (const l of saleLines) {
      saleByEntry.set(l.entryId, (saleByEntry.get(l.entryId) ?? 0) + (l.side === 'credit' ? l.amount : -l.amount))
    }
  }

  // 支払者別に集約。
  const agg = new Map<number | null, { revenue: number; withholding: number }>()
  for (const [entryId, { wh, cp }] of whByEntry) {
    const a = agg.get(cp) ?? { revenue: 0, withholding: 0 }
    a.withholding += wh
    a.revenue += saleByEntry.get(entryId) ?? 0
    agg.set(cp, a)
  }

  const names = new Map(db.select({ id: counterparties.id, name: counterparties.name }).from(counterparties).all().map((c) => [c.id, c.name]))
  return [...agg.entries()]
    .map(([cp, v]) => ({
      counterpartyId: cp,
      payerName: cp == null ? '（支払者未設定）' : (names.get(cp) ?? `取引先${cp}`),
      revenue: yen(v.revenue),
      withholding: yen(v.withholding),
    }))
    .sort((a, b) => b.withholding - a.withholding)
}
