import { type Yen, yen, applyRate, type Rounding } from '@kanean/shared'

/**
 * 消費税（簡易課税）。accounting-spec §3。
 * 税率ごと（10%/8%）に区分して計算し合算する。本利用者は第5種（みなし50%）。
 *
 * ⚠️ 申告様式上の端数（課税標準額の千円未満切捨て・差引税額の百円未満切捨て）は
 *    本実装で百円未満切捨てを差引国税・地方に適用する。課税標準額は税抜額を受け取る前提。
 *    正確な様式準拠は申告書様式の検証で確定（要ゴールデンデータ）。
 */

export type SimplifiedCategory = 1 | 2 | 3 | 4 | 5 | 6

/** 事業区分別みなし仕入率（§3.1）。表示用の小数表現。**計算には使わない**（下の % 整数表を使う）。 */
export const DEEMED_PURCHASE_RATE: Readonly<Record<SimplifiedCategory, number>> = {
  1: 0.9,
  2: 0.8,
  3: 0.7,
  4: 0.6,
  5: 0.5,
  6: 0.4,
}

/**
 * みなし仕入率の % 整数表現（applyRate 用）。float 乗算 `salesTax * 0.7` は第3種で
 * 1円過少になる（floor(90*0.7)=62、正値 90×7/10=63）ため、整数按分で計算する。
 */
const DEEMED_PURCHASE_PERCENT: Readonly<Record<SimplifiedCategory, number>> = {
  1: 90,
  2: 80,
  3: 70,
  4: 60,
  5: 50,
  6: 40,
}

export type TaxRate = 10 | 8

/**
 * 税込金額から内税を逆算する（accounting-spec §4.2）。
 *   tax = 金額 − 金額 ÷ (1 + rate/100) = 金額 × rate / (100 + rate)
 * 整数 num/den 按分（applyRate）で桁落ちなく算出。端数は呼び出し側設定（既定 floor）。
 * rate<=0（非課税/対象外）は 0。
 */
export function inclusiveTax(grossTaxIncluded: Yen, rate: number, rounding: Rounding = 'floor'): Yen {
  if (rate <= 0) return yen(0)
  return applyRate(grossTaxIncluded, rate, 100 + rate, rounding)
}

/**
 * 税抜（本体）金額から消費税額を算出する（税抜経理・§4.2）。
 *   tax = 本体 × rate/100
 */
export function exclusiveTax(base: Yen, rate: number, rounding: Rounding = 'floor'): Yen {
  if (rate <= 0) return yen(0)
  return applyRate(base, rate, 100, rounding)
}

/**
 * 税抜課税標準額に対する国税・地方の率（§2.3）。10%=国7.8/地2.2、8%=国6.24/地1.76。
 * 8% は**軽減税率**（恒久制度、飲食料品・定期新聞）の内訳。旧標準8%(6.3/1.7)は現行非対象。
 * 表示用の小数表現。**計算には使わない**（nationalTaxOf の整数分数を使う）。
 */
export const RATE_SPLIT: Readonly<Record<TaxRate, { national: number; local: number }>> = {
  10: { national: 0.078, local: 0.022 },
  8: { national: 0.0624, local: 0.0176 },
}

const TAX_RATES: TaxRate[] = [10, 8]

/** 国税割合の整数分数表現（applyRate 用）。10% → 7.8% = 78/1000、軽減8% → 6.24% = 624/10000。 */
const NATIONAL_FRACTION: Readonly<Record<TaxRate, { num: number; den: number }>> = {
  10: { num: 78, den: 1000 },
  8: { num: 624, den: 10000 },
}

/**
 * 税抜額（課税標準・返還等対価・貸倒れ）に税率別の国税割合を適用する（円未満切捨て）。
 * 第一表（simplifiedTax の売上税額）と付表4-3/5-3（server の税率別行・返還/貸倒れの国税換算）の
 * **単一真実源**。丸め規約（floor）や按分方式の変更は必ず本関数で行うこと —
 * 実装が core/server に分かれると第一表と付表が黙って乖離する。
 * 整数按分（applyRate）で計算する。float 式 floor(net×0.078) とは 0..1億円の全数で
 * 一致を検証済み（置換による値の変化なし）。
 */
export function nationalTaxOf(net: Yen, rate: TaxRate): Yen {
  const f = NATIONAL_FRACTION[rate]
  return applyRate(net, f.num, f.den, 'floor')
}

export interface SimplifiedTaxInput {
  category: SimplifiedCategory
  /** 税率別の課税標準額（税抜）。 */
  base: Partial<Record<TaxRate, Yen>>
  /** 税率別の返還等対価に係る国税額（任意）。 */
  returnsNational?: Partial<Record<TaxRate, Yen>>
  /** 税率別の貸倒れに係る国税額（任意）。 */
  badDebtNational?: Partial<Record<TaxRate, Yen>>
}

export interface SimplifiedTaxResult {
  /** 売上に係る消費税額（国税）。 */
  salesTaxNational: Yen
  /** 税率別の売上消費税額（国税・付表4-3/5-3 の行）。合計が salesTaxNational。 */
  salesTaxNationalByRate: Partial<Record<TaxRate, Yen>>
  /** 控除対象仕入税額（みなし）。 */
  deemedDeduction: Yen
  /** 納付税額（国税・百円未満切捨て後）。 */
  national: Yen
  /** 地方消費税（百円未満切捨て後）。 */
  local: Yen
  /** 納付税額（合計）。 */
  total: Yen
}

function floor100(value: number): number {
  return Math.floor(value / 100) * 100
}

function sumByRate(map: Partial<Record<TaxRate, Yen>> | undefined): number {
  if (!map) return 0
  return TAX_RATES.reduce<number>((acc, r) => acc + (map[r] ?? 0), 0)
}

/** 簡易課税の納付税額を計算する（accounting-spec §3.2）。 */
export function simplifiedTax(input: SimplifiedTaxInput): SimplifiedTaxResult {
  const salesTaxNationalByRate: Partial<Record<TaxRate, Yen>> = {}
  let salesTax = 0
  for (const rate of TAX_RATES) {
    const base = input.base[rate]
    if (base) {
      const t = nationalTaxOf(base, rate)
      salesTaxNationalByRate[rate] = t
      salesTax += t
    }
  }

  const deemedDeduction = applyRate(yen(salesTax), DEEMED_PURCHASE_PERCENT[input.category], 100, 'floor')
  const returns = sumByRate(input.returnsNational)
  const badDebt = sumByRate(input.badDebtNational)

  const nationalRaw = Math.max(0, salesTax - deemedDeduction - returns - badDebt)
  const national = floor100(nationalRaw) // 差引国税 百円未満切捨て
  // 地方消費税 = 国税 × 22/78（税率に依らず一定の比）。整数按分（float 式と 0..1億円で一致検証済み）。
  const local = floor100(applyRate(yen(national), 22, 78, 'floor'))

  return {
    salesTaxNational: yen(salesTax),
    salesTaxNationalByRate,
    deemedDeduction: yen(deemedDeduction),
    national: yen(national),
    local: yen(local),
    total: yen(national + local),
  }
}
