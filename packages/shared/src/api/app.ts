/**
 * アプリ基盤の wire 型（帳簿・アプリモード・事業者設定・会計年度・AI連携疎通・エクスポート取込）。
 * server が実装の正、web/mcp は読者（issue #236。#128 の帳票・仕訳・取込に続く集約）。
 */

export const APP_MODES = ['personal', 'office'] as const
/** アプリモード（app-mode spec）。personal=じぶんの帳簿 / office=事務所。 */
export type AppMode = (typeof APP_MODES)[number]

/** 帳簿（control plane books 行の公開形）。 */
export interface BookInfo {
  id: string
  name: string
  createdAt: string
  /** ISO8601。null=アクティブ。アーカイブしても data plane のファイルは残る（削除は提供しない）。 */
  archivedAt: string | null
}

/**
 * AI 連携の疎通状態（web-app spec「AI 連携の疎通案内」）。
 * `seen === false` は「**まだ観測していない**」であって「導入されていない」ではない。
 */
export interface McpLinkStatus {
  /** 一度でも到達を観測したか。false は「未導入」ではなく「観測していない」。 */
  seen: boolean
  /** 最後に観測した版。名乗らなかった到達は `unknown`。未観測は null。 */
  lastVersion: string | null
  /** 最後に観測した時刻（ISO8601）。未観測は null。 */
  lastSeenAt: string | null
  /** 配布物に同梱された版。開発時など分からなければ null（＝検査しない。design D7）。 */
  bundledVersion: string | null
  /** 最後に観測した版が同梱版と一致するか。判断できなければ null。 */
  matches: boolean | null
}

/** エクスポート zip の取り込み結果（data-ops spec「エクスポートの取り込み」）。 */
export interface ImportBookResult {
  /** 取り込み後の帳簿ID。`new` で取り込んだ場合のみ zip 側と異なる。 */
  bookId: string
  bookName: string
  /** zip に記録されていた元の帳簿ID。 */
  sourceBookId: string
  /** `same-id`=そのまま登録 / `new-id`=別IDで新規 / `replaced`=既存を置換。 */
  outcome: 'same-id' | 'new-id' | 'replaced'
  attachmentCount: number
  /** `replaced` のとき、置換前のデータを退避したディレクトリ。 */
  preImportDir: string | null
}

/** 取り込もうとした帳簿IDが既にある状態（409 book_id_conflict）。黙って置換も採番もせず、利用者が選ぶ。 */
export interface ImportConflict {
  bookId: string
  /** zip 側の帳簿名。 */
  incomingName: string
  /** 既にこの環境にある帳簿の名前。 */
  existingName: string
}

/** 取り込みの扱い。auto（既定）＝衝突したら中止して選ばせる / new＝別IDで新規 / replace＝置換。 */
export type ImportMode = 'auto' | 'new' | 'replace'

/** 事業者設定（business_settings 単一行・各種設定）。 */
export interface BusinessSettingsView {
  /** 一度でも保存されたか（business_settings 行の有無）。屋号は任意なので、オンボーディング完了判定はこの値で行う。 */
  configured: boolean
  businessName: string | null
  ownerName: string | null
  phone: string | null
  entityType: string
  filingType: string
  filingForm: string | null
  industry: string | null
  prefecture: string | null
  ebookStorage: boolean
  blueDeductionETax: boolean
  /** 連携サービス取込時に証憑を保存するか（電帳法・電子取引データ保存）。既定 false。 */
  evidenceCapture: boolean
  taxMethod: string
  taxBusinessCategory: string | null
  accountingMethod: string
  roundingSales: string
  roundingPurchase: string
  depreciationRecordMethod: string
}

export interface BusinessSettingsPatch {
  businessName?: string | null
  ownerName?: string | null
  phone?: string | null
  filingType?: string
  filingForm?: string | null
  industry?: string | null
  prefecture?: string | null
  ebookStorage?: boolean
  blueDeductionETax?: boolean
  evidenceCapture?: boolean
  taxMethod?: string
  taxBusinessCategory?: string | null
  accountingMethod?: string
}

/** 会計年度（fiscal_years 行の公開形。$inferSelect を d.ts へ露出させないための手書き固定）。 */
export interface FiscalYearView {
  id: number
  startDate: string
  endDate: string
  /** open / closed */
  status: string
  createdAt: string
}
