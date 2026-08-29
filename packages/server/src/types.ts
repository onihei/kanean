/**
 * ローカル連携クライアント（[[mcp-server]] のブリッジ等）が参照する **API 応答の型だけ**を公開する。
 *
 * `./app` は Hono・drizzle・better-sqlite3 を丸ごと引き込むので、型が欲しいだけの
 * クライアントには重すぎる（そもそも import した時点で DB を開きうる）。ここは
 * `export type` の再輸出だけで構成し、ビルド後の `dist/types.js` を**空**に保つ。
 * ＝実行時には何も読み込まれず、型の共有だけが起きる。
 *
 * ここに置くのは**素のインターフェース**に限る。drizzle 推論型（`$inferSelect`）を
 * 混ぜると利用側が drizzle-orm を解決できないと型検査に通らなくなるため入れない。
 */

export type {
  AccountBalanceRow,
  BalanceSheet,
  BsSectionView,
  GeneralLedger,
  LedgerRow,
  Period,
  PlSectionView,
  ProfitAndLoss,
  ReportType,
  SubLedger,
  TrialBalance,
} from './reports/reports.js'

export type { EntryLineView, EntryView, ListEntriesFilter } from './journal/entries.js'

export type {
  TaxForecast,
  TaxForecastScenario,
  TaxForecastWhatIf,
} from './taxreturn/forecast.js'

export type {
  LinkedBankAccount,
  LinkedCardAccount,
  LinkedEcService,
  LinkedServicesResult,
} from './import/ecServices.js'

// 申告の提出支援（filing spec）。precheck・入力指示書・完了記録の応答型。
export type { FilingPrecheck, FilingIssue, FilingInstructionSheet, FilingRecord } from './filing/service.js'

export type { BookInfo } from './books/resolve.js'

export type { AppMode } from './appMode/appMode.js'

// マスタ（連携サービス）と会計年度。MCP の GET /api/services / /api/services/catalog /
// /api/fiscal-years が手書きコピーしていた契約面（issue #163）。
export type { LinkedService } from './masters/services.js'
export type { ServiceCatalogEntry } from './services/catalog.js'
export type { FiscalYearView } from './fiscalYear/setup.js'

// 取込（acquisition）。JobView / DiagnosticView / CalibrationView は `@kanean/acquisition` の
// 型（Calibration / StoredDiagnostic / Sel）を参照するため、利用側は同パッケージを
// devDependencies（型のみ）に持つ必要がある。
export type { ImportCounts, JobState, JobView } from './acquisition/types.js'
export type { ClassifyResult, UnclassifiedResult } from './acquisition/classify.js'
export type { DiagnosticView } from './acquisition/diagnostics.js'
export type { CalibrationView } from './acquisition/calibration.js'
