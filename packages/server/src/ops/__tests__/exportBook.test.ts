import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import Database from 'better-sqlite3'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { writeAttachmentFile } from '../../attachments/storage.js'
import { attachmentDir } from '../../config.js'
import { exportBookData } from '../exportBook.js'
import { readZip, crc32Reference } from './zipTestUtil.js'

// attachments/storage.ts の ULID ガードを満たす形式のテストユーザー ID。
const UID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-export-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** control.books へ登録し、data plane（migrate＋seed）を作る。 */
function provisionUser(router: DbRouter, id: string): void {
  router.controlDb().insert(books).values({ id, name: 'テスト帳簿', createdAt: 'x', updatedAt: 'x' }).run()
  router.bookDb(id)
}

interface Manifest {
  format: string
  formatVersion: number
  exportedAt: string
  bookId: string
  database: { path: string; sha256: string; byteSize: number }
  attachments: { count: number; totalBytes: number }
  fileCount: number
}

describe('exportBookData（フルデータエクスポート）', () => {
  it('DB・証憑・manifest が zip に入り、DB スナップショットが開ける', async () => {
    const router = new DbRouter()
    provisionUser(router, UID)
    // 証憑2件: 正規ルート（writeAttachmentFile）＋手置きのネスト・日本語名（再帰列挙の検証）。
    const receipt = Buffer.from('%PDF-1.4 dummy receipt')
    const stored = writeAttachmentFile(UID, receipt)
    const nestedDir = path.join(attachmentDir(UID), 'sub')
    fs.mkdirSync(nestedDir, { recursive: true })
    const nested = Buffer.from('ネストされた証憑')
    fs.writeFileSync(path.join(nestedDir, '請求書.txt'), nested)

    const outPath = path.join(tmp, 'out', 'export.zip')
    const r = await exportBookData(router, UID, outPath)

    // 返り値: manifest＋DB＋証憑2件 / zip 実サイズ。
    expect(r.fileCount).toBe(4)
    expect(r.byteSize).toBe(fs.statSync(outPath).size)

    const entries = readZip(fs.readFileSync(outPath))
    const names = entries.map((e) => e.name)
    expect(names).toContain('manifest.json')
    expect(names).toContain(`books/${UID}.sqlite`)
    expect(names).toContain(`books/${UID}/attachments/${stored.storedName}`)
    expect(names).toContain(`books/${UID}/attachments/sub/請求書.txt`)
    expect(entries).toHaveLength(4)

    // 証憑の内容と CRC が一致する。
    const att = entries.find((e) => e.name.endsWith(stored.storedName))!
    expect(att.data.equals(receipt)).toBe(true)
    expect(att.crc).toBe(crc32Reference(receipt))
    expect(entries.find((e) => e.name.endsWith('請求書.txt'))!.data.equals(nested)).toBe(true)

    // manifest: exportedAt ISO・DB sha256・ファイル数。
    const manifest = JSON.parse(
      entries.find((e) => e.name === 'manifest.json')!.data.toString('utf8'),
    ) as Manifest
    expect(manifest.format).toBe('kanean-export')
    expect(manifest.bookId).toBe(UID)
    expect(new Date(manifest.exportedAt).toISOString()).toBe(manifest.exportedAt)
    expect(manifest.fileCount).toBe(4)
    expect(manifest.attachments).toEqual({ count: 2, totalBytes: receipt.length + nested.length, skipped: 0 })

    // DB スナップショット: sha256 が manifest と一致し、better-sqlite3 で開けて整合している。
    const dbBytes = entries.find((e) => e.name === `books/${UID}.sqlite`)!.data
    expect(createHash('sha256').update(dbBytes).digest('hex')).toBe(manifest.database.sha256)
    expect(dbBytes.length).toBe(manifest.database.byteSize)
    const dbFile = path.join(tmp, 'snapshot.sqlite')
    fs.writeFileSync(dbFile, dbBytes)
    const db = new Database(dbFile, { readonly: true })
    try {
      const ic = db.pragma('integrity_check') as { integrity_check: string }[]
      expect(ic[0].integrity_check).toBe('ok')
      // WAL 上の内容（seed の勘定科目）までスナップショットに入っている。
      const n = (db.prepare('SELECT count(*) AS c FROM accounts').get() as { c: number }).c
      expect(n).toBeGreaterThan(0)
    } finally {
      db.close()
    }
  })

  it('証憑が無くても manifest＋DB の zip になる', async () => {
    const router = new DbRouter()
    provisionUser(router, UID)
    const outPath = path.join(tmp, 'export.zip')
    const r = await exportBookData(router, UID, outPath)
    expect(r.fileCount).toBe(2)
    const names = readZip(fs.readFileSync(outPath)).map((e) => e.name)
    expect(names).toEqual(['manifest.json', `books/${UID}.sqlite`])
  })

  it('attachments 内の symlink は列挙から除外する（ディレクトリ外への脱出防止）', async () => {
    const router = new DbRouter()
    provisionUser(router, UID)
    const outside = path.join(tmp, 'outside-secret.txt')
    fs.writeFileSync(outside, 'attachments の外にあるファイル')
    const dir = attachmentDir(UID)
    fs.mkdirSync(dir, { recursive: true })
    fs.symlinkSync(outside, path.join(dir, 'link-to-outside'))

    const outPath = path.join(tmp, 'export.zip')
    const r = await exportBookData(router, UID, outPath)
    expect(r.fileCount).toBe(2) // manifest＋DB のみ（symlink は入らない）
    const names = readZip(fs.readFileSync(outPath)).map((e) => e.name)
    expect(names.some((n) => n.includes('link-to-outside'))).toBe(false)
  })

  it('一時ファイル（$DATA_DIR/tmp/ の DB スナップショット）を終了時に削除する', async () => {
    const router = new DbRouter()
    provisionUser(router, UID)
    await exportBookData(router, UID, path.join(tmp, 'export.zip'))
    const leftovers = fs.readdirSync(path.join(tmp, 'tmp')).filter((f) => f.endsWith('.sqlite'))
    expect(leftovers).toEqual([])
  })

  it('ページ破損した DB は integrity_check で失敗させ、zip を作らない', async () => {
    const router = new DbRouter()
    provisionUser(router, UID)
    // 有効な DB を作ってから WAL を本体へ反映し、中間ページを破壊する。`.backup()` は
    // ページ単位の生コピーで成功してしまうため、検証なしだと破損がそのまま zip に固まる（この穴の再現）。
    const file = path.join(tmp, 'books', `${UID}.sqlite`)
    const ck = new Database(file)
    ck.pragma('wal_checkpoint(TRUNCATE)')
    ck.close()
    const buf = fs.readFileSync(file)
    const pageSize = buf.readUInt16BE(16) // SQLite ヘッダ 16-17 バイト目＝ページサイズ
    buf.fill(0xff, pageSize, pageSize * 2) // 2ページ目を破壊（ヘッダは温存＝open は成功する）
    fs.writeFileSync(file, buf)

    const outPath = path.join(tmp, 'export.zip')
    await expect(exportBookData(router, UID, outPath)).rejects.toThrow(/整合性検査に失敗/)
    expect(fs.existsSync(outPath)).toBe(false) // 破損した zip を残さない
    // 一時スナップショットも残さない
    const leftovers = fs.readdirSync(path.join(tmp, 'tmp')).filter((f) => f.endsWith('.sqlite'))
    expect(leftovers).toEqual([])
  })

  it('ULID 形式でない bookId は拒否する（パス組み立ての多層防御）', async () => {
    const router = new DbRouter()
    await expect(exportBookData(router, '../evil', path.join(tmp, 'x.zip'))).rejects.toThrow(
      /不正な帳簿ID/,
    )
    await expect(exportBookData(router, 'u1', path.join(tmp, 'x.zip'))).rejects.toThrow(
      /不正な帳簿ID/,
    )
  })
})
