import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/**
 * ops/ の FS プリミティブ（issue #145）。backup / restore / exportBook / importBook で
 * 逐語コピーされていた「壊れると復旧不能な規約」をここへ一本化する。
 */

/** 帳簿 DB ファイルの拡張子（`books/{bookId}.sqlite`）。backup の列挙と restore の逆引きで共用。 */
export const SQLITE_RE = /\.sqlite$/

/** ファイルの SHA-256（hex）。DB は個人会計規模（MB オーダー）なので一括読みで足りる。 */
export function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex')
}

/**
 * DB 本体と WAL/SHM の残骸を destDir へまとめて移動する。
 * 残骸を残したまま別内容の DB を置くと、次のオープンで旧 WAL が適用され破損するため必ず一緒に動かす。
 */
export function moveDbWithWal(file: string, destDir: string): void {
  for (const suffix of ['', '-wal', '-shm']) {
    const src = file + suffix
    if (fs.existsSync(src)) fs.renameSync(src, path.join(destDir, path.basename(src)))
  }
}
