import { type Yen, yen, applyRate, rateFraction } from '@kanean/shared'

/**
 * 減価償却（定額法・新定額法）。depreciation-spec §2。
 * - 償却費は取得価額基準（期首帳簿価額基準ではない）。
 * - 初年度は供用月数で月割。
 * - 最終年は備忘価額1円を残す。
 * - 事業利用比率は「必要経費算入額」にのみ効く（未償却残高は全額で減らす）。
 *   按分は家事按分(§6)と同じ規約: 家事分を円未満切捨て、必要経費＝償却費−家事分。
 *   （検算: マツダ2 償却439,919・事業50% → 家事分 floor(219,959.5)=219,959 → 経費220,…=219,960）
 */

/** §3 定額法償却率表（抜粋）。外部データ化対象（PRD R-3・耐用年数省令）。 */
export const STRAIGHT_LINE_RATES: Readonly<Record<number, number>> = {
  2: 0.5,
  3: 0.334,
  4: 0.25,
  5: 0.2,
  6: 0.167,
  7: 0.143,
  8: 0.125,
  9: 0.112,
  10: 0.1,
  15: 0.067,
  20: 0.05,
}

/** 耐用年数 → 定額法償却率。未収載は外部データ要。 */
export function straightLineRate(usefulLifeYears: number): number {
  const rate = STRAIGHT_LINE_RATES[usefulLifeYears]
  if (rate === undefined) {
    throw new RangeError(`定額法償却率が未定義: 耐用年数 ${usefulLifeYears}年（要外部データ）`)
  }
  return rate
}

/** 備忘価額（除却まで残す1円）。 */
export const MEMO_VALUE: Yen = yen(1)

export interface StraightLineYearInput {
  /** 取得価額（償却費の基準）。 */
  acquisitionCost: Yen
  /** 定額法償却率（例: 耐用年数6年 → 0.167）。 */
  rate: number
  /** 期首未償却残高（初年度は取得価額）。 */
  openingBookValue: Yen
  /** 事業利用比率 0..100（%整数。家事按分 business_ratio と統一）。 */
  businessUseRatio: number
  /** 初年度の供用月数 1..12（既定12）。端数日は1月に切上げ済みの値を渡す。 */
  monthsInService?: number
}

export interface DepreciationYear {
  /** 本年分償却費（全額）。 */
  depreciationAmount: Yen
  /** 必要経費算入額（按分後）。 */
  businessAmount: Yen
  /** 家事分（経費不算入）。 */
  householdAmount: Yen
  /** 期末未償却残高（全額償却後）。 */
  closingBookValue: Yen
}

/** 定額法・1年分の償却を計算する。 */
export function straightLineYear(input: StraightLineYearInput): DepreciationYear {
  const { acquisitionCost, rate, openingBookValue, businessUseRatio } = input
  const months = input.monthsInService ?? 12
  if (months < 1 || months > 12) {
    throw new RangeError(`monthsInService は 1..12（got ${months}）`)
  }
  if (!Number.isInteger(businessUseRatio) || businessUseRatio < 0 || businessUseRatio > 100) {
    throw new RangeError(`businessUseRatio は 0..100 の整数（got ${businessUseRatio}）`)
  }

  // 通常年の償却費（取得価額×償却率）。
  // 全年は円未満切捨て（§9）。初年度の月割は**円未満切上げ**（実データ準拠：
  // マツダ2 初年度 1,508,300×0.5×5/12=314,229.17 → 314,230）。
  // 率は整数分数（例 0.143 → 143/1000）に直して applyRate で計算する。float 乗算は
  // 0.143 等（二進で表現不能な公示率）で1円ズレる（floor(3000*0.143)=428、正値 429）。
  const { num, den } = rateFraction(rate)
  const raw =
    months === 12
      ? applyRate(acquisitionCost, num, den, 'floor')
      : applyRate(acquisitionCost, num * months, den * 12, 'ceil')

  // 備忘1円を割らないよう上限。最終年は openingBookValue−1 まで（§2.3）。
  const maxDeductible = Math.max(0, openingBookValue - 1)
  const depreciationAmount = yen(Math.min(raw, maxDeductible))

  // 按分は §6 と同じ: 家事分を切捨て、必要経費＝償却費−家事分（実データ準拠）。
  // 整数 (100 − 事業%)/100 で按分し桁落ちを避ける（1 − 0.8 = 0.199… の1円ズレ回避）。
  const householdAmount = applyRate(depreciationAmount, 100 - businessUseRatio, 100, 'floor')
  const businessAmount = yen(depreciationAmount - householdAmount)

  const closingBookValue = yen(openingBookValue - depreciationAmount)
  return { depreciationAmount, businessAmount, householdAmount, closingBookValue }
}

