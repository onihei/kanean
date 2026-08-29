/**
 * 帳票 API の wire 型（issue #128）。server（集計の組み立て）と web（表示）が同じ定義を使う
 * ＝ Yen 型が web まで型レベルで貫通し、フィールドのドリフト（かつて lineCode 欠落）が起きない。
 * 集計の実装は server/src/reports/（base / statements / ledgers / taxSummaries /
 * departments / comparative）。
 */
import type { Yen } from '../money.js'
import type { Side } from '../ledger.js'

export type ReportType = 'BS' | 'PL'

/** 期間フィルタ。from/to は entry_date（ISO日付）の閉区間。 */
export interface Period {
  from?: string | null
  to?: string | null
}

export interface AccountBalanceRow {
  accountId: number
  accountName: string
  reportType: ReportType
  section: string
  categoryName: string
  itemName: string
  normalBalance: Side
  totalDebit: Yen
  totalCredit: Yen
  /** normal_balance 方向の残高（正＝通常側、負＝逆側）。 */
  balance: Yen
  sortOrder: number
  /** 青色申告決算書の様式ボックス line_code（AOIRO.PL.* 等。未設定の決算書科目は null）。 */
  lineCode: string | null
}

export interface TrialBalance {
  rows: AccountBalanceRow[]
  totalDebit: Yen
  totalCredit: Yen
  /** Σ借方 = Σ貸方 なら true（貸借一致）。 */
  balanced: boolean
}

export interface PlSectionView {
  section: string
  rows: AccountBalanceRow[]
  total: Yen
}
export interface ProfitAndLoss {
  sales: PlSectionView
  costOfSales: PlSectionView
  expenses: PlSectionView
  /** その他（繰戻額等＝貸倒引当金戻入。所得に加算する収益側）。 */
  otherIncome: PlSectionView
  /** 売上総利益 = 売上 − 売上原価。 */
  grossProfit: Yen
  /** 当期所得（控除前所得金額㊸）= 売上総利益 − 経費 + 繰戻額等。 */
  netIncome: Yen
}

export interface BsSectionView {
  section: string
  rows: AccountBalanceRow[]
  total: Yen
}
export interface BalanceSheet {
  assets: BsSectionView[]
  liabilities: BsSectionView[]
  equity: BsSectionView[]
  totalAssets: Yen
  totalLiabilities: Yen
  /** 資本の部合計（控除前所得金額を含む）。 */
  totalEquity: Yen
  /** 連結: 損益計算書の当期所得（資本の部に算入・§1 末尾）。 */
  netIncome: Yen
  /** 借方計 = 貸方計 なら true。 */
  balanced: boolean
}

export interface TrendRow {
  accountId: number
  accountName: string
  reportType: ReportType
  section: string
  normalBalance: Side
  /** 各月の発生高（normal_balance 方向の純増減）。長さ = months.length。 */
  monthly: Yen[]
  /** 期間合計（monthly の総和）。 */
  total: Yen
}
export interface MonthlyTrend {
  /** 会計年度の月ラベル（YYYY-MM、期首→期末）。 */
  months: string[]
  rows: TrendRow[]
}

export interface LedgerRow {
  entryId: number
  entryDate: string
  description: string | null
  /** 相手科目名（複数なら「諸口」）。 */
  counterAccount: string
  debit: Yen
  credit: Yen
  /** その行までの normal_balance 方向の累積残高。 */
  balance: Yen
}
export interface GeneralLedger {
  accountId: number
  accountName: string
  normalBalance: Side
  openingBalance: Yen
  rows: LedgerRow[]
  closingBalance: Yen
}
export interface SubLedger {
  subAccountId: number
  subAccountName: string
  accountId: number
  accountName: string
  normalBalance: Side
  openingBalance: Yen
  rows: LedgerRow[]
  closingBalance: Yen
}

export interface TaxSalesRow {
  taxCategoryId: number
  code: string
  label: string
  rate: number | null
  simplifiedCategory: string | null
  /** none / return（返還等対価）/ bad_debt（貸倒れ）。 */
  adjustment: string
  grossAmount: Yen // 税込
  netAmount: Yen // 税抜（= 税込 − 税額）
  taxAmount: Yen // 消費税額
  count: number
}
/** 税率別の課税標準額（税抜・通常売上のみ）。simplifiedTax.base への入力源。 */
export interface TaxSalesBase {
  rate: number
  net: Yen
  tax: Yen
}
export interface TaxSalesSummary {
  rows: TaxSalesRow[]
  baseByRate: TaxSalesBase[]
  totalGross: Yen
  totalNet: Yen
  totalTax: Yen
}

