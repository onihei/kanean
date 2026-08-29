import type { ImportEncoding, AmountMapping, ColumnMappingConfig } from '@kanean/shared'
export type { ImportEncoding, AmountMapping, ColumnMappingConfig }
import { parseCsv } from '@kanean/shared'
import { parseAmount, parseBalanceLoose, parseDateIso, toHankaku } from './normalize.js'
import { type ParsedRowDraft, type ParseError, type ParseResult, withDedupHashes } from './types.js'

/**
 * 汎用列マッピング（ユーザー定義フォーマット・roadmap Phase3「対応フォーマット拡充」/ csv-format §8）。
 *
 * 組込3形式（bank_ufj/bank_shinsei/card_mufg_visa）はコードのパーサのまま残し、
 * 「1行=1取引（＋スキップ可能なヘッダ/空行）」型の銀行/カードCSVを、コード変更なしで
 * 列番号マッピング設定だけで取り込めるようにする。複数行種別が混在するカード型
 * （確定/未確定・注記行・登録番号行の分類）は組込 card_mufg_visa が担い、本汎用パーサの対象外。
 *
 * 仕様の要点（csv-format C-1〜C-10 と整合）:
 * - エンコーディングは設定値（shift_jis/utf8）。dispatch がデコードに用いる。
 * - 先頭 headerRows 行はヘッダとしてスキップ。全列空の行も区切り行としてスキップ。
 * - 金額3モード: split(出金/入金別列) / signed(符号付き1列・負=出金) / single(金額列＋方向列)。
 * - 残高列は任意（突合用。壊れていても取引行は失敗させない＝null 化）。
 * - 行単位 try-catch（部分取込・C-9）。取引行と判定できたのに日付/金額が解釈不能なら errors へ退避。
 * - dedup_hash は出現インデックス方式（C-6・withDedupHashes）。
 */

/** 設定の検証エラー（CRUD で 400 にする）。 */
export class ColumnMappingError extends Error {}

function asColIndex(v: unknown, label: string): number {
  if (typeof v !== 'number' || !Number.isInteger(v) || v < 0) {
    throw new ColumnMappingError(`${label} は0以上の整数（列番号）で指定してください`)
  }
  return v
}

/**
 * 任意（保存されたJSON等）の入力を検証して ColumnMappingConfig へ。失敗は ColumnMappingError。
 * 列番号の上限はファイルにより可変なので検証しない（範囲外列はパース時に空セル扱い＝部分取込で吸収）。
 */
export function validateColumnMappingConfig(raw: unknown): ColumnMappingConfig {
  if (raw == null || typeof raw !== 'object') throw new ColumnMappingError('設定が空です')
  const r = raw as Record<string, unknown>

  if (r.encoding !== 'shift_jis' && r.encoding !== 'utf8') {
    throw new ColumnMappingError('encoding は shift_jis か utf8 を指定してください')
  }
  const encoding = r.encoding

  const headerRows = r.headerRows ?? 1
  if (typeof headerRows !== 'number' || !Number.isInteger(headerRows) || headerRows < 0) {
    throw new ColumnMappingError('headerRows は0以上の整数で指定してください')
  }

  const dateCol = asColIndex(r.dateCol, 'dateCol')

  if (!Array.isArray(r.descCols)) throw new ColumnMappingError('descCols は列番号の配列で指定してください')
  // 配列長を制限（行ごとに反復されるため、巨大配列は取込時のCPUブロックになりうる）。列番号値自体は据置（§8.2）。
  if (r.descCols.length > 64) throw new ColumnMappingError('descCols は64列以内で指定してください')
  const descCols = r.descCols.map((c, i) => asColIndex(c, `descCols[${i}]`))

  const amount = validateAmount(r.amount)

  let balanceCol: number | null = null
  if (r.balanceCol != null) balanceCol = asColIndex(r.balanceCol, 'balanceCol')

  let defaultAccountName: string | null = null
  if (r.defaultAccountName != null) {
    if (typeof r.defaultAccountName !== 'string') throw new ColumnMappingError('defaultAccountName は文字列で指定してください')
    defaultAccountName = r.defaultAccountName.trim() || null
  }

  return { encoding, headerRows, dateCol, descCols, amount, balanceCol, defaultAccountName }
}

