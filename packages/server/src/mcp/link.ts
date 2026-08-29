import type { McpLinkStatus } from '@kanean/shared'
export type { McpLinkStatus }
import { eq } from 'drizzle-orm'
import type { MiddlewareHandler } from 'hono'
import { appSettings } from '../db/control/schema.js'
import type { DbRouter } from '../db/router.js'

/**
 * MCP クライアントの版の検査と、到達の記録
 * （mcp-server spec「クライアントの版の表明と一致の要求」「連携の到達の記録」）。
 *
 * アプリはサーバ側にいるので、クライアントの状態は**要求が来たときにしか観測できない**。
 * 「入っている」は証明できるが「入っていない」は証明できない。ここで扱うのは前者だけで、
 * 未到達は「観測していない」として返す（未導入と断定しない）。
 */

/** 名乗りのヘッダ。`<name>/<version>` の形（design D4）。 */
// ヘッダ名は @kanean/shared（プロセス間契約・issue #167）が正。`<name>/<version>` の解析はここ。
export { CLIENT_HEADER } from '@kanean/shared'
import { CLIENT_HEADER } from '@kanean/shared'

/**
 * 要求がどの入口から入ったかの印。**入口だけが付けられる**（design D4）。
 *
 * UI もローカル連携も同じ Hono を通るので、「名乗らない要求を拒否」では UI まで巻き込む。
 * 見分けは入口で付ける: ローカルソケットに届いた要求だけがこの印を持つ。
 * 取込の巡回が Electron 側へ移った結果、このソケットへ繋ぐのは MCP クライアントだけになった。
 */
export const ENTRY_HEADER = 'x-kanean-entry'
export const SOCKET_ENTRY = 'socket'

/** 最後に到達したクライアントの版。名乗らなかった場合は `unknown`。 */
const LAST_VERSION_KEY = 'mcp.last_seen_version'
/** 最後に到達した時刻。 */
const LAST_SEEN_AT_KEY = 'mcp.last_seen_at'

/** 版を名乗らなかった到達の記録値。「到達が無い」とは区別する（記録が無い ≠ 名乗りが無い）。 */
export const UNKNOWN_VERSION = 'unknown'

/**
 * ローカル連携の入口から入った要求として印を付ける。**入口だけが呼ぶ**。
 *
 * クライアントが同名のヘッダを送ってきても上書きする（印は自分で名乗るものではない）。
 */
export function tagSocketEntry(request: Request): Request {
  const headers = new Headers(request.headers)
  headers.set(ENTRY_HEADER, SOCKET_ENTRY)
  return new Request(request, { headers })
}

/** 名乗りから版を取り出す。`<name>/<version>` 以外は名乗っていないものとして扱う。 */
export function parseClientVersion(header: string | undefined | null): string | null {
  if (!header) return null
  const slash = header.lastIndexOf('/')
  if (slash <= 0) return null
  const version = header.slice(slash + 1).trim()
  return version === '' ? null : version
}

function readSetting(router: DbRouter, key: string): string | null {
  const row = router.controlDb().select().from(appSettings).where(eq(appSettings.key, key)).all()[0]
  return row?.value ?? null
}

function writeSetting(router: DbRouter, key: string, value: string, now: string): void {
  router
    .controlDb()
    .insert(appSettings)
    .values({ key, value, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value, updatedAt: now } })
    .run()
}

/**
 * 到達を記録する。**拒否した要求も記録する** — 拒否こそが
 * 「一致しない版が使われている」ことの観測だからである（spec「拒否した要求も記録する」）。
 */
export function recordSeen(router: DbRouter, version: string | null, now = new Date().toISOString()): void {
  writeSetting(router, LAST_VERSION_KEY, version ?? UNKNOWN_VERSION, now)
  writeSetting(router, LAST_SEEN_AT_KEY, now, now)
}

/** 連携の状態。ホーム画面の案内はこれだけを材料に書く（web-app spec）。 */
export function linkStatus(router: DbRouter, bundledVersion: string | null): McpLinkStatus {
  const lastVersion = readSetting(router, LAST_VERSION_KEY)
  const lastSeenAt = readSetting(router, LAST_SEEN_AT_KEY)
  const seen = lastVersion !== null
  return {
    seen,
    lastVersion,
    lastSeenAt,
    bundledVersion,
    // 同梱版が分からない、または未到達なら判断しない。「分からない」を false に丸めると、
    // 開発中や未使用の状態が「古い版が使われている」と表示されてしまう。
    matches: bundledVersion === null || !seen ? null : lastVersion === bundledVersion,
  }
}

/**
 * 会計データの経路（`/api/*`）に載せる検査（design D1・D2）。
 *
 * **同梱版と厳密に一致しなければ拒否する。** 古いか新しいかで分岐しない:
 *   - 名乗らないクライアントも、この一本の規則で自然に拒否側へ落ちる
 *   - 案内「書き出して入れ直す」は両方向で正しい（このアプリから書き出せば必ず一致する）
 *
 * **到達確認（`/health`）には載せない。** 載せるとクライアントからは未起動と区別できず、
 * 「Kanean が起動していません」という誤った次の一手を利用者へ案内させてしまう。
 * `/health` はこのミドルウェアの外側（`/api` の外）にあるので、構造として担保される。
 *
 * 同梱版が分からないとき（開発時）は検査しない（design D7）。比較対象を持たないまま拒否すると
 * 開発中に MCP を検証できなくなる。「分からないから拒否」ではなく「分からないから何も言わない」。
 */
export function withMcpClientCheck(
  router: DbRouter,
  bundledVersion: () => string | null,
): MiddlewareHandler {
  return async (c, next) => {
    const header = c.req.header(CLIENT_HEADER)
    const fromSocket = c.req.header(ENTRY_HEADER) === SOCKET_ENTRY

    // 検査するのは「ローカル連携の入口から来た要求」と「自分から名乗った要求」。
    //   ソケット経由 …… 名乗らなくても検査する＝**名乗る前の版のバンドルを捕まえられる**
    //   名乗りあり  …… 開発時の TCP 経路でも同じ判定を通す（spec「明示された開発用の経路でも同じ」）
    //   どちらでもない …… UI からの呼び出し。素通しする
    if (!fromSocket && header === undefined) return next()

    const version = parseClientVersion(header)
    const bundled = bundledVersion()
    recordSeen(router, version)

    if (bundled === null || version === bundled) return next()

    return c.json(
      {
        error: {
          code: 'client_version_mismatch',
          message:
            `この Kanean 拡張（${version ?? '版の表明なし'}）は、いま動いているアプリに同梱された版（${bundled}）と一致しません。` +
            'Kanean の「各種設定 → Claude Desktop と連携」で連携ファイルを書き出し、' +
            'Dock の Claude アイコンへドラッグして入れ直してください。',
        },
      },
      426,
    )
  }
}
