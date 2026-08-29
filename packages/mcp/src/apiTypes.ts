/**
 * 本体 API の応答型。`@kanean/server/types` の再輸出だけで構成する。
 *
 * ブリッジが同じ形を宣言し直すと、本体が変わったときに黙ってずれる。型は1箇所に置き、
 * ここは「ブリッジが触れてよい契約面」を一望するための窓にする。
 * **ここに並ぶ型はすべて src 内で使われている**（未使用の再輸出は置かない。
 * __tests__/apiTypes.test.ts が機械検査する・issue #163）。
 *
 * `@kanean/server/types` は `export type` の再輸出だけなので**実行時には何も読み込まれない**
 * （`dist/types.js` は空）。Hono も drizzle も better-sqlite3 もこのプロセスには入らない。
 */

export type {
  AccountBalanceRow,
  AppMode,
  BalanceSheet,
  BookInfo,
  CalibrationView,
  ClassifyResult,
  DiagnosticView,
  EntryView,
  FilingInstructionSheet,
  FilingPrecheck,
  FilingRecord,
  FiscalYearView,
  GeneralLedger,
  JobState,
  JobView,
  LinkedService,
  ProfitAndLoss,
  ServiceCatalogEntry,
  SubLedger,
  TaxForecast,
  TrialBalance,
  UnclassifiedResult,
} from '@kanean/server/types'
