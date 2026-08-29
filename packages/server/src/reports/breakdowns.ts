import type { DepreciationRow, DepreciationBreakdown, BreakdownRow, ExpenseBreakdown, MonthlySalesPurchaseRow, MonthlySalesPurchase, ReserveAllowanceCalc } from '@kanean/shared'
export type { DepreciationRow, DepreciationBreakdown, BreakdownRow, ExpenseBreakdown, MonthlySalesPurchaseRow, MonthlySalesPurchase, ReserveAllowanceCalc }
import { and, eq, inArray } from 'drizzle-orm'
import { yen, applyRate } from '@kanean/shared'
import type { DataDb } from '../db/router.js'
import {
  accounts,
  counterparties,
  depreciationEntries,
  fixedAssets,
  journalEntries,
  journalLines,
  statementItems,
  subAccounts,
} from '../db/data/schema.js'
import { accountAggregates } from './reports.js'

/**
 * 青色申告決算書の内訳ページ（form-mapping §1.3〜§1.7）。各内訳の合計は損益計算書の
 * 対応する経費行／売上に一致する（連動恒等式・テストで担保）。すべて confirmed 仕訳と
 * depreciation_entries の read 集計（I/O は read のみ）。
 *
 * 連動:
 *   減価償却 必要経費算入額合計 == 損益 ⑱（AOIRO.PL.EXP_DEP）
 *   給料賃金内訳 合計 == 損益 ⑳（EXP_SALARY） / 地代家賃内訳 合計 == 損益 ㉓（EXP_RENT）
 *   専従者給与内訳 合計 == 損益 専従者（SENJU）
 *   月別 売上年計 == ①（SALES） / 仕入年計 == ③（PURCHASE）
 *
 * 注:
 *   - PL勘定は期首残高ゼロ前提（confirmed 仕訳のみ集計し opening_balances は含めない）。
 *   - 地代家賃内訳は **必要経費算入額（家事按分後）** のみ。家事分は事業主貸へ振られ地代家賃勘定に
 *     現れないため、§1.5 様式の「本年中の賃借料（総額）」欄は未対応（按分元データからの再構成は後続）。
 *   - 給料賃金内訳は退職給与も含む（同一決算書科目）。様式§1.4の退職給与別欄分離は後続。
 */

/** line_code に属する勘定科目 id 群（決算書科目 statement_items 経由）。 */
function accountIdsByLineCode(db: DataDb, lineCode: string): number[] {
  return db
    .select({ id: accounts.id })
    .from(accounts)
    .innerJoin(statementItems, eq(accounts.statementItemId, statementItems.id))
    .where(eq(statementItems.statementLineCode, lineCode))
    .all()
    .map((r) => r.id)
}

/** 当該年度 confirmed 仕訳の明細（指定勘定群）。 */
function confirmedLines(db: DataDb, fiscalYearId: number, accountIds: number[]) {
  if (accountIds.length === 0) return []
  return db
    .select({
      accountId: journalLines.accountId,
      subAccountId: journalLines.subAccountId,
      counterpartyId: journalLines.counterpartyId,
      side: journalLines.side,
      amount: journalLines.amount,
      entryDate: journalEntries.entryDate,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.fiscalYearId, fiscalYearId),
        eq(journalEntries.status, 'confirmed'),
        inArray(journalLines.accountId, accountIds),
      ),
    )
    .all()
}

// --- 減価償却費の計算（§1.3・青色決算書3ページ目様式） ----------------------

/**
 * 減価償却費の計算（§1.3）。当該年度に計上された depreciation_entries を固定資産と結合する。
 * postDepreciation は include_in_blue_return を問わず active 資産を計上するため、内訳は
 * depreciation_entries（=実際に⑱へ算入された記録）基準とし、businessAmountTotal == ⑱ を保証する。
 */
