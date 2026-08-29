/**
 * CSV 取込・取込明細・名寄せ（振替）・残高突合の wire 型。
 * server が実装の正、web/mcp は読者（issue #236）。
 */

/** done=全件成功 / partial=一部失敗だが取込あり / failed=失敗ありで取込0。 */
export type ImportStatus = 'done' | 'partial' | 'failed'

/** 重複としてスキップした取込明細（黙って落とさず内訳を表示する）。 */
export interface SkippedDuplicate {
  txnDate: string
  amount: number
  direction: 'in' | 'out'
  description: string
}

/** パース/取込に失敗した行（部分取込・行単位エラー表示）。 */
export interface ParseError {
  /** parseCsv 出力上の行番号（1始まり。ヘッダ・空行込みの物理行に対応）。 */
  rowNo: number
  /** 失敗行の生データ（列の JSON）。原因究明用。 */
  raw: string
  message: string
}

export interface ImportSummary {
  batchId: number
  inserted: number
  /** dedup_hash 衝突でスキップした総件数（duplicates が上限で丸められても総数はこれが正）。 */
  skippedDup: number
  skippedOutOfPeriod: number
  /** スキップ明細のサンプル（先頭 SAMPLE_LIMIT 件まで。年度まるごと再取込で全件返さない）。 */
  duplicates: SkippedDuplicate[]
  /** パース/挿入で失敗した総件数（部分取込）。 */
  errorCount: number
  /** 失敗行の内訳サンプル（先頭 SAMPLE_LIMIT 件）。 */
  errors: ParseError[]
  status: ImportStatus
  periodStart: string
  periodEnd: string
}

export interface JournalizeSummary {
  drafted: number
  /** 会計期間ゲートで仕訳化しなかった件数（取込の skippedOutOfPeriod と同じ意味・黙って落とさない）。 */
  skippedOutOfPeriod: number
}

/** CSV 取込の結果（POST /import?sourceType=…。帳簿 zip 取り込みの ImportBookResult とは別物）。 */
export interface CsvImportResult {
  import: ImportSummary
  journalized: JournalizeSummary
}

// --- 取込明細の状態（pending/journalized/ignored） --------------------------

/** 取込明細の状態の実値（`?status=` の検証にも使う）。 */
export const RAW_STATUSES = ['pending', 'journalized', 'ignored'] as const
export type RawStatus = (typeof RAW_STATUSES)[number]
/**
 * 一覧の年スコープ。`open`（既定）＝開いている会計年度に属する明細だけ。`all`＝年で絞らない。
 * 「過年度」ではなく open/all の語なのは、除外される行が必ず過去とは限らないため
 * （繰越を取り消す＝reopen すると、翌期に取り込み済みの行が open 年度より未来に来る）。
 */
export type RawYearScope = 'open' | 'all'

export interface RawTransactionView {
  id: number
  txnDate: string
  amount: number
  direction: 'in' | 'out'
  description: string | null
  /** pending / journalized / ignored。 */
  status: string
  sourceType: string
  accountRef: string | null
  journalEntryId: number | null
  /** 紐づく仕訳の状態（draft / confirmed）。未仕訳・除外は null。 */
  entryStatus: string | null
}

/** GET /api/raw-transactions の応答。一覧は上限で丸めることがあるが、件数は必ず告知する（黙って切らない）。 */
export interface RawTransactionListResponse {
  rawTransactions: RawTransactionView[]
  /** status フィルタ適用後・年スコープ内の総件数（上限で rawTransactions が丸められても総数はこれが正）。 */
  total: number
  /** total > 上限（先頭のみ返却＝絞り込みを促す）。 */
  truncated: boolean
  /**
   * 年スコープの外にある件数（同じ status フィルタ）。`years:'all'` および開いている会計年度が
   * 無いときは 0。既定で当年度に閉じたことで見えなくなった行を、黙って隠さないための告知。
   */
  outOfYearTotal: number
}

// --- 決済リンク／名寄せ（口座間振替） ---------------------------------------

export interface TransferSide {
  id: number
  accountRef: string | null
  /** 親勘定/補助名（表示用）。 */
  label: string
  txnDate: string
  description: string | null
}

export interface TransferCandidateView {
  amount: number
  dateDiffDays: number
  /** strong=いずれかの摘要に振替系の語あり / weak=同額・逆方向・近接のみ（偶然一致の可能性）。 */
  confidence: 'strong' | 'weak'
  out: TransferSide
  in: TransferSide
}

export interface LinkedTransferView {
  amount: number
  out: TransferSide
  in: TransferSide
  entryId: number | null
  /** 振替仕訳の状態（draft/confirmed）。confirmed は解除に確定取消が必要。 */
  entryStatus: string | null
}

// --- 残高同期・突合 ---------------------------------------------------------

export interface ReconcileGap {
  /** 取りこぼしの疑いがある行（この行の直前に未取込の取引がある）。 */
  date: string
  description: string | null
  /** この行の取引前残高（= 残高 − 符号付き金額）。この残高で終わる直前取引が取込内に見つからない。 */
  expectedPrevBalance: number
  /** この行の残高（取引後）。 */
  balance: number
  /** この行の符号付き金額（入金:+ / 出金:−）。 */
  delta: number
}

export interface AccountReconcile {
  accountRef: string
  /** 残高を持つ突合対象の行数。 */
  rowCount: number
  /** 最新（取引日→id 昇順で末尾）行の CSV残高。 */
  lastBalance: number | null
  gaps: ReconcileGap[]
  /** gaps が無ければ true（残高チェーンが連続＝取りこぼしなし）。 */
  balanced: boolean
}

export interface ReconcileReport {
  accounts: AccountReconcile[]
}
