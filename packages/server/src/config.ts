import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/** 先頭の ~ をホームディレクトリに展開する。 */
function expandHome(p: string): string {
  if (p === '~') return os.homedir()
  if (p.startsWith('~/')) return path.join(os.homedir(), p.slice(2))
  return p
}

/** pnpm-workspace.yaml を上方向に探してリポジトリルートを返す（見つからなければ start）。 */
function findRepoRoot(start: string): string {
  let dir = start
  for (;;) {
    if (fs.existsSync(path.join(dir, 'pnpm-workspace.yaml'))) return dir
    const parent = path.dirname(dir)
    if (parent === dir) return start
    dir = parent
  }
}

/**
 * データ配置（architecture §4）。DATA_DIR で外出し（コード配下に置かない）。未設定なら ./data。
 * 相対パスは**リポジトリルート基準**で解決（dev で server の cwd に依存しないように）。
 * 絶対パス（本番の ~/data/kanean 等）はそのまま。
 */
export function dataDir(): string {
  const raw = expandHome(process.env.DATA_DIR ?? './data')
  if (path.isAbsolute(raw)) return raw
  return path.resolve(findRepoRoot(process.cwd()), raw)
}

/** control plane（帳簿レジストリ／バックアップ記録）の DB パス。 */
export function controlDbPath(): string {
  return path.join(dataDir(), 'control.sqlite')
}

/**
 * 一時ファイル置き場（`$DATA_DIR/tmp`）。エクスポート zip・取り込みステージング等が使う。
 * OS の /tmp ではなくデータと同一FSに置く＝最終配置が rename（原子的移動）で済み、権限も一貫する。
 */
export function tmpDir(): string {
  return path.join(dataDir(), 'tmp')
}

/** data plane（帳簿ごとの会計データ）のディレクトリ。 */
export function booksDir(): string {
  return path.join(dataDir(), 'books')
}

/** 指定帳簿の data plane DB パス。 */
export function bookDbPath(bookId: string): string {
  return path.join(booksDir(), `${bookId}.sqlite`)
}

/**
 * 指定帳簿の証憑（添付ファイル）格納ディレクトリ。`books/{bookId}.sqlite` と物理的に並ぶ
 * `books/{bookId}/attachments/`（DB とファイルを同じ per-book 隔離に置く。architecture §4）。
 * listBookDbFiles は `.sqlite` のみ列挙するためこのディレクトリを DB と誤認しない。
 */
export function attachmentDir(bookId: string): string {
  return path.join(booksDir(), bookId, 'attachments')
}

/**
 * 本番で配信する web のビルド成果物（architecture §12: 1 Node プロセスが API + 静的配信）。
 * pm2 の cwd に依存しないよう、このファイル自身の位置から解決する
 * （dist/config.js でも src/config.ts でも `../../web/dist` = packages/web/dist）。
 * 別配置にしたい場合は WEB_DIST_DIR で上書き（相対はリポジトリルート基準）。
 */
export function webDistDir(): string {
  const raw = expandHome(process.env.WEB_DIST_DIR ?? '')
  if (raw) {
    return path.isAbsolute(raw) ? raw : path.resolve(findRepoRoot(process.cwd()), raw)
  }
  return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../web/dist')
}

export function serverPort(): number {
  return Number(process.env.PORT ?? 10140)
}

/**
 * 待ち受けアドレス。**意図的に定数**（環境変数で上書きさせない）。
 * 本アプリは認証を持たず、ループバック限定バインドが唯一の防壁であるため、外部公開へ
 * 切り替える手段を提供してはならない（local-access spec「外部公開へ切り替える設定を持たない」）。
 */
export const LOOPBACK_HOST = '127.0.0.1'

export function isProduction(): boolean {
  return process.env.NODE_ENV === 'production'
}

