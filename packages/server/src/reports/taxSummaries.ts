import { and, eq } from 'drizzle-orm'
import {
  type TaxExcludedPlRow,
  type TaxExcludedPlSection,
  type TaxExcludedProfitAndLoss,
  type TaxSalesBase,
  type TaxSalesRow,
  type TaxSalesSummary,
  yen,
} from '@kanean/shared'

export type { TaxExcludedPlRow, TaxExcludedPlSection, TaxExcludedProfitAndLoss, TaxSalesBase, TaxSalesRow, TaxSalesSummary }
import { accountBalance, type Side } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { businessSettings, journalEntries, journalLines, taxCategories } from '../db/data/schema.js'
import { accountMetaById } from './base.js'

/** 消費税まわりの集計（税区分別 課税売上・税抜損益計算書）。reports.ts（B3=#116）から分割。 */

// --- 税区分別 課税売上集計（消費税申告の入力源 / roadmap Phase2） -----------


/**
 * 税区分別 課税売上集計（roadmap Phase2 / accounting-spec §3 入力源）。
 * confirmed 仕訳の「課税・売上」税区分の明細を税区分ごとに集計し、税率別の税抜課税標準額
 * （通常売上 adjustment=none）を出す。simplifiedTax の base 入力に対応。
 * ⚠️ 納付税額の算定・申告書様式は Phase4（税理士サインオフ必須）。本表は集計のみ。
 */
