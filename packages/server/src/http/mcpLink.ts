import { Hono } from 'hono'
import type { DbRouter } from '../db/router.js'
import { linkStatus } from '../mcp/link.js'

/**
 * AI 連携の疎通状態（web-app spec「AI 連携の疎通案内」）。
 *
 * ホーム画面のセットアップ案内はこれだけを材料に書く。返すのは**観測できた事実**だけで、
 * 「クライアントが導入されているか」は含まない ── アプリからは判別できないため。
 *
 * `withBook` の**外側**に置く＝連携の状態は帳簿に属さない（control plane に記録している）。
 */
export function mcpLinkRoutes(router: DbRouter, bundledVersion: () => string | null): Hono {
  const app = new Hono()

  app.get('/mcp-link', (c) => c.json(linkStatus(router, bundledVersion())))

  return app
}
