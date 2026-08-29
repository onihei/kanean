/**
 * 証憑（添付ファイル）・書類（請求書等）の wire 型。server が実装の正（issue #236）。
 * DocumentView / DocumentLineView は documents / document_lines 行の忠実な公開形
 * （$inferSelect を d.ts へ露出させないための手書き固定。列追加時はここも更新する）。
 */

/** 証憑（添付ファイル）のメタ（電帳法・Exit#1）。storage_path は返さない。 */
export interface AttachmentMeta {
  id: number
  fileName: string | null
  contentType: string | null
  fileSize: number | null
  sha256: string | null
  uploadedAt: string | null
}

/** 書類明細（document_lines 行）。amount は税抜本体。 */
export interface DocumentLineView {
  id: number
  documentId: number
  lineNo: number
  itemId: number | null
  description: string | null
  deliveryDate: string | null
  unitPrice: number | null
  quantity: number | null
  amount: number | null
  taxRate: number | null
  withholding: boolean
  deliveryDocNo: string | null
}

/** 書類（請求書・見積・納品・領収）。一覧はヘッダのみ（lines なし）、詳細は lines 同梱。 */
export interface DocumentView {
  id: number
  /** quote / delivery / invoice / receipt。 */
  docType: string
  docNo: string | null
  counterpartyId: number | null
  honorific: string | null
  subject: string | null
  issueDate: string | null
  dueDate: string | null
  /** 売上計上日（起票時の仕訳日付。請求日と区別する）。 */
  revenueRecognitionDate: string | null
  paymentInfo: string | null
  remarks: string | null
  memo: string | null
  subtotal: number | null
  taxTotal: number | null
  withholdingTotal: number | null
  total: number | null
  /** draft / issued / void 等。 */
  status: string
  convertedFromId: number | null
  journalEntryId: number | null
  createdAt: string
  updatedAt: string
  lines?: DocumentLineView[]
}

export interface DocumentLineInput {
  itemId?: number | null
  description?: string | null
  deliveryDate?: string | null
  unitPrice?: number | null
  quantity?: number | null
  /** 行の金額（税抜・本体）。税は文書レベルで税率別に加算する。 */
  amount: number
  /** 税率（%）。本スライスの起票対象は 8 / 10。 */
  taxRate?: number | null
  /** 源泉徴収の対象行か（報酬請求）。 */
  withholding?: boolean
  deliveryDocNo?: string | null
}

export interface DocumentInput {
  /** quote / delivery / invoice / receipt。 */
  docType: string
  docNo?: string | null
  counterpartyId?: number | null
  honorific?: string | null
  subject?: string | null
  issueDate?: string | null
  dueDate?: string | null
  /** 売上計上日（起票時の仕訳日付。請求日と区別する）。 */
  revenueRecognitionDate?: string | null
  paymentInfo?: string | null
  remarks?: string | null
  memo?: string | null
  lines: DocumentLineInput[]
}
