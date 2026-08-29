import { parseCsv } from '@kanean/shared'
import { parseAmount, parseDateIso, toHankaku } from '../normalize.js'
import { type ParsedRowDraft, type ParseResult, type ParseError, withDedupHashes } from '../types.js'

/**
 * 三菱UFJ-VISA カード利用明細（card_mufg_visa・Shift_JIS）。csv-format §2。
 * ヘッダ: 確定情報,お支払日,ご利用店名,ご利用日,支払回数,何回目,ご利用金額,現地通貨額…
 * 取引行・見出し行・注記行・登録番号行が混在する。
 * 取引日=ご利用日（発生主義）。direction は out 固定。
 * 支払回数/何回目は raw_payload に保持。dedup_hash には用いない（連番が無く同日同店同額が衝突する
 * 既知バグを、出現インデックス方式・types.withDedupHashes で解消）。
 */
export interface CardParseOptions {
  /** 未確定行も取り込む（既定 false＝確定のみ。§2.4）。 */
  includeUnconfirmed?: boolean
}

export function parseCardMufgVisa(text: string, options: CardParseOptions = {}): ParseResult {
  const rows = parseCsv(text)
  const out: ParsedRowDraft[] = []
  const errors: ParseError[] = []
  rows.forEach((cols, i) => {
    if (cols.length < 7) return
    const status = cols[0]?.trim() ?? ''
    const usageDateRaw = cols[3]?.trim() ?? ''
    const shop = cols[2] ?? ''

    // 取引行の判定（日付の解釈可否では分類しない）: 確定情報が 確定/未確定 かつ ご利用日が非空。
    // 見出し・注記・登録番号行は 確定情報 が空 or ご利用日が空＝取引行でない＝スキップ（エラーにしない）。
    if (status !== '確定' && status !== '未確定') return
    if (status === '未確定' && !options.includeUnconfirmed) return
    if (usageDateRaw === '') return
    // ここまでで取引行。日付・金額の解釈失敗はエラーとして退避し silent drop を防ぐ（部分取込・C-9、銀行パーサと対称）。
    try {
      const txnDate = parseDateIso(usageDateRaw)
      const amount = parseAmount(cols[6])
      if (amount === 0) return
      const description = toHankaku(shop).trim()
      out.push({ txnDate, amount, direction: 'out', description, rawPayload: JSON.stringify(cols) })
    } catch (err) {
      errors.push({ rowNo: i + 1, raw: JSON.stringify(cols), message: (err as Error).message })
    }
  })
  return { rows: withDedupHashes(out), errors }
}