export function depreciationBreakdown(db: DataDb, fiscalYearId: number): DepreciationBreakdown {
  const rows = db
    .select({
      fixedAssetId: fixedAssets.id,
      managementNo: fixedAssets.managementNo,
      name: fixedAssets.name,
      acquiredDate: fixedAssets.acquiredDate,
      acquisitionCost: fixedAssets.acquisitionCost,
      quantityOrArea: fixedAssets.quantityOrArea,
      depreciationMethod: fixedAssets.depreciationMethod,
      usefulLife: fixedAssets.usefulLife,
      depreciationRate: fixedAssets.depreciationRate,
      businessUseRatio: fixedAssets.businessUseRatio,
      specialDepreciation: fixedAssets.specialDepreciationAmount,
      openingBookValue: depreciationEntries.openingBookValue,
      depreciationAmount: depreciationEntries.depreciationAmount,
      businessAmount: depreciationEntries.businessAmount,
      closingBookValue: depreciationEntries.closingBookValue,
    })
    .from(depreciationEntries)
    .innerJoin(fixedAssets, eq(depreciationEntries.fixedAssetId, fixedAssets.id))
    .where(eq(depreciationEntries.fiscalYearId, fiscalYearId))
    .all()
    .sort((a, b) => (a.managementNo ?? '').localeCompare(b.managementNo ?? '') || a.fixedAssetId - b.fixedAssetId)
    .map((r) => ({
      fixedAssetId: r.fixedAssetId,
      managementNo: r.managementNo,
      name: r.name,
      quantityOrArea: r.quantityOrArea,
      acquiredDate: r.acquiredDate,
      acquisitionCost: yen(r.acquisitionCost),
      depreciationMethod: r.depreciationMethod,
      usefulLife: r.usefulLife,
      depreciationRate: r.depreciationRate,
      openingBookValue: yen(r.openingBookValue),
      depreciationAmount: yen(r.depreciationAmount),
      businessUseRatio: r.businessUseRatio,
      businessAmount: yen(r.businessAmount),
      closingBookValue: yen(r.closingBookValue),
      specialDepreciation: r.specialDepreciation == null ? null : yen(r.specialDepreciation),
    }))
  return {
    rows,
    depreciationTotal: yen(rows.reduce((s, r) => s + r.depreciationAmount, 0)),
    businessAmountTotal: yen(rows.reduce((s, r) => s + r.businessAmount, 0)),
  }
}

// --- 経費の内訳（給料賃金§1.4 / 地代家賃§1.5 / 専従者給与§1.6） --------------

/** 費用勘定（借方科目）の明細を キー（補助科目/取引先）別に集計。amount = 借方−貸方。 */
function expenseBreakdownBy(
  db: DataDb,
  fiscalYearId: number,
  lineCode: string,
  keyOf: (l: { subAccountId: number | null; counterpartyId: number | null }) => number | null,
  nameOf: (db: DataDb, key: number | null) => string,
): ExpenseBreakdown {
  const lines = confirmedLines(db, fiscalYearId, accountIdsByLineCode(db, lineCode))
  const byKey = new Map<number | null, number>()
  for (const l of lines) {
    const k = keyOf(l)
    const v = l.side === 'debit' ? l.amount : -l.amount
    byKey.set(k, (byKey.get(k) ?? 0) + v)
  }
  const rows = [...byKey.entries()]
    .map(([key, sum]) => ({ key, name: nameOf(db, key), amount: yen(sum) }))
    .sort((a, b) => (a.key ?? Number.MAX_SAFE_INTEGER) - (b.key ?? Number.MAX_SAFE_INTEGER))
  return { rows, total: yen(rows.reduce((s, r) => s + r.amount, 0)) }
}

function subAccountName(db: DataDb, id: number | null): string {
  if (id == null) return '（補助科目なし）'
  return db.select({ name: subAccounts.name }).from(subAccounts).where(eq(subAccounts.id, id)).all()[0]?.name ?? `補助${id}`
}
function counterpartyName(db: DataDb, id: number | null): string {
  if (id == null) return '（取引先なし）'
  return db.select({ name: counterparties.name }).from(counterparties).where(eq(counterparties.id, id)).all()[0]?.name ?? `取引先${id}`
}

