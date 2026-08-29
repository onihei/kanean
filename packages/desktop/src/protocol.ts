import fs from 'node:fs'
import path from 'node:path'

/**
 * カスタムプロトコルによる配信（desktop-app spec「UI へのアプリ内配信」）。
 * UI も業務APIも同一スキーム・同一オリジンから配るので CORS を必要としない。
 */

// スキーム・権威部は @kanean/shared（プロセス間契約・issue #167）が正。ここは再輸出。
export { SCHEME, HOST } from '@kanean/shared'
import { SCHEME } from '@kanean/shared'

/**
 * カスタムスキームの権限。スパイク B で確認した組み合わせ:
 *   standard        … 通常の URL として解釈させる（相対パス解決・オリジンの成立）
 *   secure          … secure context 扱い（Web API の制限を受けない）
 *   supportFetchAPI … レンダラから fetch() で呼べる
 *   stream          … Response の ReadableStream をそのまま流す（エクスポート zip をメモリに載せない）
 * どれか欠けると fetch かストリーミングが黙って効かなくなる。
 */
export const SCHEME_PRIVILEGES = {
  scheme: SCHEME,
  privileges: { standard: true, secure: true, supportFetchAPI: true, stream: true, corsEnabled: true },
} as const

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.pfb': 'application/octet-stream',
  '.wasm': 'application/wasm',
  '.bcmap': 'application/octet-stream',
  '.icc': 'application/octet-stream',
  '.map': 'application/json; charset=utf-8',
}

/** API 側が受け持つパス。ここに該当しないものは web の静的資材として解決する。 */
export function isApiPath(pathname: string): boolean {
  return /^\/(api|skill|health)(\/|$)/.test(pathname)
}

/** ファイル取得の実体。既定は electron の `net.fetch`。テストでは electron 無しで差し替える。 */
export type FileFetch = (url: string) => Promise<Response>

async function electronFileFetch(url: string): Promise<Response> {
  // トップレベルで import すると electron 外（vitest）でモジュールごと読めなくなるため遅延させる。
  const { net } = await import('electron')
  return net.fetch(url)
}

/**
 * web の静的資材を返す。SPA なので未知のパスは index.html にフォールバックする。
 * `net.fetch(file://…)` を使うのはストリーミングを保つため（大きな資材を全読みしない）。
 */
export async function serveWebAsset(
  pathname: string,
  webDist: string,
  fetchImpl: FileFetch = electronFileFetch,
): Promise<Response> {
  const rel = decodeURIComponent(pathname).replace(/^\/+/, '')
  const normalized = path.normalize(path.join(webDist, rel))

  // パストラバーサル遮断。webDist の外へ出る要求は index.html へ倒す。
  const inside = normalized === webDist || normalized.startsWith(webDist + path.sep)
  const isFile = inside && fs.existsSync(normalized) && fs.statSync(normalized).isFile()
  const target = isFile ? normalized : path.join(webDist, 'index.html')

  if (!fs.existsSync(target)) {
    return new Response(`web のビルド成果物が見つかりません: ${webDist}\n（pnpm build を実行してください）`, {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' },
    })
  }

  const res = await fetchImpl(`file://${target}`)
  const headers = new Headers(res.headers)
  headers.set('Content-Type', MIME[path.extname(target).toLowerCase()] ?? 'application/octet-stream')
  return new Response(res.body, { status: 200, headers })
}

/** `protocol.handle(SCHEME, …)` に渡すハンドラ。API は Hono、それ以外は web の資材へ振り分ける。 */
export function createProtocolHandler(
  honoApp: { fetch: (req: Request) => Response | Promise<Response> },
  webDist: string,
  fetchImpl?: FileFetch,
) {
  return async (request: Request): Promise<Response> => {
    const { pathname } = new URL(request.url)
    if (isApiPath(pathname)) return honoApp.fetch(request)
    return serveWebAsset(pathname, webDist, fetchImpl)
  }
}
