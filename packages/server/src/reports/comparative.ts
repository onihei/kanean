import { desc, eq, lt } from 'drizzle-orm'
import {
  type CompareCell,
  type ComparativeBalanceSheet,
  type ComparativeBsSection,
  type ComparativePlSection,
  type ComparativeProfitAndLoss,
  type ComparativeRow,
  type ComparativeTrialBalance,
  yen,
} from '@kanean/shared'

export type { CompareCell, ComparativeBalanceSheet, ComparativeBsSection, ComparativePlSection, ComparativeProfitAndLoss, ComparativeRow, ComparativeTrialBalance }
import type { DataDb } from '../db/router.js'
import { fiscalYears } from '../db/data/schema.js'
import type { AccountBalanceRow } from './base.js'
import {
  balanceSheet,
  profitAndLoss,
  trialBalance,
  type BsSectionView,
  type PlSectionView,
} from './statements.js'

/**
 * 前期比較（比較試算表・比較PL・比較BS）。reports.ts（B3=#116）から分割。
 * base と statements にだけ依存する＝バレル（reports.ts）を介さないので循環しない。
 */

// --- 前期比較（複数年度比較） -----------------------------------------------



function compareCell(current: number, prior: number): CompareCell {
  const delta = current - prior
  let deltaPct: number | null = null
  if (prior !== 0) {
    // 前期0以外で増減率(%)。|増減|/|前期| を小数1桁に丸め、符号は delta に従わせる
    // （同値・逆符号の増減を対称に扱い、-0 を避ける）。
    const magnitude = Math.round((Math.abs(delta) / Math.abs(prior)) * 1000) / 10
    deltaPct = magnitude === 0 ? 0 : delta < 0 ? -magnitude : magnitude
  }
  return { current: yen(current), prior: yen(prior), delta: yen(delta), deltaPct }
}

/**
 * 前期年度を解決：当期 start_date より前に始まる年度のうち start_date 最大のもの。
 * 初年度（前がなければ）null。ISO 日付（YYYY-MM-DD）の辞書順＝時系列順。
 */
export function priorFiscalYearId(db: DataDb, fiscalYearId: number): number | null {
  const cur = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!cur) return null
  const prior = db
    .select({ id: fiscalYears.id })
    .from(fiscalYears)
    .where(lt(fiscalYears.startDate, cur.startDate))
    .orderBy(desc(fiscalYears.startDate))
    .limit(1)
    .all()[0]
  return prior?.id ?? null
}

/** AccountBalanceRow[]（当期/前期）を accountId で突合し、sortOrder 順の比較行へ。 */
function mergeBalanceRows(cur: AccountBalanceRow[], pri: AccountBalanceRow[]): ComparativeRow[] {
  interface Merged {
    accountName: string
    section: string
    sortOrder: number
    cur: number
    pri: number
  }
  const m = new Map<number, Merged>()
  for (const r of cur) {
    m.set(r.accountId, { accountName: r.accountName, section: r.section, sortOrder: r.sortOrder, cur: r.balance, pri: 0 })
  }
  for (const r of pri) {
    const e = m.get(r.accountId)
    if (e) e.pri = r.balance
    else m.set(r.accountId, { accountName: r.accountName, section: r.section, sortOrder: r.sortOrder, cur: 0, pri: r.balance })
  }
  return [...m.entries()]
    .sort(([ax, a], [bx, b]) => a.sortOrder - b.sortOrder || ax - bx)
    .map(([accountId, e]) => ({ accountId, accountName: e.accountName, section: e.section, ...compareCell(e.cur, e.pri) }))
}

// 比較試算表 ------------------------------------------------------------------


/** 比較試算表（科目別残高の当期/前期/増減）。年間（期首〜期末）で比較する。 */
export function comparativeTrialBalance(db: DataDb, fiscalYearId: number, priorFyId: number | null): ComparativeTrialBalance {
  const cur = trialBalance(db, fiscalYearId)
  const pri = priorFyId != null ? trialBalance(db, priorFyId) : null
  return {
    hasPrior: pri != null,
    rows: mergeBalanceRows(cur.rows, pri?.rows ?? []),
    totalDebit: compareCell(cur.totalDebit, pri?.totalDebit ?? 0),
    totalCredit: compareCell(cur.totalCredit, pri?.totalCredit ?? 0),
  }
}

// 比較損益計算書 --------------------------------------------------------------


function mergePlSection(cur: PlSectionView, pri: PlSectionView | null): ComparativePlSection {
  return {
    section: cur.section,
    rows: mergeBalanceRows(cur.rows, pri?.rows ?? []),
    total: compareCell(cur.total, pri?.total ?? 0),
  }
}

/** 比較損益計算書（売上/原価/経費の科目別＋総利益・当期所得の当期/前期/増減）。 */
export function comparativeProfitAndLoss(db: DataDb, fiscalYearId: number, priorFyId: number | null): ComparativeProfitAndLoss {
  const cur = profitAndLoss(db, fiscalYearId)
  const pri = priorFyId != null ? profitAndLoss(db, priorFyId) : null
  return {
    hasPrior: pri != null,
    sales: mergePlSection(cur.sales, pri?.sales ?? null),
    costOfSales: mergePlSection(cur.costOfSales, pri?.costOfSales ?? null),
    expenses: mergePlSection(cur.expenses, pri?.expenses ?? null),
    otherIncome: mergePlSection(cur.otherIncome, pri?.otherIncome ?? null),
    grossProfit: compareCell(cur.grossProfit, pri?.grossProfit ?? 0),
    netIncome: compareCell(cur.netIncome, pri?.netIncome ?? 0),
  }
}

// 比較貸借対照表 --------------------------------------------------------------


/** BS の section 配列を section 名で突合（当期側の順序を保ち、前期のみの section は末尾へ追加）。 */
function mergeBsSections(cur: BsSectionView[], pri: BsSectionView[]): ComparativeBsSection[] {
  const priBySection = new Map(pri.map((s) => [s.section, s]))
  const seen = new Set<string>()
  const out: ComparativeBsSection[] = []
  for (const s of cur) {
    seen.add(s.section)
    const p = priBySection.get(s.section)
    out.push({ section: s.section, rows: mergeBalanceRows(s.rows, p?.rows ?? []), total: compareCell(s.total, p?.total ?? 0) })
  }
  for (const s of pri) {
    if (seen.has(s.section)) continue
    out.push({ section: s.section, rows: mergeBalanceRows([], s.rows), total: compareCell(0, s.total) })
  }
  return out
}

/** 比較貸借対照表（資産/負債/資本の科目別＋各合計・当期所得の当期/前期/増減）。期末残高で比較。 */
export function comparativeBalanceSheet(db: DataDb, fiscalYearId: number, priorFyId: number | null): ComparativeBalanceSheet {
  const cur = balanceSheet(db, fiscalYearId)
  const pri = priorFyId != null ? balanceSheet(db, priorFyId) : null
  return {
    hasPrior: pri != null,
    assets: mergeBsSections(cur.assets, pri?.assets ?? []),
    liabilities: mergeBsSections(cur.liabilities, pri?.liabilities ?? []),
    equity: mergeBsSections(cur.equity, pri?.equity ?? []),
    totalAssets: compareCell(cur.totalAssets, pri?.totalAssets ?? 0),
    totalLiabilities: compareCell(cur.totalLiabilities, pri?.totalLiabilities ?? 0),
    totalEquity: compareCell(cur.totalEquity, pri?.totalEquity ?? 0),
    netIncome: compareCell(cur.netIncome, pri?.netIncome ?? 0),
  }
}
