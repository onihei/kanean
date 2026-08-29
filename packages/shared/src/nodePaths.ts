import os from 'node:os'
import path from 'node:path'
import { SOCKET_FILENAME } from './appLink.js'

/**
 * プロセス間契約のうち node（os/path）が要る既定パス（issue #167）。
 * web に混ぜないよう index からは export せず、`@kanean/shared/node` の subpath で公開する。
 */

/** デスクトップ版の既定 `DATA_DIR`（macOS の `<userData>/data`）。 */
export function defaultDataDir(): string {
  return path.join(os.homedir(), 'Library', 'Application Support', 'Kanean', 'data')
}

/** `$DATA_DIR/kanean.sock`（ローカル連携の unix socket）。 */
export function socketPathIn(dataDir: string): string {
  return path.join(dataDir, SOCKET_FILENAME)
}
