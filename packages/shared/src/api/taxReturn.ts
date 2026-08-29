/**
 * 税・申告の wire 型（納税予測・消費税申告・青色申告特別控除・確定申告・青色決算書様式）。
 * server が実装の正、web/mcp は読者（issue #236）。
 *
 * 消費税の税率・事業区分は core（TaxRate / SimplifiedCategory）と同値のリテラル並びで持つ
 * （shared は core に依存できない: core → shared の依存方向）。
 */
import type { Yen } from '../money.js'

// --- 納税予測（GET /tax-forecast） ------------------------------------------

/** 納税予測の1シナリオ。すべて円整数。 */
export interface TaxForecastScenario {
  /** 年換算後の事業所得（青色申告特別控除後・㊺相当）。 */
  businessIncome: Yen
  /** 課税される所得金額（所得控除適用後・千円未満切捨て）。 */
  taxableIncome: Yen
  /** 所得税及び復興特別所得税の額（源泉・予定納税の控除前＝年間の税負担額）。 */
  incomeTax: Yen
  /** 住民税概算（所得割10%＋均等割5,000円）。 */
  residentTax: Yen
  /** 個人事業税概算（事業主控除290万円・5%。課税標準は青色控除前㊸）。 */
  businessTax: Yen
  /** 消費税（簡易課税。年換算した課税売上の税抜額ベース）。 */
  consumptionTax: Yen
  /** 年間税負担合計（incomeTax＋residentTax＋businessTax＋consumptionTax）。 */
  totalTax: Yen
}

export interface TaxForecastWhatIf extends TaxForecastScenario {
  /** 適用した追加経費（年額）。 */
  extraExpense: Yen
  /** 適用した追加所得控除（年額）。 */
  extraDeduction: Yen
  /** 税負担差 = whatIf.totalTax − projected.totalTax（負＝節税）。 */
  delta: Yen
}

export interface TaxForecast {
  fiscalYearId: number
  /** 期首から now までの経過月数（当月を含む。1..12 にクランプ）。 */
  elapsedMonths: number
  /** 期中実績（confirmed 仕訳ベース・年換算前）。 */
  actual: {
    /** 事業所得㊺（青色申告特別控除後）。 */
    businessIncome: Yen
    /** 売上（収入金額・税込）。 */
    sales: Yen
  }
  /** 年換算ベースの予測（what-if 適用前の基準）。 */
  projected: TaxForecastScenario
  /** extraExpense / extraDeduction 指定時のみ。 */
  whatIf?: TaxForecastWhatIf
  /** 参考値・税理士確認前の免責（UI 必須表示）。 */
  disclaimer: string
}

// --- 消費税申告書（簡易課税） ------------------------------------------------

export interface ConsumptionTaxBaseRow {
  /** 税率%（core TaxRate と同値）。 */
  rate: 10 | 8
  /** 課税標準額（税抜・千円未満切捨て後）。 */
  taxBase: Yen
  /** その税率の売上に係る消費税額（国税分）。 */
  salesTaxNational: Yen
}

export interface ConsumptionTaxReturn {
  /** business_settings.tax_method（simplified 前提）。 */
  taxMethod: string
  /** 事業区分（1..6。core SimplifiedCategory と同値）。 */
  businessCategory: 1 | 2 | 3 | 4 | 5 | 6
  /** みなし仕入率（0..1）。 */
  deemedRate: number
  /** 付表4-3/5-3（税率別 課税標準額・売上税額）。 */
  baseRows: ConsumptionTaxBaseRow[]
  /** 課税標準額 合計（千円未満切捨て後の総和）。 */
  taxBaseTotal: Yen
  /** 売上に係る消費税額（国税）。 */
  salesTaxNational: Yen
  /** 控除対象仕入税額（みなし）。 */
  deemedDeduction: Yen
  /** 返還等対価に係る税額（国税）。 */
  returnNational: Yen
  /** 貸倒れに係る税額（国税）。 */
  badDebtNational: Yen
  /** 差引国税（百円未満切捨て）。 */
  national: Yen
  /** 地方消費税（百円未満切捨て）。 */
  local: Yen
  /** 中間納付税額（本システム未追跡＝0。手動確認）。 */
  midPaid: Yen
  /** 納付税額（＝国税＋地方−中間納付）。 */
  payable: Yen
  /** 簡易課税前提が成立するか（tax_method=simplified）。 */
  applicable: boolean
  /** 注記（適用外・前提条件など）。 */
  note: string | null
}

