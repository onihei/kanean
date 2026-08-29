import { decodeBuffer } from './normalize.js'
import { parseBankUfj } from './parsers/bankUfj.js'
import { parseBankShinsei } from './parsers/bankShinsei.js'
import { parseCardMufgVisa } from './parsers/cardMufgVisa.js'
import { parseWithMapping, type ColumnMappingConfig } from './columnMapping.js'
import { SOURCE_TYPES, isCustomSourceType, type ParseResult, type SourceType } from './types.js'

/** source_type ごとの既定エンコーディング（csv-format C-1）。組込3形式のみ（汎用は config.encoding）。 */
export const SOURCE_ENCODING: Record<SourceType, 'shift_jis' | 'utf8'> = {
  bank_ufj: 'shift_jis',
  card_mufg_visa: 'shift_jis',
  bank_shinsei: 'utf8',
}

/**
 * バッファを source_type に応じてデコード＆パースする（成功行＋失敗行）。
 * - 組込3形式（SOURCE_TYPES）: ハードコードのパーサ＋既定エンコーディング。
 * - ユーザー定義フォーマット（`format:{id}`）: 呼び出し側が解決した列マッピング設定（format）で汎用パース。
 *   設定の encoding でデコードする（DB 非依存に保つため、id→設定の解決は API 層で行い format で渡す）。
 */
export function parseBuffer(sourceType: string, buf: Buffer, format?: ColumnMappingConfig): ParseResult {
  if (isCustomSourceType(sourceType)) {
    if (!format) throw new Error(`フォーマット定義が解決されていません: ${sourceType}`)
    return parseWithMapping(format, decodeBuffer(buf, format.encoding))
  }
  if (!SOURCE_TYPES.includes(sourceType as SourceType)) throw new Error(`未対応の source_type: ${sourceType}`)
  const st = sourceType as SourceType
  return parseText(st, decodeBuffer(buf, SOURCE_ENCODING[st]))
}

/** デコード済みテキストを組込 source_type に応じてパースする（成功行＋失敗行）。 */
export function parseText(sourceType: SourceType, text: string): ParseResult {
  switch (sourceType) {
    case 'bank_ufj':
      return parseBankUfj(text)
    case 'bank_shinsei':
      return parseBankShinsei(text)
    case 'card_mufg_visa':
      return parseCardMufgVisa(text)
    default:
      throw new Error(`未対応の source_type: ${sourceType}`)
  }
}
