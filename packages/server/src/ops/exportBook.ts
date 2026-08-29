import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { tmpDir, bookDbPath, attachmentDir } from '../config.js'
import type { DbRouter } from '../db/router.js'
import { books } from '../db/control/schema.js'
import { checkSqliteIntegrity } from './backup.js'
import { sha256File } from './fsops.js'
import { assertValidBookId } from '../db/ids.js'
import { writeZip, type ZipEntry } from './zip.js'

/**
 * フルデータエクスポート（データ主権）。「解約＝データ人質」への構造的アンサーとして、
 * 1帳簿の全データ（会計DB＋証憑＋manifest）を1つの zip に組成する。
 *
 * zip レイアウトは $DATA_DIR の物理配置をそのまま鏡写しにする:
 *   manifest.json                      … exportedAt / bookId / bookName / DB sha256 / ファイル数
 *   books/{bookId}.sqlite              … data plane の WAL 整合スナップショット
 *   books/{bookId}/attachments/...     … 証憑の実ファイル（再帰）
 * → 解凍して books/ を DATA_DIR に置けば別環境の Kanean がそのまま読める。
 *
 * DB スナップショットは better-sqlite3 `.backup()`（ops/backup.ts と同じ流儀）。
 * 一時ファイルは os.tmpdir でなく $DATA_DIR/tmp/ を使う（同一FSで rename 可能・権限が
 * DATA_DIR と一貫）。終了時に必ず削除する。
 */

export interface ExportBookResult {
  /** zip に入れたエントリ総数（manifest.json＋DB＋証憑）。 */
  fileCount: number
  /** 生成した zip のバイト数。 */
  byteSize: number
}

/**
 * attachments/ を再帰列挙する。symlink は辿らない（ディレクトリ外への脱出を防ぐ）。
 * パス脱出（'..' 等）を含む名前は除外する（通常の FS では作れないが多層防御）。
 */
function listAttachmentFiles(root: string): { abs: string; rel: string }[] {
  if (!fs.existsSync(root)) return []
  const out: { abs: string; rel: string }[] = []
  const walk = (dir: string, rel: string): void => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      if (ent.isSymbolicLink()) continue
      if (ent.name.includes('..') || ent.name.includes('/') || ent.name.includes('\\')) continue
      const abs = path.join(dir, ent.name)
      const relPath = rel === '' ? ent.name : `${rel}/${ent.name}`
      if (ent.isDirectory()) walk(abs, relPath)
      else if (ent.isFile()) out.push({ abs, rel: relPath })
    }
  }
  walk(root, '')
  // 列挙順を安定させる（テスト・再現性）。
  return out.sort((a, b) => (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0))
}

/** 1帳簿の全データ（DB＋証憑＋manifest）を outPath の zip へ組成する。 */
export async function exportBookData(
  router: DbRouter,
  bookId: string,
  outPath: string,
): Promise<ExportBookResult> {
  assertValidBookId(bookId)
  const bookName = router.controlDb().select().from(books).where(eq(books.id, bookId)).all()[0]?.name ?? null
  // data plane を開いておく（未作成でも migrate＋seed 済みの正規 DB を確実に持つ）。
  router.bookDb(bookId)

  const tmp = tmpDir()
  fs.mkdirSync(tmp, { recursive: true })
  const tmpDb = path.join(tmp, `export-${bookId}-${randomUUID()}.sqlite`)
  try {
    // ① 帳簿 DB を WAL 整合のオンラインバックアップで一時ファイルへ（ops/backup.ts と同パターン）。
    let src: Database.Database | undefined
    try {
      src = new Database(bookDbPath(bookId))
      await src.backup(tmpDb)
    } finally {
      src?.close()
    }
    // `.backup()` はページ単位の生コピーで、元 DB が静かに破損していても成功してしまう。
    // 破損スナップショットを zip に固めると取り込み先で初めて 400 になり、元環境ではもう原因を
    // 追えない。backup と同じくここで検証し、'ok' 以外は zip を作らず失敗させる。
    const integrity = checkSqliteIntegrity(tmpDb)
    if (integrity !== 'ok')
      throw new Error(`帳簿DBの整合性検査に失敗しました（integrity_check: ${integrity}）`)

    // ② 証憑を再帰列挙（symlink・パス脱出は除外）。列挙後に消えたファイル（別タブでの削除・
    // 再取込の置換）は stat で検出してスキップし、1ファイルの消失で数百件のエクスポート全体を
    // 500 にしない。stat〜zip 書込みの残余レース（ミリ秒）は許容し、そこで消えた場合のみ失敗する。
    const attachments: { abs: string; rel: string; size: number }[] = []
    let skippedAttachments = 0
    for (const f of listAttachmentFiles(attachmentDir(bookId))) {
      try {
        attachments.push({ ...f, size: fs.statSync(f.abs).size })
      } catch {
        skippedAttachments++
      }
    }
    const attachmentEntries: ZipEntry[] = attachments.map((f) => ({
      name: `books/${bookId}/attachments/${f.rel}`,
      data: f.abs,
    }))
    const attachmentBytes = attachments.reduce((sum, f) => sum + f.size, 0)

    // ③ manifest.json（エクスポートの自己記述。DB の完全性検証に使える sha256 を含む）。
    const dbEntryName = `books/${bookId}.sqlite`
    const fileCount = 2 + attachmentEntries.length // manifest.json＋DB＋証憑
    const manifest = {
      format: 'kanean-export',
      formatVersion: 1,
      exportedAt: new Date().toISOString(),
      bookId,
      bookName,
      database: {
        path: dbEntryName,
        sha256: sha256File(tmpDb),
        byteSize: fs.statSync(tmpDb).size,
      },
      attachments: { count: attachments.length, totalBytes: attachmentBytes, skipped: skippedAttachments },
      fileCount,
    }

    const entries: ZipEntry[] = [
      {
        name: 'manifest.json',
        data: Buffer.from(JSON.stringify(manifest, null, 2) + '\n', 'utf8'),
      },
      { name: dbEntryName, data: tmpDb },
      ...attachmentEntries,
    ]
    const { byteSize } = writeZip(outPath, entries)
    return { fileCount, byteSize }
  } finally {
    fs.rmSync(tmpDb, { force: true })
  }
}
