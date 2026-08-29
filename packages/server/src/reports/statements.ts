import { and, eq } from 'drizzle-orm'
import {
  type BalanceSheet,
  type BsSectionView,
  type MonthlyTrend,
  type PlSectionView,
  type ProfitAndLoss,
  type TrendRow,
  type TrialBalance,
  type Yen, yen,
} from '@kanean/shared'

export type { BalanceSheet, BsSectionView, MonthlyTrend, PlSectionView, ProfitAndLoss, TrendRow, TrialBalance }
import { accountBalance, type Side } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { fiscalYears, journalEntries, journalLines } from '../db/data/schema.js'
import {
  accountAggregates,
  accountMetaById,
  assertValidPeriod,
  type AccountBalanceRow,
  type Period,
  type ReportType,
} from './base.js'

/** 財務諸表（試算表・損益計算書・貸借対照表・月次推移表）。reports.ts（B3=#116）から分割。 */

// --- 試算表 ----------------------------------------------------------------


/**
 * 合計残高試算表（accounting-spec §10）。
 * period 指定で期間/月次試算表（from あり＝期間発生高、to のみ＝期末時点累計）。
 */
export function trialBalance(db: DataDb, fiscalYearId: number, period?: Period): TrialBalance {
  assertValidPeriod(period)
  const rows = accountAggregates(db, fiscalYearId, period)
  const totalDebit = yen(rows.reduce((s, r) => s + r.totalDebit, 0))
  const totalCredit = yen(rows.reduce((s, r) => s + r.totalCredit, 0))
  return { rows, totalDebit, totalCredit, balanced: totalDebit === totalCredit }
}

// --- 損益計算書 ------------------------------------------------------------


/** PL section の自然側（収益＝貸方 / 費用＝借方）。売上・その他（繰戻額等）は credit、売上原価・経費は debit。 */
const PL_CREDIT_SECTIONS = new Set(['売上', 'その他'])
export function plSectionNaturalSide(section: string): Side {
  return PL_CREDIT_SECTIONS.has(section) ? 'credit' : 'debit'
}

/**
 * PL行を section の自然側に正規化した符号付き残高。**評価勘定/控除（section 自然側と逆の科目）は
 * 符号反転して相殺**する（売上の「売上値引・返品」/売上原価の「仕入値引・返品」はマイナス計上）。
 * 期末商品棚卸高は借方科目（自然側＝借方）だが決算整理で貸方計上され balance が負になるため、
 * 反転せずそのまま加算され差引原価から正しく控除される。
 * 集計の単一の正（plSection と blueReturnStatement が共用し符号規約のドリフトを防ぐ）。
 */
export function plSignedBalance(row: AccountBalanceRow): Yen {
  return yen(row.normalBalance === plSectionNaturalSide(row.section) ? row.balance : -row.balance)
}

/** PL section 合計（評価勘定/控除は plSignedBalance で相殺・bsSections と同じ評価勘定相殺）。 */
function plSection(rows: AccountBalanceRow[], section: string): PlSectionView {
  const sectionRows = rows.filter((r) => r.section === section)
  const total = yen(sectionRows.reduce((s, r) => s + plSignedBalance(r), 0))
  return { section, rows: sectionRows, total }
}

/**
 * 損益計算書（PL科目を section で集計し当期所得を算出）。
 * 控除前所得金額㊸ = 売上総利益 − 経費 + 繰戻額等（その他）。
 * 繰戻額等（貸倒引当金戻入）は収益側で所得に加算する（様式 ㊸ の構成要素・form-mapping §1.1）。
 */
export function profitAndLoss(db: DataDb, fiscalYearId: number): ProfitAndLoss {
  const pl = accountAggregates(db, fiscalYearId).filter((r) => r.reportType === 'PL')
  const sales = plSection(pl, '売上')
  const costOfSales = plSection(pl, '売上原価')
  const expenses = plSection(pl, '経費')
  const otherIncome = plSection(pl, 'その他')
  const grossProfit = yen(sales.total - costOfSales.total)
  const netIncome = yen(grossProfit - expenses.total + otherIncome.total)
  return { sales, costOfSales, expenses, otherIncome, grossProfit, netIncome }
}

// --- 貸借対照表 ------------------------------------------------------------


const ASSET_SECTIONS = ['流動資産', '固定資産', '繰延資産']
const LIABILITY_SECTIONS = ['流動負債', '固定負債']
const EQUITY_SECTIONS = ['資本']

/**
 * section ごとの合計。**評価勘定（セクションの自然側と逆の科目）は控除側として相殺**する。
 * 例: 固定資産（自然側＝借方）の 減価償却累計額（貸方）／流動資産の 貸倒引当金（貸方）はマイナス計上。
 * これをしないと評価勘定≠0 で資産が過大計上され貸借不一致になる。
 */
function bsSections(rows: AccountBalanceRow[], sections: string[]): BsSectionView[] {
  return sections
    .map((section) => {
      const sectionRows = rows.filter((r) => r.section === section)
      const natural: Side = ASSET_SECTIONS.includes(section) ? 'debit' : 'credit'
      const total = yen(sectionRows.reduce((s, r) => s + (r.normalBalance === natural ? r.balance : -r.balance), 0))
      return { section, rows: sectionRows, total }
    })
    .filter((s) => s.rows.length > 0)
}