export interface StraightLineScheduleInput {
  acquisitionCost: Yen
  rate: number
  /** 事業利用比率 0..100（%整数）。 */
  businessUseRatio: number
  /** 初年度の供用月数 1..12。 */
  firstYearMonths: number
  /** 暴走防止の上限年数（既定100）。 */
  maxYears?: number
}

/**
 * 一括償却資産（depreciation-spec §5）。取得価額10万円以上20万円未満を選択した場合。
 * - 取得価額 × 1/3 を3年均等（**月割しない**）。
 * - 3年で全額償却（残高0・備忘1円を残さない）。
 * - 事業利用比率の按分は行わない（全額が経費。§5）。
 * 端数: 1〜2年目は floor(取得価額/3)、3年目が残額を吸収して残高0。
 */
export function lumpSumSchedule(acquisitionCost: Yen): DepreciationYear[] {
  const base = Math.floor(acquisitionCost / 3)
  const years: DepreciationYear[] = []
  let opening = acquisitionCost
  for (let i = 0; i < 3; i++) {
    const dep = i < 2 ? Math.min(base, opening) : opening // 3年目は残額（端数吸収→0）
    const closing = yen(opening - dep)
    years.push({ depreciationAmount: yen(dep), businessAmount: yen(dep), householdAmount: yen(0), closingBookValue: closing })
    opening = closing
  }
  return years
}

/**
 * 少額減価償却資産特例（depreciation-spec §6・措法28の2）。青色・中小、取得価額30万円未満。
 * 取得年に全額を必要経費に算入（残高0）。事業利用比率で按分（必要経費＝取得価額×事業%）。
 * ⚠️ 年間合計300万円の上限は**資産横断**のため呼び出し側（postDepreciation）で判定する。
 */
export function minorSpecialYear(acquisitionCost: Yen, businessUseRatio: number): DepreciationYear {
  if (!Number.isInteger(businessUseRatio) || businessUseRatio < 0 || businessUseRatio > 100) {
    throw new RangeError(`businessUseRatio は 0..100 の整数（got ${businessUseRatio}）`)
  }
  const householdAmount = applyRate(acquisitionCost, 100 - businessUseRatio, 100, 'floor')
  const businessAmount = yen(acquisitionCost - householdAmount)
  return { depreciationAmount: acquisitionCost, businessAmount, householdAmount, closingBookValue: yen(0) }
}

/** 取得から備忘1円に到達するまでの定額法償却スケジュールを生成する。 */
export function straightLineSchedule(input: StraightLineScheduleInput): DepreciationYear[] {
  const years: DepreciationYear[] = []
  const cap = input.maxYears ?? 100
  let opening = input.acquisitionCost
  let first = true
  while (opening > MEMO_VALUE && years.length < cap) {
    const year = straightLineYear({
      acquisitionCost: input.acquisitionCost,
      rate: input.rate,
      openingBookValue: opening,
      businessUseRatio: input.businessUseRatio,
      monthsInService: first ? input.firstYearMonths : 12,
    })
    years.push(year)
    opening = year.closingBookValue
    first = false
  }
  return years
}