function validateAmount(raw: unknown): AmountMapping {
  if (raw == null || typeof raw !== 'object') throw new ColumnMappingError('amount（金額マッピング）が必要です')
  const a = raw as Record<string, unknown>
  switch (a.mode) {
    case 'split':
      return { mode: 'split', paidCol: asColIndex(a.paidCol, 'amount.paidCol'), receivedCol: asColIndex(a.receivedCol, 'amount.receivedCol') }
    case 'signed':
      return { mode: 'signed', amountCol: asColIndex(a.amountCol, 'amount.amountCol') }
    case 'single': {
      const amountCol = asColIndex(a.amountCol, 'amount.amountCol')
      const directionCol = asColIndex(a.directionCol, 'amount.directionCol')
      if (!Array.isArray(a.outValues) || a.outValues.length === 0 || a.outValues.length > 256 || !a.outValues.every((v) => typeof v === 'string')) {
        throw new ColumnMappingError('amount.outValues は出金を表す値（文字列）の配列で1〜256件で指定してください')
      }
      return { mode: 'single', amountCol, directionCol, outValues: a.outValues as string[] }
    }
    default:
      throw new ColumnMappingError('amount.mode は split / signed / single のいずれかです')
  }
}

const cell = (cols: string[], i: number): string => (cols[i] ?? '').trim()

/** 金額マッピングを行へ適用し金額(円・絶対値)と方向を返す。amount=0 は「取引でない行」を意味する。 */
function resolveAmount(amount: AmountMapping, cols: string[]): { amount: number; direction: 'in' | 'out' } {
  switch (amount.mode) {
    case 'split': {
      const paid = parseAmount(cols[amount.paidCol])
      const received = parseAmount(cols[amount.receivedCol])
      // 負数（取消・組戻し等）も取りこぼさない（§8.4・silent drop 禁止）: 符号で方向を決める。
      // 出金列の負＝実質入金、入金列の負＝実質出金。値ありの側（paid 優先）で確定。
      if (paid !== 0) return { amount: Math.abs(paid), direction: paid > 0 ? 'out' : 'in' }
      if (received !== 0) return { amount: Math.abs(received), direction: received > 0 ? 'in' : 'out' }
      return { amount: 0, direction: 'out' }
    }
    case 'signed': {
      const v = parseAmount(cols[amount.amountCol]) // parseAmount は符号 '-' を保持する
      if (v < 0) return { amount: -v, direction: 'out' }
      return { amount: v, direction: 'in' }
    }
    case 'single': {
      const v = Math.abs(parseAmount(cols[amount.amountCol]))
      const dir = toHankaku(cell(cols, amount.directionCol))
      const isOut = amount.outValues.some((o) => dir === toHankaku(o).trim())
      return { amount: v, direction: isOut ? 'out' : 'in' }
    }
  }
}

/** 金額に関わるセルが全て空か（空＝取引行でない区切り/小計行とみなしスキップ。誤エラーを避ける）。 */
function amountCellsBlank(amount: AmountMapping, cols: string[]): boolean {
  switch (amount.mode) {
    case 'split':
      return cell(cols, amount.paidCol) === '' && cell(cols, amount.receivedCol) === ''
    case 'signed':
      return cell(cols, amount.amountCol) === ''
    case 'single':
      return cell(cols, amount.amountCol) === ''
  }
}

/**
 * 列マッピング設定に従ってデコード済みテキストをパースする（成功行＋失敗行）。
 * 組込パーサ（bankUfj 等）と対称: 行単位 try-catch・出現インデックス方式 dedup（withDedupHashes）。
 */
export function parseWithMapping(config: ColumnMappingConfig, text: string): ParseResult {
  const rows = parseCsv(text)
  const out: ParsedRowDraft[] = []
  const errors: ParseError[] = []
  rows.forEach((cols, i) => {
    if (i < config.headerRows) return // 先頭 headerRows 行＝ヘッダ
    if (cols.every((c) => (c ?? '').trim() === '')) return // 空行・区切り行
    // 金額セルが全て空＝取引行でない（小計・注記等）→ 誤エラーにせずスキップ（組込パーサと整合）。
    if (amountCellsBlank(config.amount, cols)) return
    try {
      const { amount, direction } = resolveAmount(config.amount, cols)
      if (amount === 0) return // 金額0（両0/欠落）＝取引でない
      const txnDate = parseDateIso(cell(cols, config.dateCol)) // 解釈不能なら throw→errors（C-9）
      const description = config.descCols.map((idx) => toHankaku(cell(cols, idx))).filter(Boolean).join(' ')
      const balance = config.balanceCol != null ? parseBalanceLoose(cols[config.balanceCol]) : null
      out.push({ txnDate, amount, direction, description, balance, rawPayload: JSON.stringify(cols) })
    } catch (err) {
      errors.push({ rowNo: i + 1, raw: JSON.stringify(cols), message: (err as Error).message })
    }
  })
  return { rows: withDedupHashes(out), errors }
}
