/**
 * 帳票の公開面（バレル）。実体は base / statements / ledgers / taxSummaries /
 * departments / comparative へ分割した（B3=#116）。ここはコードを持たない再エクスポート専用
 * （基盤コードを残すと comparative との循環 import になるため）。公開名は分割前と同一。
 */
export { accountAggregates, type AccountBalanceRow, type Period, type ReportType } from './base.js'
export {
  balanceSheet,
  monthlyTrend,
  plSectionNaturalSide,
  plSignedBalance,
  profitAndLoss,
  trialBalance,
  type BalanceSheet,
  type BsSectionView,
  type MonthlyTrend,
  type PlSectionView,
  type ProfitAndLoss,
  type TrendRow,
  type TrialBalance,
} from './statements.js'
export { generalLedger, subLedger, type GeneralLedger, type LedgerRow, type SubLedger } from './ledgers.js'
export {
  taxExcludedProfitAndLoss,
  taxSalesSummary,
  type TaxExcludedPlRow,
  type TaxExcludedPlSection,
  type TaxExcludedProfitAndLoss,
  type TaxSalesBase,
  type TaxSalesRow,
  type TaxSalesSummary,
} from './taxSummaries.js'
export {
  departmentProfitAndLoss,
  departmentTrialBalance,
  type DepartmentColumn,
  type DepartmentMatrixRow,
  type DepartmentPlSection,
  type DepartmentProfitAndLoss,
  type DepartmentTrialBalance,
} from './departments.js'
export {
  comparativeBalanceSheet,
  comparativeProfitAndLoss,
  comparativeTrialBalance,
  priorFiscalYearId,
  type CompareCell,
  type ComparativeBalanceSheet,
  type ComparativeBsSection,
  type ComparativePlSection,
  type ComparativeProfitAndLoss,
  type ComparativeRow,
  type ComparativeTrialBalance,
} from './comparative.js'