/**
 * 定率法（200%定率法）— depreciation-spec §4。対象: 2012/4/1 以後取得。
 * - 通常年: 償却費 = 期首帳簿価額 × 定率法償却率（取得価額基準ではなく**残高基準**）。
 * - 調整前償却額（期首帳簿価額×償却率）が **償却保証額（取得価額×保証率）** を下回った
 *   年以降は、その年の期首帳簿価額を **改定取得価額** として固定し、以後
 *   `改定取得価額 × 改定償却率` を毎年均等に償却する（1円まで）。
 * - 初年度の月割・事業利用比率の按分・備忘1円の扱いは定額法と同じ（§2.2〜2.4・§9）。
 *
 * 償却率・改定償却率・保証率は耐用年数別の外部データ（§3/§4・国税庁別表第十）。
 * ⚠️ legalRisk:high（税制改正で変わりうる。税理士サインオフ対象）。
 */
export interface DecliningBalanceRate {
  /** 定率法償却率（2/耐用年数 を小数3桁に丸めた公示値。丸め済み定額法償却率の単純2倍ではない）。 */
  rate: number
  /** 改定償却率（改定取得価額に乗じる。改定不要な耐用年数2年は null）。 */
  revisedRate: number | null
  /** 保証率（償却保証額 = 取得価額 × 保証率。耐用年数2年は null）。 */
  guaranteeRate: number | null
}

/**
 * §4 定率法（200%定率法・平成24年4月1日以後取得）の償却率等表（耐用年数2〜20年）。
 * 出典: 国税庁「減価償却資産の償却率等表」別表第十。実装では有効期間付き外部データ化が望ましい
 * （PRD R-3）。**この値は税理士サインオフ対象（legalRisk:high）。**
 * 耐用年数2年は償却率1.000で初年度に備忘1円まで償却するため改定償却率・保証率を持たない。
 */
export const DECLINING_BALANCE_RATES: Readonly<Record<number, DecliningBalanceRate>> = {
  2: { rate: 1.0, revisedRate: null, guaranteeRate: null },
  3: { rate: 0.667, revisedRate: 1.0, guaranteeRate: 0.11089 },
  4: { rate: 0.5, revisedRate: 1.0, guaranteeRate: 0.12499 },
  5: { rate: 0.4, revisedRate: 0.5, guaranteeRate: 0.108 },
  6: { rate: 0.333, revisedRate: 0.334, guaranteeRate: 0.09911 },
  7: { rate: 0.286, revisedRate: 0.334, guaranteeRate: 0.0868 },
  8: { rate: 0.25, revisedRate: 0.334, guaranteeRate: 0.07909 },
  9: { rate: 0.222, revisedRate: 0.25, guaranteeRate: 0.07126 },
  10: { rate: 0.2, revisedRate: 0.25, guaranteeRate: 0.06552 },
  11: { rate: 0.182, revisedRate: 0.2, guaranteeRate: 0.05992 },
  12: { rate: 0.167, revisedRate: 0.2, guaranteeRate: 0.05566 },
  13: { rate: 0.154, revisedRate: 0.167, guaranteeRate: 0.0518 },
  14: { rate: 0.143, revisedRate: 0.167, guaranteeRate: 0.04854 },
  15: { rate: 0.133, revisedRate: 0.143, guaranteeRate: 0.04565 },
  16: { rate: 0.125, revisedRate: 0.143, guaranteeRate: 0.04294 },
  17: { rate: 0.118, revisedRate: 0.125, guaranteeRate: 0.04038 },
  18: { rate: 0.111, revisedRate: 0.112, guaranteeRate: 0.03884 },
  19: { rate: 0.105, revisedRate: 0.112, guaranteeRate: 0.03693 },
  20: { rate: 0.1, revisedRate: 0.112, guaranteeRate: 0.03486 },
}

/** 耐用年数 → 定率法の償却率/改定償却率/保証率。未収載は外部データ要。 */
export function decliningBalanceRate(usefulLifeYears: number): DecliningBalanceRate {
  const r = DECLINING_BALANCE_RATES[usefulLifeYears]
  if (r === undefined) {
    throw new RangeError(`定率法償却率が未定義: 耐用年数 ${usefulLifeYears}年（要外部データ）`)
  }
  return r
}

