import { parseCsv } from '@kanean/shared'
import { parseAmount, parseBalanceLoose, parseDateIso, toHankaku } from '../normalize.js'
import { type ParsedRowDraft, type ParseResult, type ParseError, withDedupHashes } from '../types.js'

/**
 * 三菱UFJ銀行 普通預金（bank_ufj・Shift_JIS）。csv-format §1。
 * ヘッダ: 日付,摘要,摘要内容,支払い金額,預かり金額,差引残高
 * 差引残高は raw_payload に保持（突合用）。dedup_hash には用いない（出現インデックス方式・types.withDedupHashes）。
 * 行単位 try-catch で、解釈できない取引行は errors に退避し残りは取り込む（部分取込・C-9）。
 */
export function parseBankUfj(text: string): ParseResult {
  const rows = parseCsv(text)
  const out: ParsedRowDraft[] = []
  const errors: ParseError[] = []
  rows.forEach((cols, i) => {
    if (cols.length < 6) return
    const [date, summary, summaryDetail, paid, received, balance] = cols
    if (date === '日付' || date.trim() === '') return // ヘッダ/空行
    try {
      const paidAmount = parseAmount(paid)
      const receivedAmount = parseAmount(received)
      if (paidAmount === 0 && receivedAmount === 0) return
      const direction: 'in' | 'out' = paidAmount > 0 ? 'out' : 'in'
      const amount = paidAmount > 0 ? paidAmount : receivedAmount
      const description = [summary, summaryDetail].map((s) => toHankaku(s ?? '').trim()).filter(Boolean).join(' ')
      const txnDate = parseDateIso(date)
      out.push({ txnDate, amount, direction, description, balance: parseBalanceLoose(balance), rawPayload: JSON.stringify(cols) })
    } catch (err) {
      errors.push({ rowNo: i + 1, raw: JSON.stringify(cols), message: (err as Error).message })
    }
  })
  return { rows: withDedupHashes(out), errors }
}
