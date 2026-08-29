import { parseCsv } from '@kanean/shared'
import { parseAmount, parseBalanceLoose, parseDateIso, toHankaku } from '../normalize.js'
import { type ParsedRowDraft, type ParseResult, type ParseError, withDedupHashes } from '../types.js'

/**
 * 新生銀行 普通預金（bank_shinsei・UTF-8 BOM）。csv-format §3。
 * ヘッダ: 取引日,摘要,出金金額,入金金額,残高,メモ
 * 残高は raw_payload に保持（突合用）。dedup_hash には用いない（出現インデックス方式・types.withDedupHashes）。
 * 行単位 try-catch で、解釈できない取引行は errors に退避し残りは取り込む（部分取込・C-9）。
 */
export function parseBankShinsei(text: string): ParseResult {
  const rows = parseCsv(text)
  const out: ParsedRowDraft[] = []
  const errors: ParseError[] = []
  rows.forEach((cols, i) => {
    if (cols.length < 5) return
    const [date, summary, paid, received, balance, memo] = cols
    if (date === '取引日' || date.trim() === '') return
    try {
      const paidAmount = parseAmount(paid)
      const receivedAmount = parseAmount(received)
      if (paidAmount === 0 && receivedAmount === 0) return
      const direction: 'in' | 'out' = paidAmount > 0 ? 'out' : 'in'
      const amount = paidAmount > 0 ? paidAmount : receivedAmount
      const description = [summary, memo].map((s) => toHankaku(s ?? '').trim()).filter(Boolean).join(' ')
      const txnDate = parseDateIso(date)
      out.push({ txnDate, amount, direction, description, balance: parseBalanceLoose(balance), rawPayload: JSON.stringify(cols) })
    } catch (err) {
      errors.push({ rowNo: i + 1, raw: JSON.stringify(cols), message: (err as Error).message })
    }
  })
  return { rows: withDedupHashes(out), errors }
}