export interface DecliningBalanceYearInput {
  /** 取得価額（償却保証額の基準）。 */
  acquisitionCost: Yen
  /** 定率法償却率。 */
  rate: number
  /** 改定償却率（保証率なし＝改定に入らない耐用年数では null 可）。 */
  revisedRate: number | null
  /** 保証率（null なら償却保証額0＝改定フェーズに入らない）。 */
  guaranteeRate: number | null
  /** 期首未償却残高（初年度は取得価額）。 */
  openingBookValue: Yen
  /** 事業利用比率 0..100（%整数）。 */
  businessUseRatio: number
  /** 初年度の供用月数 1..12（既定12）。端数日は1月に切上げ済みの値を渡す。 */
  monthsInService?: number
  /**
   * 既に改定償却フェーズに入っている場合の改定取得価額（突入年の期首帳簿価額で固定）。
   * 通常フェーズなら null。schedule が前年から引き継ぐ。
   */
  revisedBase?: Yen | null
}

export interface DecliningBalanceYear extends DepreciationYear {
  /** 翌年へ引き継ぐ改定取得価額（通常フェーズなら null）。 */
  revisedBase: Yen | null
}

/** 定率法・1年分の償却を計算する（改定取得価額への切替判定を含む）。 */
export function decliningBalanceYear(input: DecliningBalanceYearInput): DecliningBalanceYear {
  const { acquisitionCost, rate, revisedRate, guaranteeRate, openingBookValue, businessUseRatio } = input
  const months = input.monthsInService ?? 12
  if (months < 1 || months > 12) {
    throw new RangeError(`monthsInService は 1..12（got ${months}）`)
  }
  if (!Number.isInteger(businessUseRatio) || businessUseRatio < 0 || businessUseRatio > 100) {
    throw new RangeError(`businessUseRatio は 0..100 の整数（got ${businessUseRatio}）`)
  }

  // 満額年は円未満切捨て、月割年（初年度・除却年度）は円未満切上げ（§9）。
  // 率は整数分数に直して applyRate で計算する（float 乗算は二進で表現不能な公示率で1円ズレる）。
  const portion = (base: Yen, r: { num: number; den: number }): number =>
    months === 12 ? applyRate(base, r.num, r.den, 'floor') : applyRate(base, r.num * months, r.den * 12, 'ceil')
  const rateFrac = rateFraction(rate)
  const revisedFrac = rateFraction(revisedRate ?? 0)

  let revisedBase = input.revisedBase ?? null
  let limit: number
  if (revisedBase != null) {
    // 既に改定フェーズ: 改定取得価額 × 改定償却率（以後均等。除却年度の期中は月割）。
    limit = portion(revisedBase, revisedFrac)
  } else {
    // 改定フェーズ判定: 調整前償却額（期首×償却率） < 償却保証額（取得価額×保証率）。
    // float 同士の比較は境界年で揺れうるため、分母を払った整数比較を BigInt で正確に行う。
    //   期首×(rn/rd) < 取得×(gn/gd)  ⇔  期首×rn×gd < 取得×gn×rd
    let enterRevised = false
    if (guaranteeRate != null) {
      const g = rateFraction(guaranteeRate)
      enterRevised =
        BigInt(openingBookValue) * BigInt(rateFrac.num) * BigInt(g.den) <
        BigInt(acquisitionCost) * BigInt(g.num) * BigInt(rateFrac.den)
    }
    if (!enterRevised) {
      // 通常フェーズ。初年度は供用月数で月割、満額年は切捨て（§9）。
      limit = portion(openingBookValue, rateFrac)
    } else {
      // 改定フェーズ突入: この年の期首帳簿価額を改定取得価額として固定（除却年度の期中は月割）。
      revisedBase = openingBookValue
      limit = portion(revisedBase, revisedFrac)
    }
  }

  // 備忘1円を割らないよう上限（最終年は openingBookValue−1 まで。§2.3）。
  const maxDeductible = Math.max(0, openingBookValue - 1)
  const depreciationAmount = yen(Math.min(limit, maxDeductible))

  // 按分は §2.4・§6 と統一: 家事分を切捨て、必要経費＝償却費−家事分。
  const householdAmount = applyRate(depreciationAmount, 100 - businessUseRatio, 100, 'floor')
  const businessAmount = yen(depreciationAmount - householdAmount)
  const closingBookValue = yen(openingBookValue - depreciationAmount)
  return { depreciationAmount, businessAmount, householdAmount, closingBookValue, revisedBase }
}

