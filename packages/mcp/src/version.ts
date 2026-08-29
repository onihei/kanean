import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 自分の版の表明（mcp-server spec「クライアントの版の表明と一致の要求」）。
 *
 * アプリは同梱した版とこの値を突き合わせ、一致しなければ会計データを返さない。
 * **版の出所は `manifest.json` ひとつ**に保つ。`scripts/bundle.mjs` が `package.json` との
 * 食い違いでビルドを止めるので、ここも同じファイルを見れば三者がずれない。
 *
 * 置き場所が3通りあるが、いずれも「自分の1つ上」に `manifest.json` が居る:
 *   バンドル … `server/index.mjs`  → `../manifest.json`（mcpb の中身そのもの）
 *   ビルド後 … `dist/version.js`   → `../manifest.json`
 *   テスト   … `src/version.ts`    → `../manifest.json`
 */

/** アプリへ名乗るときの呼び名。将来ほかのローカル連携が増えても取り違えないため（design D4）。 */
export const CLIENT_NAME = 'kanean-mcp'

/** 版を名乗るヘッダ（@kanean/shared のプロセス間契約が正。書式生成は formatClientHeader）。 */
export { CLIENT_HEADER } from '@kanean/shared'
import { CLIENT_HEADER, formatClientHeader } from '@kanean/shared'

let cached: string | null | undefined

/**
 * 自分の版。**読めなければ null**（版を名乗らない）。
 *
 * 名乗らなければアプリは一致しないものとして拒否する（spec「版を表明しないクライアントを拒否する」）。
 * 判別できない要求を通さない側に倒れるので、ここで既定値をでっち上げてはならない。
 */
export function clientVersion(): string | null {
  if (cached !== undefined) return cached
  const here = path.dirname(fileURLToPath(import.meta.url))
  try {
    const raw = fs.readFileSync(path.resolve(here, '..', 'manifest.json'), 'utf8')
    const version = (JSON.parse(raw) as { version?: unknown }).version
    cached = typeof version === 'string' && version !== '' ? version : null
  } catch {
    cached = null
  }
  return cached
}

/** アプリへ送るヘッダ。版が分からなければ**何も名乗らない**（偽の版を送らない）。 */
export function clientHeaders(): Record<string, string> {
  const version = clientVersion()
  return version ? { [CLIENT_HEADER]: formatClientHeader(CLIENT_NAME, version) } : {}
}

/** テスト用。読み取りのキャッシュを捨てる。 */
export function resetClientVersionCache(): void {
  cached = undefined
}