// --- 青色申告特別控除㊹・所得金額㊺ ------------------------------------------

export interface BlueReturnSummary {
  /** ㊸ 控除前所得金額。 */
  incomeBeforeDeduction: Yen
  /** 控除限度額（650,000 / 550,000 / 100,000 / 0）。 */
  deductionLimit: Yen
  /** ㊹ 青色申告特別控除額。 */
  deduction: Yen
  /** ㊺ 所得金額（→ 確定申告書 事業所得）。 */
  income: Yen
  /** 申告区分（blue / white）。 */
  filingType: 'blue' | 'white'
  /** 65万円の電子要件を満たす設定か。 */
  qualifiesFor65: boolean
  /** 判定根拠（表示用）。 */
  basis: string
}

// --- 確定申告書 第一表・第二表（所得税） -------------------------------------

/** 所得控除・予定納税の入力（core IncomeTaxDeductionInputs ＋ estimatedPrepaid をフラットに持つ）。 */
export interface TaxReturnInputsView {
  /** 基礎控除。 */
  basicDeduction: number
  /** 社会保険料控除。 */
  socialInsurance: number
  /** 生命保険料控除。 */
  lifeInsurance: number
  /** 医療費控除。 */
  medical: number
  /** 配偶者・扶養控除。 */
  spouseDependents: number
  /** その他の所得控除。 */
  otherDeductions: number
  /** 予定納税額。 */
  estimatedPrepaid: number
}

export interface IncomeDetailRow {
  counterpartyId: number | null
  /** 支払者（取引先名。未設定なら注記）。 */
  payerName: string
  /** 収入金額（同一仕訳内の売上合計）。 */
  revenue: Yen
  /** 源泉徴収税額。 */
  withholding: Yen
}

export interface IncomeTaxReturn {
  /** 収入金額等：事業（＝売上・税込経理の税込）。 */
  businessRevenue: Yen
  /** 所得金額等：事業＝青色決算書 所得金額㊺。 */
  businessIncome: Yen
  /** 合計所得金額（事業所得単独前提）。 */
  totalIncome: Yen
  /** 所得控除の入力内訳。 */
  inputs: TaxReturnInputsView
  /** 所得控除合計。 */
  totalDeductions: Yen
  /** 課税される所得金額（千円未満切捨て）。 */
  taxableIncome: Yen
  /** 基準所得税額（累進税率）。 */
  baseTax: Yen
  /** 復興特別所得税（×2.1%）。 */
  surtax: Yen
  /** 所得税及び復興特別所得税の額。 */
  taxWithSurtax: Yen
  /** 源泉徴収税額（帳簿集計）。 */
  withholding: Yen
  /** 予定納税額。 */
  estimatedPrepaid: Yen
  /** 申告納税額の生値（㊾。百円未満切捨て前・負＝還付）。描画層はこれを参照し再計算しない。 */
  payableRaw: Yen
  /** 申告納税額（納付。百円未満切捨て）。還付の場合は0。 */
  payable: Yen
  /** 還付される税金（payableRaw が負のときの絶対額。納付の場合は0）。 */
  refund: Yen
  /** 第二表 所得の内訳（支払者別 収入・源泉徴収税額）。 */
  incomeDetail: IncomeDetailRow[]
}

// --- 青色決算書 内訳ページ（form-mapping §1.3〜§1.7） ------------------------

export interface DepreciationRow {
  fixedAssetId: number
  managementNo: string | null
  name: string
  /** 面積又は数量。 */
  quantityOrArea: number
  acquiredDate: string | null
  acquisitionCost: Yen
  depreciationMethod: string
  usefulLife: number | null
  depreciationRate: number | null
  /** 期首未償却残高（償却の基礎＝定率法のロ欄）。 */
  openingBookValue: Yen
  /** 本年分の普通償却費（事業＋家事の全額）。 */
  depreciationAmount: Yen
  businessUseRatio: number
  /** 本年分の必要経費算入額（事業分・損益⑱へ算入）。 */
  businessAmount: Yen
  /** 未償却残高（期末）。 */
  closingBookValue: Yen
  specialDepreciation: Yen | null
}

export interface DepreciationBreakdown {
  rows: DepreciationRow[]
  depreciationTotal: Yen
  /** 必要経費算入額の合計（== 損益 ⑱）。 */
  businessAmountTotal: Yen
}

