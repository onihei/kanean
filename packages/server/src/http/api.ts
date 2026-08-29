import { Hono } from 'hono'
import type { DbRouter } from '../db/router.js'
import type { BookVariables } from '../books/middleware.js'
import { mastersRoutes } from './routes/masters.js'
import { reportsRoutes } from './routes/reports.js'
import { taxReturnRoutes } from './routes/taxReturn.js'
import { entriesRoutes } from './routes/entries.js'
import { attachmentsRoutes } from './routes/attachments.js'
import { importsRoutes } from './routes/imports.js'
import { fixedAssetsRoutes } from './routes/fixedAssets.js'
import { documentsRoutes } from './routes/documents.js'
import { closingRoutes } from './routes/closing.js'
import { filingRoutes } from './routes/filing.js'

/**
 * /api 配下の業務 API（withBook でマウントされ c.get('bookId') を使う）。
 *
 * 実体はドメイン別サブルーター（issue #114 で分割）。公開ルートの集合は
 * `__tests__/apiRouteInventory.test.ts` の台帳（138本）で機械検証している。
 * 共有規約（id ガード・CSV/PDF レスポンス・open 年度の解決）は `./helpers.ts`。
 */
export function apiRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()

  // マスタ系（科目・年度・税区分・事業者設定・連携サービス・各種マスタ CRUD）
  app.route('/', mastersRoutes(router))
  // 帳票（試算表・PL/BS・元帳・前期比較と CSV 出力）
  app.route('/', reportsRoutes(router))
  // 税務申告（消費税・青色決算書・確定申告書と各 PDF）
  app.route('/', taxReturnRoutes(router))
  // 仕訳（起票・確定・編集・削除・監査ログ）
  app.route('/', entriesRoutes(router))
  // 証憑（添付ファイル）
  app.route('/', attachmentsRoutes(router))
  // 取込（CSV・draft レビュー・突合・名寄せ）
  app.route('/', importsRoutes(router))
  // 固定資産（台帳・登録・償却起票・除却・売却）
  app.route('/', fixedAssetsRoutes(router))
  // 書類（請求書・見積・納品・領収）
  app.route('/', documentsRoutes(router))
  // 決算整理（家事按分・開始残高・元入金振替・年度繰越）
  app.route('/', closingRoutes(router))
  // 申告の提出支援（precheck・入力指示書・完了記録）
  app.route('/', filingRoutes(router))

  return app
}
