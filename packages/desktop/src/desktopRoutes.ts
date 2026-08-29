import { Hono } from 'hono'
import { bundleStatus, exportBundle, type BundleEnv } from './mcpBundle.js'

export interface DesktopEnv extends BundleEnv {
  /** 巡回のログイン状態を捨てる。デスクトップでしか行えない（Electron のセッション操作）。 */
  forgetAcquisitionLogins?: () => Promise<void>
}

/**
 * デスクトップ版だけが持つルート（`/api/desktop/*`）。
 *
 * UI との通信はすべて HTTP に一本化されている（preload も IPC も持たない）。
 * Finder での提示のように **Electron 側にしか無い操作**は、ここに足して同じ経路で使う（design D9）。
 *
 * 開発時（Vite + server 単体）はこのルートが存在しないので **404 になる**。
 * 設定画面はそれを見て「デスクトップ版で操作してください」と案内できる
 * ＝「押せるのに何も起きない」状態を作らずに済む。
 */
export function desktopRoutes(env: DesktopEnv): Hono {
  const app = new Hono()

  app.get('/desktop/mcp-bundle', (c) => c.json(bundleStatus(env)))

  app.post('/desktop/mcp-bundle/export', (c) => {
    try {
      return c.json(exportBundle(env))
    } catch (err) {
      return c.json({ error: (err as Error).message }, 500)
    }
  })

  // 巡回のログイン状態の破棄。**保存しているのは秘密**なので、消す導線を必ず持つ
  // （acquisition spec「巡回セッションの秘密としての扱い」）。
  app.post('/desktop/acquisition/forget-logins', async (c) => {
    if (!env.forgetAcquisitionLogins) return c.json({ error: 'このビルドでは行えません' }, 404)
    await env.forgetAcquisitionLogins()
    return c.json({ ok: true })
  })

  return app
}