export interface DecliningBalanceScheduleInput {
  acquisitionCost: Yen
  rate: number
  revisedRate: number | null
  guaranteeRate: number | null
  /** 事業利用比率 0..100（%整数）。 */
  businessUseRatio: number
  /** 初年度の供用月数 1..12。 */
  firstYearMonths: number
  /** 暴走防止の上限年数（既定100）。 */
  maxYears?: number
}

/**
 * 中古資産の簡便法による見積耐用年数（耐用年数省令 §3・国税庁 No.5404）。depreciation-spec §3.1。
 * - 法定耐用年数の全部を経過: 法定耐用年数 × 20%
 * - 一部を経過: （法定耐用年数 − 経過年数）＋ 経過年数 × 20%
 * - 1年未満の端数は切捨て、2年未満は2年。経過は月数で計算してから年に換算する。
 *
 * 浮動小数点を避けるため「×0.2 = ÷5」を用いて月数×5（=fiveMonths）の整数で計算し、最後に
 * floor(fiveMonths / 60) で年に換算する（60 = 12ヶ月 × 5）。
 * 例: 法定6年(72月)・経過46月 → (72−46)+46×0.2 = 35.2月 → 2.93年 → 切捨て2年（マツダ2 相当）。
 * ⚠️ legalRisk:high（中古資産の耐用年数算定は税理士サインオフ対象）。
 */
export function usedAssetUsefulLife(legalUsefulLifeYears: number, elapsedMonths: number): number {
  if (!Number.isInteger(legalUsefulLifeYears) || legalUsefulLifeYears < 1) {
    throw new RangeError(`法定耐用年数は1以上の整数（got ${legalUsefulLifeYears}）`)
  }
  if (!Number.isInteger(elapsedMonths) || elapsedMonths < 0) {
    throw new RangeError(`経過月数は0以上の整数（got ${elapsedMonths}）`)
  }
  const legalMonths = legalUsefulLifeYears * 12
  // 見積月数 × 5（整数）。全部経過は 法定月数×0.2×5 = 法定月数。
  const fiveMonths =
    elapsedMonths >= legalMonths ? legalMonths : 5 * (legalMonths - elapsedMonths) + elapsedMonths
  const years = Math.floor(fiveMonths / 60) // ÷12（年換算）かつ ÷5（×0.2の戻し）で 1年未満切捨て
  return Math.max(2, years) // 2年未満は2年
}

export interface RetirementYearInput {
  /** 償却方法（定額法 / 定率法。一括償却・少額特例は残高/月割の扱いが異なるため対象外）。 */
  method: 'straight_line' | 'declining_balance'
  acquisitionCost: Yen
  rate: number
  /** 定率法の改定償却率（定額法では無視）。 */
  revisedRate?: number | null
  /** 定率法の保証率（定額法では無視）。 */
  guaranteeRate?: number | null
  /** 事業利用比率 0..100（%整数）。 */
  businessUseRatio: number
  /** 供用初年度の月数（1..12）。 */
  firstYearMonths: number
  /** 除却する年度のインデックス（0 = 供用初年度に除却）。 */
  retirementYearIndex: number
  /** 除却年度の償却月数（期首〜除却月、1..12）。 */
  retirementMonths: number
  /** 暴走防止の上限年数（既定100）。 */
  maxYears?: number
}

/**
 * 除却年度の月割償却（depreciation-spec §7）。通常スケジュールを除却年度の手前まで進めて
 * 期首未償却残高（定率法は改定取得価額の状態も）を求め、**除却年度だけ retirementMonths で
 * 月割**した1年分の DepreciationYear を返す。月割の端数は通常の初年度月割と同じく円未満切上げ（§9）。
 * 除却年度が償却終了後（期首が既に備忘1円以下）なら null＝当期償却なし（残りの備忘価額は除却損へ）。
 * 一括償却(lump_sum)・少額特例(minor_special)は対象外（呼び出し側で処理）。
 */
