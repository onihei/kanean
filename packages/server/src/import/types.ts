import type { ParseError } from '@kanean/shared'
export type { ParseError }
import crypto from 'node:crypto'

/** 正規化後の1取引（→ raw_transactions）。 */
export interface ParsedRow {
  txnDate: string // ISO YYYY-MM-DD
  amount: number // 円
  direction: 'in' | 'out'
  description: string
  /** CSV残高（差引残高/残高。残高同期・突合用。銀行のみ。カード等・取得不能は null）。 */
  balance?: number | null
  rawPayload: string // 元行(JSON)。監査用
  dedupHash: string
}

/** dedup_hash を除いた解析行。dedup_hash は withDedupHashes が出現インデックス込みで一括付与する。 */
export type ParsedRowDraft = Omit<ParsedRow, 'dedupHash'>

/** パース結果。成功行と失敗行（取引行と判定できたが解釈できなかった行）を分離して返す。 */
export interface ParseResult {
  rows: ParsedRow[]
  errors: ParseError[]
}

/** 対応する取込形式（口座マスタ・dispatch・検証で共有する単一の真実源）。 */
export const SOURCE_TYPES = ['bank_ufj', 'bank_shinsei', 'card_mufg_visa'] as const
export type SourceType = (typeof SOURCE_TYPES)[number]

/**
 * ユーザー定義フォーマット（汎用列マッピング・Phase3）の source_type 表記規約。
 * 組込3形式（SOURCE_TYPES）と同じ source_type 文字列空間に `format:{id}` として共存させる
 * （import_batches.source_type / sub_accounts.import_source_type はいずれも自由テキストで保存できる）。
 * id は import_formats.id。これにより組込/ユーザー定義を1つの選択軸（口座マスタ・dispatch）で扱える。
 */
export const CUSTOM_SOURCE_PREFIX = 'format:'

/** source_type がユーザー定義フォーマット（`format:{id}`）か。 */
export function isCustomSourceType(sourceType: string): boolean {
  return sourceType.startsWith(CUSTOM_SOURCE_PREFIX)
}

/**
 * `format:{id}` から import_formats.id を取り出す。組込形式・不正表記は null。
 * id は正の十進整数のみ（先頭ゼロ・指数/16進/8進・符号・空白・小数を弾く。`Number` の緩い解釈で
 * `format:7e3`→7000 のように別 id へ無言で紐づくのを防ぐ）。
 */
export function customFormatId(sourceType: string): number | null {
  if (!isCustomSourceType(sourceType)) return null
  const raw = sourceType.slice(CUSTOM_SOURCE_PREFIX.length)
  if (!/^[1-9][0-9]*$/.test(raw)) return null
  return Number(raw)
}

/** import_formats.id を source_type 文字列（`format:{id}`）へ。 */
export function customSourceType(id: number): string {
  return `${CUSTOM_SOURCE_PREFIX}${id}`
}

/** 連結境界の曖昧さ（例: 摘要'自販機'+出現1 と '自販機1'+出現0）を避ける区切り子。データに現れない制御文字（US, 0x1F）。 */
const SEP = String.fromCharCode(31)

/** 冪等キーの低レベル合成（csv-format C-6）。要素を区切り子で連結して sha256。 */
export function dedupHash(parts: Array<string | number>): string {
  return crypto.createHash('sha256').update(parts.join(SEP)).digest('hex')
}

/** dedup レシピが見る内容列（出現カウント・ハッシュ合成の入力）。 */
export interface DedupContent {
  txnDate: string
  amount: number
  direction: string
  description: string
}

/**
 * 出現カウント用の内容キー。scope（口座 account_ref 等）を先頭に付けてグループ化できる。
 * Map キーとしての単射性のみが要件（ハッシュ本体には使われない）。
 */
export function dedupContentKey(row: DedupContent, scope?: string): string {
  const parts = [row.txnDate, row.amount, row.direction, row.description]
  return (scope == null ? parts : [scope, ...parts]).join(SEP)
}

/**
 * 内容＋出現インデックス n から dedup_hash を合成する**レシピの単一真実源**。
 * 取込（withDedupHashes）と移行（dedupBackfill）の両方がこれを呼ぶ。
 * 列・順序・区切り子を変えると保存済みハッシュと再取込が一致しなくなり二重計上に直結するため、
 * 変更時は backfillDedupHashes 側の移行設計とゴールデンテストを必ず併せて見直すこと。
 */
export function occurrenceDedupHash(row: DedupContent, n: number): string {
  return dedupHash([row.txnDate, row.amount, row.direction, row.description, n])
}

/**
 * 解析行に出現インデックス付き dedup_hash を一括付与する（csv-format C-6 / roadmap Phase3 重複検知の堅牢化）。
 *
 *   dedup_hash = sha256(取引日, 金額, 方向, 摘要, 出現インデックス)
 *
 * 同一(取引日,金額,方向,摘要)が同一取込内に複数あれば 0,1,2… の出現インデックスで識別する。
 * - 同日・同額・同摘要の「別取引」を取りこぼさない（全件が distinct な hash を持つ）。
 * - 同一データの再取込はグループ内の出現順が安定なので同じ hash になり冪等。
 * - 残高列・支払回数（何回目）には依存しない（欠落/同一値で衝突する脆さを解消）。
 *   残高・回数は raw_payload に保持され、残高同期・突合（後続項目）で利用する。
 */
export function withDedupHashes(rows: ParsedRowDraft[]): ParsedRow[] {
  const occurrence = new Map<string, number>()
  return rows.map((r) => {
    const key = dedupContentKey(r)
    const n = occurrence.get(key) ?? 0
    occurrence.set(key, n + 1)
    return { ...r, dedupHash: occurrenceDedupHash(r, n) }
  })
}
