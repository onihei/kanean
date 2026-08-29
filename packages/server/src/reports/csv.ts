import { toCsv, type CsvValue } from '@kanean/shared'
import type {
  TrialBalance,
  ProfitAndLoss,
  BalanceSheet,
  GeneralLedger,
  SubLedger,
  LedgerRow,
  MonthlyTrend,
  TaxSalesSummary,
  DepartmentTrialBalance,
  DepartmentProfitAndLoss,
  TaxExcludedProfitAndLoss,
  CompareCell,
  ComparativeTrialBalance,
  ComparativeProfitAndLoss,
  ComparativeBalanceSheet,
} from './reports.js'
import type { EntryView } from '../journal/entries.js'

/**
 * 帳票の CSV 化（F-BOK-4 / roadmap Phase2）。各帳票を文字列マトリクスへ変換し、
 * @kanean/shared の toCsv（RFC4180・CRLF）でシリアライズする。純粋（I/O なし）。
 * 文字コード（UTF-8 BOM）と Content-Disposition は配信層（http/api）が付与する。
 */

/** 金額セル: 0 は空欄（帳票表示と揃える）。 */
const amt = (n: number): CsvValue => (n ? n : '')

export function trialBalanceCsv(tb: TrialBalance): string {
  const rows: CsvValue[][] = [['区分', '勘定科目', '借方合計', '貸方合計', '残高']]
  for (const r of tb.rows) rows.push([r.section, r.accountName, amt(r.totalDebit), amt(r.totalCredit), r.balance])
  rows.push(['合計', '', tb.totalDebit, tb.totalCredit, ''])
  return toCsv(rows)
}

export function profitAndLossCsv(pl: ProfitAndLoss): string {
  const rows: CsvValue[][] = [['区分', '科目', '金額']]
  const section = (label: string, total: number, items: ProfitAndLoss['sales']['rows']) => {
    rows.push([label, '', total])
    for (const r of items) rows.push(['', r.accountName, r.balance])
  }
  section('売上（収入）金額', pl.sales.total, pl.sales.rows)
  if (pl.costOfSales.rows.length > 0) section('売上原価', pl.costOfSales.total, pl.costOfSales.rows)
  rows.push(['売上総利益', '', pl.grossProfit])
  section('経費', pl.expenses.total, pl.expenses.rows)
  if (pl.otherIncome.rows.length > 0) section('その他（繰戻額等）', pl.otherIncome.total, pl.otherIncome.rows)
  rows.push(['当期所得（控除前所得金額）', '', pl.netIncome])
  return toCsv(rows)
}

export function balanceSheetCsv(bs: BalanceSheet): string {
  const rows: CsvValue[][] = [['部', '区分/科目', '金額']]
  const sections = (part: string, secs: BalanceSheet['assets'], extra?: { label: string; amount: number }) => {
    for (const sec of secs) {
      rows.push([part, sec.section, sec.total])
      for (const r of sec.rows) rows.push(['', r.accountName, r.balance])
    }
    if (extra) rows.push([part, extra.label, extra.amount])
  }
  sections('資産の部', bs.assets)
  rows.push(['資産の部 合計', '', bs.totalAssets])
  sections('負債の部', bs.liabilities)
  sections('資本の部', bs.equity, { label: '当期所得（控除前所得金額）', amount: bs.netIncome })
  rows.push(['負債・資本の部 合計', '', bs.totalLiabilities + bs.totalEquity])
  return toCsv(rows)
}

/** 元帳・補助元帳共通の明細マトリクス（期首繰越→明細→期末残高）。 */
function ledgerMatrix(openingBalance: number, ledgerRows: LedgerRow[], closingBalance: number): CsvValue[][] {
  const rows: CsvValue[][] = [['日付', '摘要', '相手科目', '借方', '貸方', '残高']]
  rows.push(['', '期首繰越', '', '', '', openingBalance])
  for (const r of ledgerRows) rows.push([r.entryDate, r.description, r.counterAccount, amt(r.debit), amt(r.credit), r.balance])
  rows.push(['', '期末残高', '', '', '', closingBalance])
  return rows
}

export function generalLedgerCsv(led: GeneralLedger): string {
  return toCsv(ledgerMatrix(led.openingBalance, led.rows, led.closingBalance))
}

export function subLedgerCsv(led: SubLedger): string {
  return toCsv(ledgerMatrix(led.openingBalance, led.rows, led.closingBalance))
}

