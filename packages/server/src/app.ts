import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { dataDir } from './config.js'
import { getRouter, migrateControlDb, type DbRouter } from './db/router.js'
import { apiRoutes } from './http/api.js'
import { apiErrorHandler } from './http/errors.js'
import { forecastRoutes } from './http/forecast.js'
import { exportRoutes } from './http/export.js'
import { importRoutes } from './http/import.js'
import { ecSkillRoutes } from './http/ec.js'
import { receiptSkillRoutes } from './http/receipts.js'
import { bookRoutes } from './http/books.js'
import { appModeRoutes } from './http/appMode.js'
import { acquisitionRoutes } from './http/acquisition.js'
import { mcpLinkRoutes } from './http/mcpLink.js'
import { withMcpClientCheck } from './mcp/link.js'
// ローカル連携の入口（デスクトップの unix socket）が要求に印を付けるために使う。
export { tagSocketEntry } from './mcp/link.js'
import { withBook, type BookVariables } from './books/middleware.js'
import { ensureAtLeastOneBook } from './books/resolve.js'

export type KaneanApp = Hono<{ Variables: BookVariables }>

export type CreatedApp = {
  /** 業務API（`/api`）と取込スキルAPI（`/skill`）を積んだ Hono。`fetch(Request)` で直接呼べる。 */
  app: KaneanApp
  router: DbRouter
}

/**
 * Hono アプリを構築して返す。**待ち受け（listen）は行わない**。
 *
 * Hono の本体は `Request → Response` の関数であり、HTTP サーバは入口の一形態にすぎない。
 * 入口は用途ごとに異なる:
 *   - 開発時 …… `index.ts` が `@hono/node-server` で `127.0.0.1:10140` に載せる
 *   - デスクトップ …… Electron の `protocol.handle` が `app.fetch` を直接呼ぶ（TCP なし）
 *   - ローカル連携 …… unix domain socket 経由で `/skill` を受ける
 * そのため構築と起動を分離し、import しただけでは待ち受けが始まらないようにする。
 *
 * 起動シーケンス（control plane のマイグレーション → ルータ取得 → 帳簿0冊なら1冊作る）は
 * どの入口でも必要なので、ここに含める。
 */
export type CreateAppOptions = {
  /**
   * 配布物に同梱された MCP バンドルの版。**分からなければ省略する**。
   *
   * 省略すると版の検査を行わない（design D7）。比較対象を持たないまま拒否すると、
   * 開発時（サーバ単体起動）に MCP を繋いで検証できなくなる。
   * 都度読み直せるよう関数で受ける。
   */
  mcpBundleVersion?: () => string | null
}

export function createApp(options: CreateAppOptions = {}): CreatedApp {
  // 起動時に control plane を最新スキーマへ。
  migrateControlDb()
  const router = getRouter()

  // 帳簿が0冊なら1冊作る（data plane も初期化）。N 冊はそのまま（books spec）。
  ensureAtLeastOneBook(router)

  const app = new Hono<{ Variables: BookVariables }>()

  // /api のエラー集約（issue #115）。route() マウントのサブアプリでは onError が効かないため
  // 必ず root に登録する。素の Error→400+message（従来の per-route catch と同じ契約）、
  // DomainError/NotFoundError→宣言ステータス、Hono 組込（bodyLimit 413 等）は素通し。
  app.onError(apiErrorHandler)

  app.get('/health', (c) => c.json({ ok: true, dataDir: dataDir() }))

  // 業務API。認証はなく、対象帳簿を解決して各ハンドラへ渡す（books spec）。
  // 帳簿の一覧・作成・改名・アーカイブとアプリモードは帳簿の指定を要さないので withBook より**前**に登録する
  // （control plane 操作であり、アーカイブ済み帳簿への更新系ガードの対象でもない）。
  const api = new Hono<{ Variables: BookVariables }>()
  // MCP クライアントの版の検査（mcp-server spec）。**`/api` の中にだけ置く**＝
  // 上で登録した `/health` は構造として対象外になる。到達確認まで拒否すると、
  // クライアントからは未起動と区別できず「アプリが起動していません」と誤って案内させてしまう。
  // 帳簿の解決（withBook）より前に置く＝一致しないクライアントに帳簿を触らせない。
  api.use('*', withMcpClientCheck(router, options.mcpBundleVersion ?? (() => null)))
  // エクスポート zip の取り込み（restorable-export）。**bodyLimit より前**に登録する:
  // 帳簿1冊ぶんの zip は証憑を含めば下の 25MB を当然に超えるので、この経路だけ上限が違う
  // （ops/http/import.ts が自前でストリームしながら数える）。withBook より前でもある＝
  // 取り込みは control plane への帳簿登録であり、対象帳簿の指定を前提にできない。
  api.route('/', importRoutes(router))
  // 無制限ボディの遮断（/skill の bodyLimit と同趣旨）。証憑アップロードの上限20MB
  // （attachments/service.ts MAX_FILE_SIZE）が最大の正当ボディなので、それに余裕を持たせた値。
  // 以降に登録するルート（帳簿 API を含む）すべてに効かせる。
  api.use('*', bodyLimit({ maxSize: 25 * 1024 * 1024, onError: (c) => c.json({ error: 'request body が大きすぎます' }, 413) }))
  api.route('/', bookRoutes(router))
  api.route('/', appModeRoutes(router)) // アプリモード（じぶんの帳簿 / 事務所。app-mode spec）
  // AI 連携の疎通状態（web-app spec）。帳簿に属さないので withBook より前。
  api.route('/', mcpLinkRoutes(router, options.mcpBundleVersion ?? (() => null)))
  api.use('*', withBook(router))
  api.route('/', forecastRoutes(router)) // 納税予測・what-if シミュレーション
  api.route('/', exportRoutes(router)) // フルデータエクスポート（DB＋証憑の zip）
  api.route('/', acquisitionRoutes(router)) // アプリ内取込（巡回・分類・較正。acquisition spec）
  api.route('/', apiRoutes(router))
  app.route('/api', api)

  // 連携サービス取込スキル用API（ec-import-api.md）。ボディ上限とエラー形式が /api と異なるため分離。
  app.route('/skill', ecSkillRoutes(router))
  // レシート取込（skill-import spec）。画像を運ぶぶんボディ上限が違うので ec とは別マウント。
  app.route('/skill', receiptSkillRoutes(router))

  return { app, router }
}
