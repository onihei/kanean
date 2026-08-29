/**
 * 金額は「円」整数で扱う（architecture §7 金額・型の規律）。
 * 浮動小数点を排除するため branded type で誤用を防ぐ。
 */
export type Yen = number & { readonly __brand: 'Yen' }

/** 整数（円）から Yen を作る。非整数・非有限・安全整数域外（±2^53超）はエラー。 */
export function yen(value: number): Yen {
  if (!Number.isSafeInteger(value)) {
    throw new RangeError(`Yen must be a safe integer (got ${value})`)
  }
  return value as Yen
}

/** 端数処理の方向。税額計算・按分で使う（accounting-spec §4.2 / §6）。 */
export type Rounding = 'floor' | 'ceil' | 'round'

/**
 * amount × (num/den) を**整数演算**で按分する（num・den は整数、den>0）。
 * 比率を float で組み立てない（例 `1 - 0.8 = 0.199…` の桁落ち）ため、家事按分・償却・税の
 * パーセント按分で1円ズレが出ない。割り算より先に余りで丸めを判定するので商の float 誤差も影響しない。
 * 例: 家事分 = applyRate(経費, 100 − 事業%, 100, 'floor')。
 */
export function applyRate(amount: Yen, num: number, den: number, rounding: Rounding = 'floor'): Yen {
  if (!Number.isInteger(num) || !Number.isInteger(den) || den <= 0) {
    throw new RangeError(`applyRate は整数 num/den・den>0 を要求（got num=${num} den=${den}）`)
  }
  const n = amount * num
  const q = Math.floor(n / den)
  const r = n - q * den // 0..den-1（n が負でも floor 定義より非負）
  if (r === 0) return yen(q)
  switch (rounding) {
    case 'floor':
      return yen(q)
    case 'ceil':
      return yen(q + 1)
    case 'round':
      return yen(r * 2 >= den ? q + 1 : q)
  }
}

/**
 * 公示の小数率（償却率 0.143、保証率 0.04854 等）を整数分数 {num, den} へ変換する（applyRate 用）。
 * den は 1, 10, …, 100000 のうち最小の正確表現を選ぶ（公示率は最大5桁＝定率法の保証率）。
 * 5桁で正確に表せない率（DB 保持値の桁あふれ等）は RangeError —
 * 黙って近似すると申告金額が変わるため、入力側で弾く（applyRate の契約と整合）。
 */
export function rateFraction(rate: number): { num: number; den: number } {
  if (!Number.isFinite(rate) || rate < 0) {
    throw new RangeError(`rateFraction は 0 以上の有限値を要求（got ${rate}）`)
  }
  for (let den = 1; den <= 100_000; den *= 10) {
    const num = Math.round(rate * den)
    // float の rate は公示の十進値から最大 ~1e-17 ずれる。1e-9 未満なら同一の十進率とみなす。
    if (Math.abs(rate * den - num) < 1e-9) return { num, den }
  }
  throw new RangeError(`率 ${rate} は小数5桁以内で表現できません（公示率は3〜5桁）`)
}
