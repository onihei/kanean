import fs from 'node:fs'
import path from 'node:path'
import type { BundleStatus } from '@kanean/shared'

/**
 * MCP バンドル（`.mcpb`）の書き出し（mcp-server spec「1クリックで導入できる配布形態」）。
 *
 * 配布物に同梱したバンドルを、利用者に見える場所へコピーして Finder で示す。
 * **クライアントの設定ファイルは書き換えない** — 他アプリの設定を勝手に触るのは行儀が悪く、
 * フォーマット変更に追従し続ける必要があり、既存のエントリを壊すリスクを負う（design D3）。
 *
 * Electron に依存する部分（`shell.showItemInFolder`・`app.getPath`）は呼び出し側から渡す。
 * このモジュール単体をテストできるようにするため。
 */

export const BUNDLE_FILENAME = 'Kanean.mcpb'

export interface BundleEnv {
  /** 配布物に同梱されたバンドルの場所。 */
  sourcePath: string
  /** 書き出し先のディレクトリ（ダウンロードフォルダ等）。 */
  destinationDir: string
  /** 書き出したファイルを Finder で示す。 */
  reveal: (filePath: string) => void
}

/** 同梱物があるか。開発時（Vite + server 単体）はそもそもこのルート自体が無い。 */
export function bundleStatus(env: BundleEnv): BundleStatus {
  return {
    available: fs.existsSync(env.sourcePath),
    steps: [
      '「書き出す」を押すと、ダウンロードフォルダに Kanean.mcpb が置かれます',
      'Claude Desktop を起動しておきます',
      // ウィンドウへ落とすとチャットへの添付になってしまう（実機で確認）。Dock のアイコンへ落とす。
      'そのファイルを Dock の Claude アイコンへドラッグ＆ドロップします（ウィンドウの中に落とすと、拡張の導入ではなくチャットへの添付になります）',
      '確認画面で「インストール」を選ぶと連携が始まります',
    ],
  }
}

/**
 * 配布物に同梱された版（design D5）。**分からなければ null**。
 *
 * この値が、クライアントが名乗った版と突き合わせる基準になる。開発時（同梱物が無い）は
 * 比較対象を持たないので null を返し、呼び出し側は検査そのものを行わない（design D7）。
 * 「分からないから拒否」ではなく「分からないから何も言わない」に倒す ＝ 開発中に
 * MCP を繋いで検証できなくなるのを避ける。
 */
export function bundledVersion(versionFilePath: string): string | null {
  try {
    const raw = fs.readFileSync(versionFilePath, 'utf8').trim()
    return raw === '' ? null : raw
  } catch {
    return null
  }
}

export class BundleMissingError extends Error {
  constructor(sourcePath: string) {
    super(`MCP バンドルが見つかりません: ${sourcePath}`)
    this.name = 'BundleMissingError'
  }
}

/**
 * 書き出して Finder で示す。書き出し先のパスを返す。
 *
 * 同名ファイルは上書きする。中身は配布物と同一で、利用者が編集するものではないため
 * （毎回別名にすると、どれが最新か分からなくなる）。
 */
export function exportBundle(env: BundleEnv): { path: string } {
  if (!fs.existsSync(env.sourcePath)) throw new BundleMissingError(env.sourcePath)

  fs.mkdirSync(env.destinationDir, { recursive: true })
  const dest = path.join(env.destinationDir, BUNDLE_FILENAME)
  fs.copyFileSync(env.sourcePath, dest)
  env.reveal(dest)
  return { path: dest }
}
