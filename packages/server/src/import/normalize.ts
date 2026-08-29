import iconv from 'iconv-lite'

/** 取込の共通正規化（csv-format §0）。 */

/** 全角英数記号→半角、全角スペース→半角スペースに正規化。 */
export function toHankaku(input: string): string {
  return input
    .replace(/[！-～]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ')
}

/** 先頭の BOM を除去。 */
export function stripBom(input: string): string {
  return input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
}

/**
 * バッファを文字列へデコード（C-1）。
 * shift_jis: iconv で UTF-8 化。utf8: BOM 除去。
 */
export function decodeBuffer(buf: Buffer, encoding: 'shift_jis' | 'utf8'): string {
  if (encoding === 'shift_jis') return iconv.decode(buf, 'Shift_JIS')
  return stripBom(buf.toString('utf8'))
}

/** 金額文字列（カンマ・全角・「円」混じり）を整数（円）化。空は0。 */
export function parseAmount(input: string | undefined | null): number {
  if (!input) return 0
  const normalized = toHankaku(input).replace(/[,\s円]/g, '')
  if (normalized === '') return 0
  const n = Number(normalized)
  if (!Number.isFinite(n)) throw new RangeError(`金額として解釈できない: "${input}"`)
  return Math.trunc(n)
}

/**
 * 残高列を整数（円）化。空・解釈不能は null を返す（突合の補助情報なので、
 * 残高が壊れていても取引行そのものは失敗させない＝部分取込 C-9 と整合）。
 */
export function parseBalanceLoose(input: string | undefined | null): number | null {
  const s = (input ?? '').trim()
  if (s === '') return null
  try {
    return parseAmount(s)
  } catch {
    return null
  }
}

/**
 * 日付を ISO8601(YYYY-MM-DD)へ（C-3）。
 * 対応: YYYY/M/D・YYYY/MM/DD（ゼロ埋め）・YYYY年M月D日。
 */
export function parseDateIso(input: string): string {
  const s = toHankaku(input).trim()
  const slash = s.match(/^(\d{4})\/(\d{1,2})\/(\d{1,2})$/)
  if (slash) return iso(slash[1], slash[2], slash[3])
  const kanji = s.match(/^(\d{4})年(\d{1,2})月(\d{1,2})日$/)
  if (kanji) return iso(kanji[1], kanji[2], kanji[3])
  throw new RangeError(`日付として解釈できない: "${input}"`)
}

function iso(y: string, m: string, d: string): string {
  return `${y}-${m.padStart(2, '0')}-${d.padStart(2, '0')}`
}
