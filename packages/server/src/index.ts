import fs from 'node:fs'
import path from 'node:path'
import { serve } from '@hono/node-server'
import { serveStatic } from '@hono/node-server/serve-static'
import { dataDir, serverPort, isProduction, webDistDir, LOOPBACK_HOST } from './config.js'
import { createApp } from './app.js'

/**
 * TCP（`127.0.0.1:<port>`）の入口。**開発時とセルフホスト運用のためのもの**で、
 * デスクトップアプリはこの経路を使わない（Electron が `createApp()` の `app.fetch` を
 * カスタムプロトコルとローカルソケットに直接繋ぐ。local-access spec / desktop-app spec）。
 */
const { app } = createApp()

// 本番の静的配信（architecture §12: 1 Node プロセスが API + 静的配信）。
// dev/test では Vite (5173) が配信するため無効。index.html はプロセス生存中に変わらないので起動時に1回読む。
const webDist = isProduction() ? webDistDir() : null
const indexHtml =
  webDist && fs.existsSync(path.join(webDist, 'index.html'))
    ? fs.readFileSync(path.join(webDist, 'index.html'), 'utf8')
    : null
if (webDist && indexHtml === null) {
  console.warn(`[server] web/dist が見つかりません: ${webDist}（静的配信は無効。deploy.sh で dist を転送したか確認）`)
}

// ルート: 本番（静的配信あり）は web の index.html を返す（アセットは末尾の serveStatic が配る）。
app.get('/', (c) => {
  if (indexHtml !== null) return c.html(indexHtml)
  return c.text('Kanean API. 開発中の Web は Vite (http://localhost:5173) で配信されます。')
})

// 本番の静的アセット配信。/api・/skill の**登録済みルート**は先勝ちするため遮らない。
// serveStatic の root は cwd 相対で解決されるため、絶対パスを cwd 相対へ変換して渡す。
if (webDist && indexHtml !== null) {
  const root = path.relative(process.cwd(), webDist) || '.'
  app.use('/*', serveStatic({ root }))
  // 未知の GET パスは SPA の index.html へフォールバック（将来の URL ルーティング導入に備える）。
  // ただし API 系プレフィクスは除外: 未知の /api/* まで 200+HTML で返すと、クライアントには
  // JSON パースエラーとして化けて 404 が観測不能になる（デプロイずれ・改名エンドポイントの罠）。
  app.get('/*', (c) => {
    const p = c.req.path
    if (/^\/(api|skill)(\/|$)/.test(p)) return c.json({ error: 'not found' }, 404)
    return c.html(indexHtml)
  })
}

const port = serverPort()
// ループバック限定バインド（local-access spec）。認証を持たない代わりに、待ち受けを 127.0.0.1 に
// 固定して**ネットワーク到達性そのものを防壁**にする。これは設定で変更できてはならない
// （外部公開できる口が残ると、認証がないことと組み合わさって事故が致命的になる）。
serve({ fetch: app.fetch, port, hostname: LOOPBACK_HOST }, (info) => {
  console.log(`[server] listening on http://${LOOPBACK_HOST}:${info.port} (DATA_DIR=${dataDir()})`)
})

export { app }