export interface BreakdownRow {
  /** グルーピングキー（補助科目 id / 取引先 id。未設定は null）。 */
  key: number | null
  name: string
  amount: Yen
}

export interface ExpenseBreakdown {
  rows: BreakdownRow[]
  total: Yen
}

export interface MonthlySalesPurchaseRow {
  /** 月（1〜12）。 */
  month: number
  sales: Yen
  purchases: Yen
}

export interface MonthlySalesPurchase {
  rows: MonthlySalesPurchaseRow[]
  salesTotal: Yen
  purchasesTotal: Yen
}

/** 貸倒引当金繰入額の計算（①〜⑤）。total（⑤）が0なら様式上は空欄。 */
export interface ReserveAllowanceCalc {
  /** ① 個別評価による本年分繰入額（未モデル化・常に 0）。 */
  individual: Yen
  /** ② 年末における一括評価による貸金の合計額（期末 売掛金＋受取手形）。 */
  grossReceivables: Yen
  /** ③ 本年分繰入限度額（② × 5.5%）。 */
  limit: Yen
  /** ④ 本年分繰入額（一括評価）＝ ⑤ − ①。 */
  lumpReserve: Yen
  /** ⑤ 本年分貸倒引当金繰入額（＝損益 RESERVE_IN 実績）。 */
  total: Yen
  /** 適用した繰入率。 */
  rate: number
}

// --- 青色申告決算書（4ページ分の様式データ） ---------------------------------

/** 損益計算書の様式ボックス（欄番号 box・ラベル・金額）。 */
export interface FormBox {
  /** 内部 line_code（AOIRO.PL.*）。空欄行は AOIRO.PL.EXP_BLANK_n。 */
  code: string
  /** 表示ラベル（決算書科目名）。 */
  label: string
  /** 官製様式の欄番号（丸数字・慣用値。令和6年様式で要突合）。 */
  box: string | null
  amount: Yen
}

export interface BlueReturnStatementPl {
  sales: FormBox // ①
  openStock: FormBox // ②
  purchase: FormBox // ③
  subtotalCost: FormBox // ④ = ②+③
  closeStock: FormBox // ⑤
  costOfSales: FormBox // ⑥ = ④−⑤（差引原価）
  grossProfit: FormBox // ⑦ = ①−⑥（売上総利益）
  /** ⑧〜㉜（標準経費＋空欄行＋雑費。専従者給与・繰入額は含めない）。 */
  expenses: FormBox[]
  expenseTotal: FormBox // ㉝（経費計）
  netBeforeAdjust: FormBox // ㉞ = ⑦−㉝（差引金額）
  reserveBack: FormBox // 各種引当金等 繰戻額（貸倒引当金戻入）
  reserveIn: FormBox // 各種引当金等 繰入額（貸倒引当金繰入）
  senju: FormBox // 専従者給与
  incomeBeforeDeduction: FormBox // ㊸（青色申告特別控除前の所得金額）
  blueDeduction: FormBox // ㊹（青色申告特別控除額）
  income: FormBox // ㊺（所得金額）
}

/** 貸借対照表の様式行（固定行は label 省略・空欄行は科目名を持つ）。 */
export interface BsFormRow {
  row: number
  /** 固定行は undefined（様式に印字済）。空欄行は科目名を記入。 */
  label?: string
  opening: Yen
  closing: Yen
}

export interface BlueBalanceSheet {
  assets: BsFormRow[]
  liabilities: BsFormRow[]
  /** 青色申告特別控除前の所得金額（期末のみ・期首は空欄）。 */
  incomeBeforeDeduction: Yen
  assetTotal: { opening: Yen; closing: Yen }
  liabTotal: { opening: Yen; closing: Yen }
  /** 貸借一致（期末）。 */
  balanced: boolean
}

/** 青色申告決算書の集約（GET /tax-return/blue-statement）。 */
export interface BlueStatementReport {
  pl: BlueReturnStatementPl
  balanceSheet: BlueBalanceSheet
  summary: BlueReturnSummary
  monthly: MonthlySalesPurchase
  salary: ExpenseBreakdown
  senju: ExpenseBreakdown
  rent: ExpenseBreakdown
  depreciation: DepreciationBreakdown
  reserveAllowance: ReserveAllowanceCalc
}