export function retirementYearDepreciation(input: RetirementYearInput): DepreciationYear | null {
  const cap = input.maxYears ?? 100
  if (!Number.isInteger(input.retirementYearIndex) || input.retirementYearIndex < 0) {
    throw new RangeError(`retirementYearIndex は 0 以上の整数（got ${input.retirementYearIndex}）`)
  }
  if (input.retirementMonths < 1 || input.retirementMonths > 12) {
    throw new RangeError(`retirementMonths は 1..12（got ${input.retirementMonths}）`)
  }
  if (input.retirementYearIndex >= cap) return null
  let opening: Yen = input.acquisitionCost
  let revisedBase: Yen | null = null
  for (let i = 0; i <= input.retirementYearIndex; i++) {
    if (opening <= MEMO_VALUE) return null // 既に償却し切っている（備忘1円）
    const isRetireYear = i === input.retirementYearIndex
    // 除却年度は月割。それ以外は通常（初年度は供用月数、以降は12ヶ月）。
    const months = isRetireYear ? input.retirementMonths : i === 0 ? input.firstYearMonths : 12
    if (input.method === 'straight_line') {
      const y = straightLineYear({
        acquisitionCost: input.acquisitionCost,
        rate: input.rate,
        openingBookValue: opening,
        businessUseRatio: input.businessUseRatio,
        monthsInService: months,
      })
      if (isRetireYear) return y
      opening = y.closingBookValue
    } else {
      const y = decliningBalanceYear({
        acquisitionCost: input.acquisitionCost,
        rate: input.rate,
        revisedRate: input.revisedRate ?? null,
        guaranteeRate: input.guaranteeRate ?? null,
        openingBookValue: opening,
        businessUseRatio: input.businessUseRatio,
        monthsInService: months,
        revisedBase,
      })
      if (isRetireYear) {
        return {
          depreciationAmount: y.depreciationAmount,
          businessAmount: y.businessAmount,
          householdAmount: y.householdAmount,
          closingBookValue: y.closingBookValue,
        }
      }
      revisedBase = y.revisedBase
      opening = y.closingBookValue
    }
  }
  return null
}

/** 取得から備忘1円に到達するまでの定率法償却スケジュールを生成する。 */
export function decliningBalanceSchedule(input: DecliningBalanceScheduleInput): DepreciationYear[] {
  const years: DepreciationYear[] = []
  const cap = input.maxYears ?? 100
  let opening = input.acquisitionCost
  let revisedBase: Yen | null = null
  let first = true
  while (opening > MEMO_VALUE && years.length < cap) {
    const y = decliningBalanceYear({
      acquisitionCost: input.acquisitionCost,
      rate: input.rate,
      revisedRate: input.revisedRate,
      guaranteeRate: input.guaranteeRate,
      openingBookValue: opening,
      businessUseRatio: input.businessUseRatio,
      monthsInService: first ? input.firstYearMonths : 12,
      revisedBase,
    })
    // 改定取得価額は内部状態なので DepreciationYear だけを公開する。
    years.push({
      depreciationAmount: y.depreciationAmount,
      businessAmount: y.businessAmount,
      householdAmount: y.householdAmount,
      closingBookValue: y.closingBookValue,
    })
    revisedBase = y.revisedBase
    opening = y.closingBookValue
    first = false
  }
  return years
}

/**
 * 「ロ 償却の基礎になる金額」（青色決算書3ページ 減価償却の計算・issue #113 = A8）。
 * - 定額法・一括償却・少額特例: 取得価額
 * - 定率法（旧含む）: 期首未償却残高
 * - 旧定額法: 取得価額の 90%（平成19年3月31日以前取得の税法規約。×0.9 の float 乗算ではなく
 *   整数分数の applyRate で計算する — 端数は四捨五入）
 * 税法規約なので PDF 描画層ではなくここ（core）に置く。未知の方法は定額系に倒す
 * （台帳表示のみ対応の方法が増えても様式が空欄にならないための安全側）。
 */
export function depreciationBasis(method: string, acquisitionCost: Yen, openingBookValue: Yen): Yen {
  switch (method) {
    case 'declining_balance':
    case 'old_declining_balance':
      return openingBookValue
    case 'old_straight_line':
      return applyRate(acquisitionCost, 9, 10, 'round')
    default:
      return acquisitionCost
  }
}
