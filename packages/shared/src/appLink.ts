/**
 * プロセス間契約（issue #167）。デスクトップ（配信・ディープリンク受理）・MCP（画面リンク提示・
 * 版ヘッダ）・server（版検査）・web（タブ定義との型接続）が**別々に持っていた定数**を1箇所に。
 * このモジュールは純粋（node 依存なし）＝web からも import できる。
 * 既定パス系（node:os/path が要る）は `@kanean/shared/node`（nodePaths.ts）にある。
 */

/** デスクトップ配信のカスタムスキームとホスト（`kanean://local/`）。 */
export const SCHEME = 'kanean'
export const HOST = 'local'

/** ローカル連携（unix socket）のファイル名。実体は `$DATA_DIR/kanean.sock`（起動中のみ・0600）。 */
export const SOCKET_FILENAME = 'kanean.sock'

/**
 * ディープリンクで開ける画面。web の `TabKey`（nav.ts）の部分集合で、nav.ts 側が
 * `satisfies` で型接続する。desktop の受理（deepLink）と MCP の提示（openInApp）が共有。
 */
export const OPENABLE_TABS = [
  'home',
  'services',
  'raw',
  'journal',
  'trial',
  'pl',
  'bs',
  'tax',
  'incometax',
  'filing',
  'settings',
] as const

export type OpenableTab = (typeof OPENABLE_TABS)[number]

/**
 * 指定した画面を開くリンク（省略時はアプリを開くだけ）。
 * 画面は hash で指す（web のハッシュルーティングと同じ形・issue #129）。
 * 旧形式 `?tab=…` は生成しないが、受理側（desktop の parseDeepLink）は互換で読める。
 */
export function screenLink(tab?: OpenableTab | null): string {
  const base = `${SCHEME}://${HOST}/`
  return tab ? `${base}#${tab}` : base
}

/**
 * `/api/desktop/mcp-bundle` の応答（MCP バンドル書き出しの可否と導入手順）。
 * desktop（bundleStatus が生成）と web（AiLinkPanel が表示）のワイヤ型。
 */
export interface BundleStatus {
  /** この経路で書き出せるか（＝デスクトップ版で動いていて、同梱物がある）。 */
  available: boolean
  /** 導入手順。利用者にそのまま提示する。 */
  steps: string[]
}

/** MCP クライアントが版を名乗るヘッダ。値は `<name>/<version>`（解析は server/mcp/link.ts）。 */
export const CLIENT_HEADER = 'x-kanean-client'

/** `<name>/<version>` の生成（送る側はこれを使い、書式を手で組まない）。 */
export function formatClientHeader(name: string, version: string): string {
  return `${name}/${version}`
}