/**
 * 貸借対照表（BS科目を section で集計、資本の部に当期所得を連結）。
 * 青色決算書準拠: 資本セクションの**借方科目（事業主貸 等）は「資産の部」**に表示する
 * （資本に加算すると事業主貸≠0 で貸借不一致になるため。事業主貸は資本控除＝資産側）。
 */
export function balanceSheet(db: DataDb, fiscalYearId: number): BalanceSheet {
  const all = accountAggregates(db, fiscalYearId)
  const bs = all.filter((r) => r.reportType === 'BS')
  const netIncome = profitAndLoss(db, fiscalYearId).netIncome

  // 資本セクションを 貸方科目（元入金・事業主借＝資本の部）と 借方科目（事業主貸＝資産の部）に分離。
  const capitalRows = bs.filter((r) => EQUITY_SECTIONS.includes(r.section))
  const ownerDrawRows = capitalRows.filter((r) => r.normalBalance === 'debit')
  const equityRows = capitalRows.filter((r) => r.normalBalance === 'credit')

  const assetSections = bsSections(bs, ASSET_SECTIONS)
  const ownerDrawSection: BsSectionView[] = ownerDrawRows.length
    ? [{ section: '事業主貸', rows: ownerDrawRows, total: yen(ownerDrawRows.reduce((s, r) => s + r.balance, 0)) }]
    : []
  const assets = [...assetSections, ...ownerDrawSection]

  const liabilities = bsSections(bs, LIABILITY_SECTIONS)
  const equity: BsSectionView[] = equityRows.length
    ? [{ section: '資本', rows: equityRows, total: yen(equityRows.reduce((s, r) => s + r.balance, 0)) }]
    : []

  const totalAssets = yen(assets.reduce((s, sec) => s + sec.total, 0))
  const totalLiabilities = yen(liabilities.reduce((s, sec) => s + sec.total, 0))
  const equityBeforeIncome = yen(equity.reduce((s, sec) => s + sec.total, 0))
  const totalEquity = yen(equityBeforeIncome + netIncome)

  return {
    assets,
    liabilities,
    equity,
    totalAssets,
    totalLiabilities,
    totalEquity,
    netIncome,
    balanced: totalAssets === yen(totalLiabilities + totalEquity),
  }
}

// --- 月次推移表 ------------------------------------------------------------


/** start〜end（YYYY-MM-DD）が跨る月を YYYY-MM の昇順で列挙（最大120ヶ月で打切）。 */
function monthsBetween(startDate: string, endDate: string): string[] {
  const months: string[] = []
  let y = Number(startDate.slice(0, 4))
  let m = Number(startDate.slice(5, 7))
  const end = endDate.slice(0, 7)
  for (let i = 0; i < 120; i++) {
    const ym = `${y}-${String(m).padStart(2, '0')}`
    months.push(ym)
    if (ym >= end) break
    m++
    if (m > 12) {
      m = 1
      y++
    }
  }
  return months
}

/**
 * 月次推移表（推移表 月×科目 / roadmap Phase2）。
 * confirmed 仕訳を entry_date の月でバケットし、科目ごとに normal_balance 方向の
 * 月次発生高を出す（開始残高は含めない＝発生ベース）。月外の明細は無視。
 */
export function monthlyTrend(db: DataDb, fiscalYearId: number): MonthlyTrend {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fiscalYearId} が見つかりません`)
  const months = monthsBetween(fy.startDate, fy.endDate)
  const monthIndex = new Map(months.map((m, i) => [m, i]))
  const metaById = accountMetaById(db)

  const lines = db
    .select({
      accountId: journalLines.accountId,
      side: journalLines.side,
      amount: journalLines.amount,
      entryDate: journalEntries.entryDate,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(eq(journalEntries.fiscalYearId, fiscalYearId), eq(journalEntries.status, 'confirmed')))
    .all()

  const byAccount = new Map<number, number[]>()
  for (const l of lines) {
    const idx = monthIndex.get(l.entryDate.slice(0, 7))
    if (idx === undefined) continue // 会計年度の月レンジ外（通常は期間ゲートで発生しない）
    const meta = metaById.get(l.accountId)
    if (!meta) continue
    const arr = byAccount.get(l.accountId) ?? new Array<number>(months.length).fill(0)
    const debit = l.side === 'debit' ? yen(l.amount) : yen(0)
    const credit = l.side === 'credit' ? yen(l.amount) : yen(0)
    arr[idx] += accountBalance(meta.normalBalance as Side, debit, credit)
    byAccount.set(l.accountId, arr)
  }

  const rows: TrendRow[] = []
  for (const [accountId, monthly] of byAccount) {
    const meta = metaById.get(accountId)!
    rows.push({
      accountId,
      accountName: meta.accountName,
      reportType: meta.reportType as ReportType,
      section: meta.section,
      normalBalance: meta.normalBalance as Side,
      monthly: monthly.map((v) => yen(v)),
      total: yen(monthly.reduce((s, v) => s + v, 0)),
    })
  }
  rows.sort((a, b) => {
    const ma = metaById.get(a.accountId)!
    const mb = metaById.get(b.accountId)!
    return ma.sortOrder - mb.sortOrder || a.accountId - b.accountId
  })
  return { months, rows }
}