export function taxSalesSummary(db: DataDb, fiscalYearId: number): TaxSalesSummary {
  const lines = db
    .select({
      taxCategoryId: taxCategories.id,
      code: taxCategories.code,
      label: taxCategories.label,
      rate: taxCategories.rate,
      simplifiedCategory: taxCategories.simplifiedCategory,
      adjustment: taxCategories.adjustment,
      amount: journalLines.amount,
      taxAmount: journalLines.taxAmount,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(taxCategories, eq(journalLines.taxCategoryId, taxCategories.id))
    .where(
      and(
        eq(journalEntries.fiscalYearId, fiscalYearId),
        eq(journalEntries.status, 'confirmed'),
        eq(taxCategories.taxability, 'taxable'),
        eq(taxCategories.direction, 'sale'),
      ),
    )
    .all()

  // 税区分ごとに集計。
  const byCat = new Map<number, TaxSalesRow>()
  for (const l of lines) {
    const tax = l.taxAmount ?? 0
    const row = byCat.get(l.taxCategoryId) ?? {
      taxCategoryId: l.taxCategoryId,
      code: l.code,
      label: l.label,
      rate: l.rate,
      simplifiedCategory: l.simplifiedCategory,
      adjustment: l.adjustment,
      grossAmount: yen(0),
      netAmount: yen(0),
      taxAmount: yen(0),
      count: 0,
    }
    row.grossAmount = yen(row.grossAmount + l.amount)
    row.taxAmount = yen(row.taxAmount + tax)
    row.netAmount = yen(row.netAmount + (l.amount - tax))
    row.count += 1
    byCat.set(l.taxCategoryId, row)
  }

  // 税率降順・通常→返還→貸倒の順。
  const adjOrder: Record<string, number> = { none: 0, return: 1, bad_debt: 2 }
  const rows = [...byCat.values()].sort(
    (a, b) => (b.rate ?? 0) - (a.rate ?? 0) || (adjOrder[a.adjustment] ?? 9) - (adjOrder[b.adjustment] ?? 9),
  )

  // 税率別の税抜課税標準額（通常売上のみ。返還・貸倒は控除側＝base に含めない）。
  // net は行ごとの税抜（税込−税額）の総和。税額は確定時に行単位で端数処理済みのため、
  // 税込経理の「行単位で税額を保持する」方針に一致する（集計レベルの再丸めはしない）。
  const baseMap = new Map<number, { net: number; tax: number }>()
  for (const r of rows) {
    if (r.adjustment !== 'none' || r.rate == null) continue
    const b = baseMap.get(r.rate) ?? { net: 0, tax: 0 }
    b.net += r.netAmount
    b.tax += r.taxAmount
    baseMap.set(r.rate, b)
  }
  const baseByRate: TaxSalesBase[] = [...baseMap.entries()]
    .sort((a, b) => b[0] - a[0])
    .map(([rate, b]) => ({ rate, net: yen(b.net), tax: yen(b.tax) }))

  // 合計は「正味の課税売上」。返還等対価・貸倒れは控除側なので減算する（none=+1, それ以外=-1）。
  const sign = (adjustment: string) => (adjustment === 'none' ? 1 : -1)
  return {
    rows,
    baseByRate,
    totalGross: yen(rows.reduce((s, r) => s + sign(r.adjustment) * r.grossAmount, 0)),
    totalNet: yen(rows.reduce((s, r) => s + sign(r.adjustment) * r.netAmount, 0)),
    totalTax: yen(rows.reduce((s, r) => s + sign(r.adjustment) * r.taxAmount, 0)),
  }
}

// --- 税抜損益計算書（消費税申告の入力源 / roadmap Phase2） -------------------


/**
 * 税抜損益計算書（roadmap Phase2 / 消費税申告の入力源）。
 * 税込経理で記帳された confirmed 仕訳の PL 科目について、行単位の内税（tax_amount）を
 * 控除した「本体（税抜）」を科目・section ごとに集計する。税込（gross）・内税（tax）も併記。
 * - netIncomeGross は既存 profitAndLoss の当期所得に一致（税込ベース）。
 * - 開始残高は PL に存在しないため発生高のみで算出。
 * ⚠️ 納付税額の算定・申告様式は Phase4（税理士サインオフ必須）。本表は集計のみ。
 */
export function taxExcludedProfitAndLoss(db: DataDb, fiscalYearId: number): TaxExcludedProfitAndLoss {
  const bs = db.select().from(businessSettings).all()[0]
  const accountingMethod = bs?.accountingMethod ?? 'tax_included'

  const lines = db
    .select({
      accountId: journalLines.accountId,
      side: journalLines.side,
      amount: journalLines.amount,
      taxAmount: journalLines.taxAmount,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(eq(journalEntries.fiscalYearId, fiscalYearId), eq(journalEntries.status, 'confirmed')))
    .all()

  // 科目ごとに 借/貸 の税込合計と内税合計を集計。
  const agg = new Map<number, { gd: number; gc: number; td: number; tc: number }>()
  for (const l of lines) {
    const a = agg.get(l.accountId) ?? { gd: 0, gc: 0, td: 0, tc: 0 }
    const tax = l.taxAmount ?? 0
    if (l.side === 'debit') {
      a.gd += l.amount
      a.td += tax
    } else {
      a.gc += l.amount
      a.tc += tax
    }
    agg.set(l.accountId, a)
  }

  const metaById = accountMetaById(db)
  const rows: (TaxExcludedPlRow & { sortOrder: number })[] = []
  for (const [accountId, a] of agg) {
    const m = metaById.get(accountId)
    if (!m || m.reportType !== 'PL') continue
    const normal = m.normalBalance as Side
    const gross = accountBalance(normal, yen(a.gd), yen(a.gc))
    const net = accountBalance(normal, yen(a.gd - a.td), yen(a.gc - a.tc))
    rows.push({
      accountId,
      accountName: m.accountName,
      section: m.section,
      normalBalance: normal,
      gross,
      tax: yen(gross - net),
      net,
      sortOrder: m.sortOrder,
    })
  }
  rows.sort((a, b) => a.sortOrder - b.sortOrder || a.accountId - b.accountId)

  const mkSection = (section: string): TaxExcludedPlSection => {
    const secRows = rows.filter((r) => r.section === section)
    return {
      section,
      rows: secRows.map(({ sortOrder: _sortOrder, ...r }) => r),
      gross: yen(secRows.reduce((s, r) => s + r.gross, 0)),
      tax: yen(secRows.reduce((s, r) => s + r.tax, 0)),
      net: yen(secRows.reduce((s, r) => s + r.net, 0)),
    }
  }
  const sales = mkSection('売上')
  const costOfSales = mkSection('売上原価')
  const expenses = mkSection('経費')

  return {
    accountingMethod,
    sales,
    costOfSales,
    expenses,
    grossProfitNet: yen(sales.net - costOfSales.net),
    netIncomeNet: yen(yen(sales.net - costOfSales.net) - expenses.net),
    grossProfitGross: yen(sales.gross - costOfSales.gross),
    netIncomeGross: yen(yen(sales.gross - costOfSales.gross) - expenses.gross),
  }
}

