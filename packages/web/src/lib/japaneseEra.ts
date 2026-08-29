/** 和暦（令和）表記。官製様式3枚（所得税・消費税・青色決算書）の年分表記の唯一の出所。 */

/**
 * 令和表記（YYYY-MM-DD もしくは西暦 → 令和N年）。令和元年=2019。
 * 令和より前（〜2018）と読めない入力は空文字＝様式ヘッダを空欄にする（誤った年分を刷らない）。
 */
export function reiwa(dateOrYear: string | number): string {
  const y = typeof dateOrYear === 'number' ? dateOrYear : Number(String(dateOrYear).slice(0, 4))
  if (!y || y < 2019) return ''
  const n = y - 2018
  return n === 1 ? '令和元年' : `令和${n}年`
}
