import { readJsonSafe, watermarkFile, writeJsonAtomic } from './paths.js'

/**
 * 「どこまで**連続して**取れているか」の記録（acquisition spec「取得範囲と取りこぼしの防止」）。
 *
 * 差分の起点を「取込済み明細の最大日付」から導くと、人が範囲を限って後ろだけ取り込んだ瞬間に
 * 起点が飛び、あいだが永久に取り込まれない。そこで**連続して取れている終端**を別に持ち、
 * 取得範囲が現在の終端に接している（＝穴を作らない）ときだけ前進させる。
 *
 * 会計データではないので data plane には置かず、`$DATA_DIR/acquisition/watermarks.json` に持つ。
 */
export interface Watermarks {
  [key: string]: string // `${bookId}:${source}` → 連続して取得できている最終日（YYYY-MM-DD）
}

function keyOf(bookId: string, source: string): string {
  return `${bookId}:${source}`
}

export function readWatermarks(dataDir: string): Watermarks {
  // 壊れていたら「まだ何も取れていない」に倒す。前進しすぎるより取り直すほうが安全
  // （書き込みが temp→rename になったので、壊れるのは外部要因のみ）。
  return readJsonSafe<Watermarks>(watermarkFile(dataDir), {})
}

export function getWatermark(dataDir: string, bookId: string, source: string): string | null {
  return readWatermarks(dataDir)[keyOf(bookId, source)] ?? null
}

/**
 * 連続終端を前進させる。**穴を作る前進は行わない**。
 * @returns 実際に前進したか
 */
export function advanceWatermark(
  dataDir: string,
  bookId: string,
  source: string,
  fetched: { since: string; until: string },
): boolean {
  const all = readWatermarks(dataDir)
  const key = keyOf(bookId, source)
  const current = all[key] ?? null
  // 既に連続している終端より後ろから始まる取得は、あいだに未取得の穴を残す → 前進させない
  if (current && fetched.since > nextDay(current)) return false
  if (current && fetched.until <= current) return false
  all[key] = fetched.until
  writeJsonAtomic(watermarkFile(dataDir), all)
  return true
}

export function nextDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + 1)
  return d.toISOString().slice(0, 10)
}

export function prevDay(isoDate: string): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() - 1)
  return d.toISOString().slice(0, 10)
}
