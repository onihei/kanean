/**
 * 最小の CSV シリアライザ／パーサ（RFC4180 準拠・I/O なしの純関数）。
 * toCsv と parseCsv を対で置く（issue #138 で parseCsv を server/import から移設）。
 * - フィールドに " , CR LF を含む場合のみダブルクォートで囲む。
 * - フィールド内の " は "" にエスケープ。
 * - レコード区切りは CRLF。
 * - null/undefined は空文字、number は String(n)。
 * 文字コード（UTF-8 BOM 等）の付与は呼び出し側（配信層）の責務。
 */

export type CsvValue = string | number | null | undefined

function field(v: CsvValue): string {
  if (v == null) return ''
  const s = String(v)
  return /[",\r\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s
}

export function toCsv(rows: ReadonlyArray<ReadonlyArray<CsvValue>>): string {
  return rows.map((row) => row.map(field).join(',')).join('\r\n')
}

/**
 * 最小の CSV パーサ（RFC4180 準拠）。
 * ダブルクォート囲み・クォート内カンマ/改行・"" エスケープ・CRLF を扱う。
 */
export function parseCsv(input: string): string[][] {
  // 先頭 BOM を除去（UTF-8 BOM 付きCSV対策）。
  const text = input.charCodeAt(0) === 0xfeff ? input.slice(1) : input
  const rows: string[][] = []
  let row: string[] = []
  let field = ''
  let inQuotes = false
  let i = 0

  const pushField = () => {
    row.push(field)
    field = ''
  }
  const pushRow = () => {
    pushField()
    rows.push(row)
    row = []
  }

  while (i < text.length) {
    const ch = text[i]
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"'
          i += 2
          continue
        }
        inQuotes = false
        i++
        continue
      }
      field += ch
      i++
      continue
    }
    if (ch === '"') {
      inQuotes = true
      i++
      continue
    }
    if (ch === ',') {
      pushField()
      i++
      continue
    }
    if (ch === '\r') {
      if (text[i + 1] === '\n') i++
      pushRow()
      i++
      continue
    }
    if (ch === '\n') {
      pushRow()
      i++
      continue
    }
    field += ch
    i++
  }
  // 末尾フィールド/行（最終行に改行が無い場合）
  if (field !== '' || row.length > 0) pushRow()
  return rows
}
