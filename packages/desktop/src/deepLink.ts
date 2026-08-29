import { SCHEME, HOST } from './protocol.js'

/**
 * OS から渡される `kanean://` リンクの受理（desktop-app spec「該当画面を開く外部リンク」）。
 *
 * **リンクは画面遷移のためだけにある。** 開いただけで会計データが変わる形は作らない。
 * ここで受け取れるのは「どの画面を出すか」だけで、更新系のパラメータは持たない。
 *
 * 同じスキームを `protocol.handle`（アプリ内配信）と共有するので、
 * *内部配信の URL* と *OS からの起動リンク* を混同しないよう、解釈はこの1箇所に閉じる。
 */

/**
 * 開ける画面（@kanean/shared のプロセス間契約が正・issue #167）。
 * ここに無いものは受け付けず、初期画面へフォールバックする。
 */
export { OPENABLE_TABS, type OpenableTab } from '@kanean/shared'
import { OPENABLE_TABS, type OpenableTab } from '@kanean/shared'

/**
 * リンクを解釈して、開くべき画面を返す。
 * 解釈できない・未知の画面は `null`（＝初期画面のまま。異常終了させない）。
 */
export function parseDeepLink(rawUrl: string): OpenableTab | null {
  let url: URL
  try {
    url = new URL(rawUrl)
  } catch {
    return null
  }

  if (url.protocol !== `${SCHEME}:`) return null
  // `kanean://local/...` 以外のホストは自分宛てではない。
  if (url.hostname !== HOST) return null

  // 現行形式は `kanean://local/#journal`（web のハッシュルーティングと同じ形・issue #129）。
  // 旧形式 `?tab=journal` も受ける＝MCP クライアントのチャット履歴に残った過去のリンクを壊さない。
  const fromHash = url.hash.replace(/^#/, '')
  if (isOpenable(fromHash)) return fromHash
  const tab = url.searchParams.get('tab')
  return isOpenable(tab) ? tab : null
}

function isOpenable(value: string | null): value is OpenableTab {
  return value !== null && (OPENABLE_TABS as readonly string[]).includes(value)
}

/**
 * 起動引数から `kanean://` リンクを拾う（Windows/Linux は引数で渡る。macOS は `open-url`）。
 */
export function deepLinkFromArgv(argv: readonly string[]): string | null {
  return argv.find((arg) => arg.startsWith(`${SCHEME}://`)) ?? null
}