const ADJUSTMENT_LABEL: Record<string, string> = { none: '通常', return: '返還', bad_debt: '貸倒' }

/** 税区分別 課税売上集計 CSV（明細＋合計＋税率別課税標準額）。 */
export function taxSalesCsv(s: TaxSalesSummary): string {
  const rows: CsvValue[][] = [['税区分', '税率', '区分', '件数', '税込', '税抜', '税額']]
  for (const r of s.rows) {
    rows.push([r.label, r.rate != null ? `${r.rate}%` : '', ADJUSTMENT_LABEL[r.adjustment] ?? r.adjustment, r.count, r.grossAmount, r.netAmount, r.taxAmount])
  }
  rows.push(['合計', '', '', s.rows.reduce((a, r) => a + r.count, 0), s.totalGross, s.totalNet, s.totalTax])
  rows.push([])
  rows.push(['税率別 課税標準額（税抜・通常売上）'])
  rows.push(['税率', '税抜', '税額'])
  for (const b of s.baseByRate) rows.push([`${b.rate}%`, b.net, b.tax])
  return toCsv(rows)
}

/** 部門別試算表 CSV（区分・科目・各部門の残高・合計＋部門別借貸合計）。 */
export function departmentTrialBalanceCsv(tb: DepartmentTrialBalance): string {
  const rows: CsvValue[][] = [['区分', '勘定科目', ...tb.departments.map((d) => d.departmentName), '合計']]
  for (const r of tb.rows) rows.push([r.section, r.accountName, ...r.byDept.map(amt), r.total])
  rows.push(['借方合計', '', ...tb.totalsByDept.map((t) => t.totalDebit), tb.totalDebit])
  rows.push(['貸方合計', '', ...tb.totalsByDept.map((t) => t.totalCredit), tb.totalCredit])
  return toCsv(rows)
}

/** 税抜損益計算書 CSV（区分・科目・税込・内税・税抜）。 */
export function taxExcludedProfitAndLossCsv(pl: TaxExcludedProfitAndLoss): string {
  const rows: CsvValue[][] = [['区分', '科目', '税込', '内税', '税抜']]
  const section = (label: string, sec: TaxExcludedProfitAndLoss['sales']) => {
    rows.push([label, '', sec.gross, sec.tax, sec.net])
    for (const r of sec.rows) rows.push(['', r.accountName, amt(r.gross), amt(r.tax), amt(r.net)])
  }
  section('売上（収入）金額', pl.sales)
  if (pl.costOfSales.rows.length > 0) section('売上原価', pl.costOfSales)
  rows.push(['売上総利益', '', pl.grossProfitGross, '', pl.grossProfitNet])
  section('経費', pl.expenses)
  rows.push(['当期所得（控除前所得金額）', '', pl.netIncomeGross, '', pl.netIncomeNet])
  return toCsv(rows)
}

/** 部門別損益計算書 CSV（区分・科目・各部門の発生高・合計）。 */
export function departmentProfitAndLossCsv(pl: DepartmentProfitAndLoss): string {
  const rows: CsvValue[][] = [['区分', '科目', ...pl.departments.map((d) => d.departmentName), '合計']]
  const section = (label: string, sec: DepartmentProfitAndLoss['sales']) => {
    rows.push([label, '', ...sec.totalByDept, sec.total])
    for (const r of sec.rows) rows.push(['', r.accountName, ...r.byDept.map(amt), r.total])
  }
  section('売上（収入）金額', pl.sales)
  if (pl.costOfSales.rows.length > 0) section('売上原価', pl.costOfSales)
  rows.push(['売上総利益', '', ...pl.grossProfitByDept, pl.grossProfit])
  section('経費', pl.expenses)
  rows.push(['当期所得（控除前所得金額）', '', ...pl.netIncomeByDept, pl.netIncome])
  return toCsv(rows)
}

/** 月次推移表 CSV（区分・科目・各月・合計）。 */
export function monthlyTrendCsv(trend: MonthlyTrend): string {
  const rows: CsvValue[][] = [['区分', '勘定科目', ...trend.months, '合計']]
  for (const r of trend.rows) rows.push([r.section, r.accountName, ...r.monthly.map(amt), r.total])
  return toCsv(rows)
}

// --- 前期比較（複数年度比較）CSV --------------------------------------------

/** 増減率セル: null（前期0）は空欄。 */
const pctCell = (p: number | null): CsvValue => (p == null ? '' : p)

