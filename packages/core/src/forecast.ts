import { type Yen, yen, applyRate } from '@kanean/shared'

/**
 * 納税予測・期中 what-if シミュレーション（roadmap の差別化機能）の純関数群。
 *
 * 期中実績の年換算（annualizeIncome）と、所得税以外の概算税目（住民税・個人事業税）を持つ。
 * 所得税・復興税は computeIncomeTaxReturn、消費税は simplifiedTax を組成層（server）が
 * 本モジュールの年換算結果に適用する。
 *
 * ⚠️ legalRisk:medium — いずれも「参考値・税理士確認前」の概算であり申告値には使わない。
 *    住民税・事業税の税率/控除は自治体・業種・税制改正で変わる（PRD R-3 の外部データ化と同課題）。
 */

/**
 * 期中実績の年換算: actualIncome × 12 / elapsedMonths（applyRate の整数按分・floor）。
 *
 * 設計判断: elapsedMonths は 1..12 の整数のみ受け付け、0・12超・非整数は RangeError で弾く。
 * 「入力どおり返す」フォールバックは、組成層のバグ（経過0ヶ月・13ヶ月年度など）を黙って通して
 * 予測額を歪めるため採らない（rateFraction の「黙って近似しない」方針と同じ）。
 * elapsedMonths=12 は恒等（×12/12）。負の実績（期中赤字）もそのまま年換算する（floor は −∞ 方向）。
 */
export function annualizeIncome(actualIncome: Yen, elapsedMonths: number): Yen {
  if (!Number.isInteger(elapsedMonths) || elapsedMonths < 1 || elapsedMonths > 12) {
    throw new RangeError(`elapsedMonths は 1..12 の整数を要求（got ${elapsedMonths}）`)
  }
  return applyRate(actualIncome, 12, elapsedMonths, 'floor')
}

/** 住民税所得割の標準税率（%。市町村民税6%＋道府県民税4%）。 */
export const RESIDENT_TAX_RATE_PERCENT = 10
/** 住民税均等割の概算額（円。均等割4,000円＋森林環境税1,000円。自治体の超過課税は考慮しない）。 */
export const RESIDENT_TAX_PER_CAPITA = yen(5_000)

/**
 * 住民税の概算: 所得割（課税所得 × 10%・floor）＋均等割 5,000円。
 *
 * 概算前提: 課税所得は**所得税の課税所得をそのまま**使う。実際は基礎控除が
 * 所得税48万円 vs 住民税43万円と異なり（調整控除等もある）住民税側がやや大きくなるが、
 * 参考値の概算として同一課税所得で計算する（差は数千円オーダー）。
 * taxableIncome <= 0 は非課税とみなし均等割も含めて 0（非課税限度額の細則判定は行わない）。
 */
export function estimateResidentTax(taxableIncome: Yen): Yen {
  if (taxableIncome <= 0) return yen(0)
  return yen(applyRate(taxableIncome, RESIDENT_TAX_RATE_PERCENT, 100, 'floor') + RESIDENT_TAX_PER_CAPITA)
}

/** 個人事業税の事業主控除（年額290万円）。 */
export const BUSINESS_TAX_OWNER_DEDUCTION = yen(2_900_000)
/** 個人事業税の標準税率（%。第1種事業ほか大半の業種＝5%）。 */
export const BUSINESS_TAX_RATE_PERCENT = 5

/**
 * 個人事業税の概算: max(0, 事業所得 − 事業主控除290万円) × rate%（floor）。マイナスは0。
 *
 * 概算前提:
 * - businessIncome は**青色申告特別控除前**の事業所得（㊸相当）を渡す（事業税に青色控除の適用はない）。
 * - rate は % の整数（既定5。畜産業等は4、あん摩・マッサージ等は3）。非整数は applyRate が
 *   RangeError で弾く（黙って近似しない）。
 * - 事業主控除は年額固定。年の中途開業の月割りや繰越控除は概算では行わない。
 */
export function estimateBusinessTax(businessIncome: Yen, rate: number = BUSINESS_TAX_RATE_PERCENT): Yen {
  const base = Math.max(0, businessIncome - BUSINESS_TAX_OWNER_DEDUCTION)
  if (base === 0) return yen(0)
  return applyRate(yen(base), rate, 100, 'floor')
}
