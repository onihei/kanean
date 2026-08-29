import { type Yen, yen } from '@kanean/shared'

/**
 * 所得税（確定申告書 第一表）の算出（form-mapping §2 / accounting-spec）。
 *
 * ⚠️ 税率・控除額・復興特別所得税率は税制改正で変わる（PRD R-3）→ **外部データ化**。
 *    下記は令和の所得税の速算表を基準値として保持する（要更新・税理士サインオフ対象）。
 *    legalRisk:high — 累進税率・所得税額・申告納税額は税理士サインオフを経るまで確定値としない。
 */

export interface IncomeTaxBracket {
  /** この区分の課税所得上限（円・以下）。null = 上限なし（最高税率）。 */
  upTo: number | null
  /** 税率。 */
  rate: number
  /** 速算表の控除額（円）。 */
  deduction: number
}

/** 所得税の速算表（令和。課税所得は千円未満切捨て済み前提）。 */
export const INCOME_TAX_BRACKETS_REIWA: readonly IncomeTaxBracket[] = [
  { upTo: 1_949_000, rate: 0.05, deduction: 0 },
  { upTo: 3_299_000, rate: 0.1, deduction: 97_500 },
  { upTo: 6_949_000, rate: 0.2, deduction: 427_500 },
  { upTo: 8_999_000, rate: 0.23, deduction: 636_000 },
  { upTo: 17_999_000, rate: 0.33, deduction: 1_536_000 },
  { upTo: 39_999_000, rate: 0.4, deduction: 2_796_000 },
  { upTo: null, rate: 0.45, deduction: 4_796_000 },
]

/** 復興特別所得税率（基準所得税額 × 2.1%）。 */
export const RECONSTRUCTION_SURTAX_RATE = 0.021

/**
 * 課税される所得金額（千円未満切捨て済み前提）に速算表を適用し、基準所得税額を算出する。
 *   税額 = 課税所得 × 税率 − 控除額（0未満は0）
 */
export function incomeTax(
  taxableIncome: Yen,
  brackets: readonly IncomeTaxBracket[] = INCOME_TAX_BRACKETS_REIWA,
): Yen {
  if (taxableIncome <= 0) return yen(0)
  const b = brackets.find((x) => x.upTo == null || taxableIncome <= x.upTo) ?? brackets[brackets.length - 1]
  return yen(Math.max(0, Math.floor(taxableIncome * b.rate) - b.deduction))
}

/** 復興特別所得税（基準所得税額 × 2.1%・1円未満切捨て）。 */
export function reconstructionSurtax(baseTax: Yen): Yen {
  if (baseTax <= 0) return yen(0)
  return yen(Math.floor(baseTax * RECONSTRUCTION_SURTAX_RATE))
}

// --- 確定申告書 第一表の計算チェーン（form-mapping §2） -----------------------

/** 申告書様式の端数規約: 課税される所得金額は千円未満切捨て。 */
const floor1000 = (n: number): number => Math.floor(n / 1000) * 1000
/** 申告書様式の端数規約: 申告納税額は百円未満切捨て。 */
const floor100 = (n: number): number => Math.floor(n / 100) * 100

/** 所得控除のユーザー入力（帳簿から導出できない第一表の控除欄）。 */
export interface IncomeTaxDeductionInputs {
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
}

/** 所得控除の合計対象フィールド（控除合計の導出も様式ロジックとして core が持つ）。 */
export const DEDUCTION_FIELDS = [
  'basicDeduction',
  'socialInsurance',
  'lifeInsurance',
  'medical',
  'spouseDependents',
  'otherDeductions',
] as const

export interface IncomeTaxReturnCalcInput {
  /** 合計所得金額（事業所得単独前提では青色決算書 所得金額㊺）。 */
  totalIncome: Yen
  /** 所得控除の入力内訳。 */
  deductions: IncomeTaxDeductionInputs
  /** 源泉徴収税額。 */
  withholding: Yen
  /** 予定納税額。 */
  estimatedPrepaid: Yen
  /** 速算表（既定は令和。税制改正の外部データ化 PRD R-3 と整合）。 */
  brackets?: readonly IncomeTaxBracket[]
}

export interface IncomeTaxReturnCalc {
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
  /** 申告納税額の生値（㊾。百円未満切捨て**前**・負＝還付）。描画層はこれを参照し再計算しない。 */
  payableRaw: Yen
  /** 申告納税額（納付。百円未満切捨て。還付の場合は0）。 */
  payable: Yen
  /** 還付される税金（payableRaw が負のときの絶対額。納付の場合は0）。 */
  refund: Yen
}

/**
 * 確定申告書 第一表の数列計算（純関数・form-mapping §2）:
 *   課税所得 = max(0, 合計所得 − 控除合計)（千円未満切捨て）
 *   → 所得税額（速算表）→ 復興税（×2.1%）→ − 源泉 − 予定納税
 *   → 申告納税額（百円未満切捨て。負＝還付）
 * DB 組成（控除入力の load・源泉の帳簿集計）は server 側（taxreturn/incomeTax.ts）の責務。
 * ⚠️ legalRisk:high — 端数規約・納付/還付分岐は税理士サインオフ対象（ゴールデンテストで固定）。
 */
export function computeIncomeTaxReturn(input: IncomeTaxReturnCalcInput): IncomeTaxReturnCalc {
  const totalDeductions = DEDUCTION_FIELDS.reduce<number>((s, k) => s + input.deductions[k], 0)
  const taxableIncome = floor1000(Math.max(0, input.totalIncome - totalDeductions))

  const baseTax = incomeTax(yen(taxableIncome), input.brackets ?? INCOME_TAX_BRACKETS_REIWA)
  const surtax = reconstructionSurtax(baseTax)
  const taxWithSurtax = baseTax + surtax

  const payableRaw = taxWithSurtax - input.withholding - input.estimatedPrepaid
  const payable = payableRaw >= 0 ? floor100(payableRaw) : 0
  const refund = payableRaw < 0 ? -payableRaw : 0

  return {
    totalDeductions: yen(totalDeductions),
    taxableIncome: yen(taxableIncome),
    baseTax,
    surtax,
    taxWithSurtax: yen(taxWithSurtax),
    payableRaw: yen(payableRaw),
    payable: yen(payable),
    refund: yen(refund),
  }
}

/** 報酬・料金の源泉徴収（accounting-spec §5.1）。税制改正で変わる→外部データ化。 */
export const WITHHOLDING_THRESHOLD = 1_000_000
export const WITHHOLDING_RATE_BASE = 0.1021 // 100万円以下（復興特別所得税込）
export const WITHHOLDING_RATE_OVER = 0.2042 // 100万円超の部分

/**
 * 報酬・料金の源泉徴収税額（accounting-spec §5.1・1円未満切捨て）。
 *   = min(base, 100万) × 10.21% + max(base − 100万, 0) × 20.42%
 * base は源泉計算の基礎（消費税が請求書で区分されていれば本体、なければ税込）。
 */
export function rewardWithholding(base: Yen): Yen {
  if (base <= 0) return yen(0)
  const lower = Math.min(base, WITHHOLDING_THRESHOLD)
  const upper = Math.max(base - WITHHOLDING_THRESHOLD, 0)
  return yen(Math.floor(lower * WITHHOLDING_RATE_BASE + upper * WITHHOLDING_RATE_OVER))
}