/** 比較セル→CSV 4列（当期/前期/増減/増減率）。amount=true は 0 を空欄に（明細行向け）。 */
const cmpCells = (c: CompareCell, amount = false): CsvValue[] =>
  amount ? [amt(c.current), amt(c.prior), amt(c.delta), pctCell(c.deltaPct)] : [c.current, c.prior, c.delta, pctCell(c.deltaPct)]

const COMPARE_HEAD = ['当期', '前期', '増減', '増減率(%)']

/** 比較試算表 CSV（科目別残高の当期/前期/増減・借貸合計）。 */
export function comparativeTrialBalanceCsv(tb: ComparativeTrialBalance): string {
  const rows: CsvValue[][] = [['区分', '勘定科目', ...COMPARE_HEAD]]
  for (const r of tb.rows) rows.push([r.section, r.accountName, ...cmpCells(r, true)])
  rows.push(['借方合計', '', ...cmpCells(tb.totalDebit)])
  rows.push(['貸方合計', '', ...cmpCells(tb.totalCredit)])
  return toCsv(rows)
}

/** 比較損益計算書 CSV（区分・科目の当期/前期/増減・総利益・当期所得）。 */
export function comparativeProfitAndLossCsv(pl: ComparativeProfitAndLoss): string {
  const rows: CsvValue[][] = [['区分', '科目', ...COMPARE_HEAD]]
  const section = (label: string, sec: ComparativeProfitAndLoss['sales']) => {
    rows.push([label, '', ...cmpCells(sec.total)])
    for (const r of sec.rows) rows.push(['', r.accountName, ...cmpCells(r, true)])
  }
  section('売上（収入）金額', pl.sales)
  if (pl.costOfSales.rows.length > 0) section('売上原価', pl.costOfSales)
  rows.push(['売上総利益', '', ...cmpCells(pl.grossProfit)])
  section('経費', pl.expenses)
  if (pl.otherIncome.rows.length > 0) section('その他（繰戻額等）', pl.otherIncome)
  rows.push(['当期所得（控除前所得金額）', '', ...cmpCells(pl.netIncome)])
  return toCsv(rows)
}

/** 比較貸借対照表 CSV（部・区分/科目の当期/前期/増減）。 */
export function comparativeBalanceSheetCsv(bs: ComparativeBalanceSheet): string {
  const rows: CsvValue[][] = [['部', '区分/科目', ...COMPARE_HEAD]]
  const sections = (part: string, secs: ComparativeBalanceSheet['assets'], extra?: { label: string; cell: CompareCell }) => {
    for (const sec of secs) {
      rows.push([part, sec.section, ...cmpCells(sec.total)])
      for (const r of sec.rows) rows.push(['', r.accountName, ...cmpCells(r, true)])
    }
    if (extra) rows.push([part, extra.label, ...cmpCells(extra.cell)])
  }
  sections('資産の部', bs.assets)
  rows.push(['資産の部 合計', '', ...cmpCells(bs.totalAssets)])
  sections('負債の部', bs.liabilities)
  sections('資本の部', bs.equity, { label: '当期所得（控除前所得金額）', cell: bs.netIncome })
  // 負債＋資本（増減は加法的だが増減率は合算では定義しないため空欄）。
  rows.push([
    '負債・資本の部 合計',
    '',
    bs.totalLiabilities.current + bs.totalEquity.current,
    bs.totalLiabilities.prior + bs.totalEquity.prior,
    bs.totalLiabilities.delta + bs.totalEquity.delta,
    '',
  ])
  return toCsv(rows)
}

/** 仕訳帳 CSV（明細行を1行ずつ。借方/貸方は side に応じて片側へ）。 */
export function journalCsv(entries: EntryView[]): string {
  const rows: CsvValue[][] = [['仕訳No', '日付', '摘要', '借/貸', '勘定科目', '補助科目', '取引先', '部門', '借方', '貸方', '税額']]
  for (const e of entries) {
    for (const l of e.lines) {
      rows.push([
        e.id,
        e.entryDate,
        e.description,
        l.side === 'debit' ? '借' : '貸',
        l.accountName,
        l.subAccountName,
        l.counterpartyName,
        l.departmentName,
        l.side === 'debit' ? l.amount : '',
        l.side === 'credit' ? l.amount : '',
        l.taxAmount ?? '',
      ])
    }
  }
  return toCsv(rows)
}
