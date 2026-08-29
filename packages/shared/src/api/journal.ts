/**
 * 仕訳 API の wire 型（issue #128）。server（組み立て）と web（表示）が同じ定義を使う。
 * 実装（一覧・編集・確定取消）は server/src/journal/entries.ts。
 */
import type { Side } from '../ledger.js'

export interface EntryLineView {
  id: number
  lineNo: number
  side: Side
  accountId: number
  accountName: string
  subAccountId: number | null
  subAccountName: string | null
  counterpartyId: number | null
  counterpartyName: string | null
  departmentId: number | null
  departmentName: string | null
  taxCategoryId: number | null
  taxAmount: number | null
  amount: number
  description: string | null
}

export interface EntryView {
  id: number
  fiscalYearId: number
  entryDate: string
  description: string | null
  memo: string | null
  slipNo: string | null
  source: string
  status: 'draft' | 'confirmed'
  createdAt: string
  updatedAt: string
  debitTotal: number
  creditTotal: number
  lines: EntryLineView[]
}

/** 仕訳一覧の絞り込み（GET /api/entries のクエリ）。 */
export interface ListEntriesFilter {
  /** 既定 'confirmed'。'all' は draft/confirmed 両方。 */
  status?: 'all' | 'draft' | 'confirmed'
  from?: string | null
  to?: string | null
  /** 摘要の部分一致。 */
  q?: string | null
  /** 当該科目を含む明細を持つ仕訳に限定。 */
  accountId?: number | null
  limit?: number
}

/** 手入力・編集の明細（POST/PUT /api/entries。補助科目・取引先・部門・税は任意付与）。 */
export interface ManualEntryLineInput {
  side: Side
  accountId: number
  subAccountId?: number | null
  counterpartyId?: number | null
  departmentId?: number | null
  taxCategoryId?: number | null
  taxAmount?: number | null
  amount: number
  description?: string | null
}

// --- draft（確認待ち仕訳）のレビュー（issue #236 で shared 集約） -------------

export type DraftOriginSource = 'ec_skill' | 'bank_skill' | 'csv' | 'manual' | 'transfer' | 'other'

/** draft 仕訳の由来（AI/ルールのサジェスト根拠）。 */
export interface DraftOrigin {
  source: DraftOriginSource
  /** AI仕訳の分類理由（スキル）またはサジェスト機構の説明（CSV）。不明は null。 */
  reason: string | null
  /** AI仕訳の確信度。CSV/手入力には無い（null）。 */
  confidence: 'high' | 'medium' | 'low' | null
  /** 生証跡への参照（電帳法/監査。EC=evidenceRef 必須・銀行=任意）。 */
  evidence: string | null
}

export interface DraftLineView {
  id: number
  lineNo: number
  side: Side
  accountId: number
  accountName: string
  subAccountId: number | null
  taxCategoryId: number | null
  taxAmount: number | null
  amount: number
}

export interface DraftView {
  id: number
  entryDate: string
  description: string | null
  source: string
  origin: DraftOrigin
  lines: DraftLineView[]
}

/** GET /api/drafts の絞り込み（例外ベースレビュー: 低確信度だけ精査する等）。 */
export interface ListDraftsOpts {
  subAccountId?: number
  /** entry_date の下限/上限（YYYY-MM-DD・両端含む）。 */
  from?: string
  to?: string
  /** 摘要の部分一致（LIKE メタ文字はエスケープ＝素の substring 検索）。 */
  q?: string
  /** origin.confidence の一致（AI仕訳候補の確信度。抽出できない draft は除外される）。 */
  confidence?: 'high' | 'medium' | 'low'
  /** 返す最大件数（confidence フィルタ後の先頭 N 件。並びは従来どおり＝挿入順）。 */
  limit?: number
}

export interface BatchConfirmResult {
  id: number
  ok: boolean
  error?: string
}

/** 監査ログ（仕訳の訂正・確定取消・削除の履歴）。 */
export interface AuditLogView {
  id: number
  targetId: number
  action: string
  note: string | null
  at: string
  before: unknown
  after: unknown
}