export interface TaxExcludedPlRow {
  accountId: number
  accountName: string
  section: string
  normalBalance: Side
  gross: Yen
  tax: Yen
  net: Yen
}
export interface TaxExcludedPlSection {
  section: string
  rows: TaxExcludedPlRow[]
  gross: Yen
  tax: Yen
  net: Yen
}
export interface TaxExcludedProfitAndLoss {
  /** business_settings.accounting_method（既定 tax_included）。本表は税込記帳から内税を控除した本体表示。 */
  accountingMethod: string
  sales: TaxExcludedPlSection
  costOfSales: TaxExcludedPlSection
  expenses: TaxExcludedPlSection
  /** 税抜（本体）ベース。 */
  grossProfitNet: Yen
  netIncomeNet: Yen
  /** 税込ベース（参考・既存 profitAndLoss と一致）。 */
  grossProfitGross: Yen
  netIncomeGross: Yen
}

export interface DepartmentColumn {
  departmentId: number | null
  departmentName: string
}
export interface DepartmentMatrixRow {
  accountId: number
  accountName: string
  reportType: ReportType
  section: string
  normalBalance: Side
  byDept: Yen[]
  total: Yen
}
export interface DepartmentTrialBalance {
  departments: DepartmentColumn[]
  rows: DepartmentMatrixRow[]
  /** 各部門列の借方合計・貸方合計（発生高）。 */
  totalsByDept: { totalDebit: Yen; totalCredit: Yen }[]
  totalDebit: Yen
  totalCredit: Yen
  balanced: boolean
}
export interface DepartmentPlSection {
  section: string
  rows: DepartmentMatrixRow[]
  /** 各部門列の section 小計。 */
  totalByDept: Yen[]
  total: Yen
}
export interface DepartmentProfitAndLoss {
  departments: DepartmentColumn[]
  sales: DepartmentPlSection
  costOfSales: DepartmentPlSection
  expenses: DepartmentPlSection
  /** 売上総利益 = 売上 − 売上原価（部門別）。 */
  grossProfitByDept: Yen[]
  grossProfit: Yen
  /** 当期所得（控除前所得金額）= 売上総利益 − 経費（部門別）。 */
  netIncomeByDept: Yen[]
  netIncome: Yen
}

export interface CompareCell {
  current: Yen
  prior: Yen
  /** 増減 = 当期 − 前期。 */
  delta: Yen
  /** 増減率(%) = 増減 / |前期| ×100（小数1桁）。前期が0なら null（'—' 表示）。 */
  deltaPct: number | null
}
/** 1科目の比較行（当期/前期いずれかに存在すれば現れる。欠けた側は0）。 */
export interface ComparativeRow extends CompareCell {
  accountId: number
  accountName: string
  section: string
}
export interface ComparativeTrialBalance {
  /** 比較対象（前期）が存在するか。false なら前期列は全て0。 */
  hasPrior: boolean
  rows: ComparativeRow[]
  totalDebit: CompareCell
  totalCredit: CompareCell
}
export interface ComparativePlSection {
  section: string
  rows: ComparativeRow[]
  total: CompareCell
}
export interface ComparativeProfitAndLoss {
  hasPrior: boolean
  sales: ComparativePlSection
  costOfSales: ComparativePlSection
  expenses: ComparativePlSection
  /** その他（繰戻額等＝貸倒引当金戻入。当期所得の構成要素）。 */
  otherIncome: ComparativePlSection
  grossProfit: CompareCell
  netIncome: CompareCell
}
export interface ComparativeBsSection {
  section: string
  rows: ComparativeRow[]
  total: CompareCell
}
export interface ComparativeBalanceSheet {
  hasPrior: boolean
  assets: ComparativeBsSection[]
  liabilities: ComparativeBsSection[]
  equity: ComparativeBsSection[]
  totalAssets: CompareCell
  totalLiabilities: CompareCell
  totalEquity: CompareCell
  netIncome: CompareCell
}