/** 給料賃金の内訳（§1.4・従業員＝補助科目別）。合計 == 損益 ⑳。 */
export function salaryBreakdown(db: DataDb, fiscalYearId: number): ExpenseBreakdown {
  return expenseBreakdownBy(db, fiscalYearId, 'AOIRO.PL.EXP_SALARY', (l) => l.subAccountId, subAccountName)
}
/** 地代家賃の内訳（§1.5・支払先＝取引先別。家事按分後の計上額）。合計 == 損益 ㉓。 */
export function rentBreakdown(db: DataDb, fiscalYearId: number): ExpenseBreakdown {
  return expenseBreakdownBy(db, fiscalYearId, 'AOIRO.PL.EXP_RENT', (l) => l.counterpartyId, counterpartyName)
}
/** 専従者給与の内訳（§1.6・専従者＝補助科目別）。合計 == 損益 専従者。 */
export function senjuBreakdown(db: DataDb, fiscalYearId: number): ExpenseBreakdown {
  return expenseBreakdownBy(db, fiscalYearId, 'AOIRO.PL.SENJU', (l) => l.subAccountId, subAccountName)
}

// --- 月別の売上(収入)金額及び仕入金額（§1.7） --------------------------------

/**
 * 月別 売上/仕入（§1.7）。個人は暦年なので月は 1〜12 固定。
 * 売上は収益（貸方−借方）、仕入は費用（借方−貸方）の純額で集計（値引・返品も符号反映）。
 * 年計は 売上==① / 仕入==③ に一致する。
 */
export function monthlySalesPurchase(db: DataDb, fiscalYearId: number): MonthlySalesPurchase {
  const salesIds = accountIdsByLineCode(db, 'AOIRO.PL.SALES')
  const purchaseIds = accountIdsByLineCode(db, 'AOIRO.PL.PURCHASE')
  const sales = new Array<number>(12).fill(0)
  const purchases = new Array<number>(12).fill(0)

  for (const l of confirmedLines(db, fiscalYearId, salesIds)) {
    const m = Number(l.entryDate.slice(5, 7))
    if (m >= 1 && m <= 12) sales[m - 1] += l.side === 'credit' ? l.amount : -l.amount // 収益＝貸方−借方
  }
  for (const l of confirmedLines(db, fiscalYearId, purchaseIds)) {
    const m = Number(l.entryDate.slice(5, 7))
    if (m >= 1 && m <= 12) purchases[m - 1] += l.side === 'debit' ? l.amount : -l.amount // 費用＝借方−貸方
  }

  const rows: MonthlySalesPurchaseRow[] = Array.from({ length: 12 }, (_v, i) => ({
    month: i + 1,
    sales: yen(sales[i]),
    purchases: yen(purchases[i]),
  }))
  return {
    rows,
    salesTotal: yen(sales.reduce((s, v) => s + v, 0)),
    purchasesTotal: yen(purchases.reduce((s, v) => s + v, 0)),
  }
}

// --- 貸倒引当金繰入額の計算（§1.8・一括評価のみ） ----------------------------

/** 一括評価の対象とする標準債権（期末残高で②に算入）。個別評価・貸付金等は対象外。 */
const LUMP_RECEIVABLE_ACCOUNTS = ['売掛金', '受取手形']
/** 一括評価の繰入率（一般 5.5%。金融業 3.3% は未対応）。計算は整数 num/den（55/1000）で行い、本値は表示用。 */
const LUMP_RESERVE_RATE = 0.055

/**
 * 貸倒引当金繰入額の計算（§1.8）。⑤は帳簿の貸倒引当金繰入（RESERVE_IN）実績を正とし、
 * ②は期末の一括評価対象債権（売掛金＋受取手形）、③＝②×5.5%（限度額）を導出する。
 * ①個別評価は未モデル化（0）。⑤＝0 の場合は様式側で表全体を空欄にする。
 */
export function reserveAllowanceCalc(db: DataDb, fiscalYearId: number): ReserveAllowanceCalc {
  const rows = accountAggregates(db, fiscalYearId)
  const grossReceivables = rows
    .filter((r) => r.reportType === 'BS' && LUMP_RECEIVABLE_ACCOUNTS.includes(r.accountName))
    .reduce((s, r) => s + r.balance, 0)
  const total = rows
    .filter((r) => r.lineCode === 'AOIRO.PL.RESERVE_IN')
    .reduce((s, r) => s + r.balance, 0)
  const individual = 0
  return {
    individual: yen(individual),
    grossReceivables: yen(grossReceivables),
    limit: applyRate(yen(grossReceivables), 55, 1000, 'floor'),
    lumpReserve: yen(total - individual),
    total: yen(total),
    rate: LUMP_RESERVE_RATE,
  }
}
