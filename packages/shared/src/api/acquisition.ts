/**
 * 取込（acquisition）API の wire 型（issue #128）。server と web が同じ定義を使う。
 * かつて AcquisitionTarget は server 6 / web 8 フィールドにズレ、実 wire 形は
 * http/acquisition.ts のその場組み立てで型の定義場所が無かった — ここが唯一の定義。
 * ジョブ実装は server/src/acquisition/。
 */

/**
 * 取込ジョブの状態（acquisition spec「長時間ジョブとしての進行」）。
 *
 *   starting ─▶ awaiting_login ─▶ fetching ─▶ done（draft が帳簿に並ぶ）
 *                    │               │
 *                    └───────────────┴──▶ failed / aborted
 */
export const JOB_STATES = ['starting', 'awaiting_login', 'fetching', 'done', 'failed', 'aborted'] as const
export type JobState = (typeof JOB_STATES)[number]

export interface ImportCounts {
  accepted: number
  duplicated: number
  outOfPeriod: number
  /** 科目が決まらず未確定勘定になった件数（＝これから分類する対象）。 */
  unresolved: number
  /** 巡回で取得できなかった明細（注文）の件数。個別の理由は warnings に並ぶ。 */
  failed: number
  warnings: string[]
}

/**
 * 取込ジョブ（GET /api/acquisition/jobs）。server の JobView はこれに較正の詳細
 * （calibration・@kanean/acquisition の型）を足して返すが、web はこの面だけを読む。
 */
export interface AcquisitionJob {
  jobId: string
  bookId: string
  source: string
  accountRef: string
  kind: 'bank' | 'card' | 'ec'
  state: JobState
  /** 何を待っているか（ログイン/2FA）。人に見せる1行。 */
  waitingFor: string | null
  message: string | null
  range: { since: string; until: string }
  /** 範囲を限った取得か（true なら差分の起点を前進させない）。 */
  rangeLimited: boolean
  startedAt: string
  updatedAt: string
  counts: ImportCounts | null
  /** 失敗したときの手順名（診断の取り出し口は別。acquisition spec「失敗時の診断」）。 */
  failedStep: string | null
}

/** 巡回対象（GET /api/acquisition/targets の1件）。 */
export interface AcquisitionTarget {
  source: string
  accountRef: string
  kind: 'bank' | 'card' | 'ec'
  displayName: string
  lastImportedAt: string | null
  fetchSince: string | null
  /** 連続取込済みの終端（watermark）。未取込なら null。 */
  continuousUntil: string | null
  /** 較正データがあり巡回できるか。 */
  hasCrawler: boolean
}

/** GET /api/acquisition/targets の応答。 */
export interface AcquisitionTargets {
  /** 巡回できるか（デスクトップアプリでのみ true）。 */
  crawlerAvailable: boolean
  openFiscalYear: { startDate: string; endDate: string } | null
  evidenceCapture: boolean
  targets: AcquisitionTarget[]
}

/** 分類方針（GET /api/acquisition/policy）。 */
export interface ClassificationPolicy {
  /** 実際に使われる方針。 */
  text: string
  origin: 'bundled' | 'override'
  /** 同梱の既定（これが「戻す先」）。 */
  bundled: string
}
