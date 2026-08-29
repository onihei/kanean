import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { eq } from 'drizzle-orm'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { books, backupStatus } from '../../db/control/schema.js'
import { backupAllDatabases } from '../backup.js'
import { dataDir } from '../../config.js'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-backup-'))
  process.env.DATA_DIR = tmp
  migrateControlDb() // control の books / backup_status テーブルを作る。
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** control.books へ登録し、data plane を作成（FK＝backup_status.user_id を満たす）。 */
function provisionUser(router: DbRouter, id: string): void {
  router.controlDb().insert(books).values({ id, name: 'テスト帳簿', createdAt: 'x', updatedAt: 'x' }).run()
  router.bookDb(id) // open + migrate + seed
}

describe('バックアップ（WAL整合スナップショット・世代保持）', () => {
  it('control と全 data plane をバックアップし、内容が読み出せる', async () => {
    const router = new DbRouter()
    provisionUser(router, 'u_a')
    provisionUser(router, 'u_b')

    const r = await backupAllDatabases({ now: new Date('2026-06-03T08:30:00.000Z') })
    expect(r.control.ok).toBe(true)
    expect(r.books.map((b) => b.bookId).sort()).toEqual(['u_a', 'u_b'])
    expect(r.books.every((b) => b.ok)).toBe(true)

    expect(fs.existsSync(path.join(r.backupDir, 'control.sqlite'))).toBe(true)
    // バックアップした data plane が読み出せる（seed の accounts が入っている）。
    const bak = new Database(path.join(r.backupDir, 'books', 'u_a.sqlite'), { readonly: true })
    const n = (bak.prepare('SELECT count(*) AS c FROM accounts').get() as { c: number }).c
    bak.close()
    expect(n).toBeGreaterThan(0)
  })

  it('backup_status に per-user の成功を記録する', async () => {
    provisionUser(new DbRouter(), 'u_a')
    await backupAllDatabases({ now: new Date('2026-06-03T08:30:00.000Z') })
    const rows = new DbRouter().controlDb().select().from(backupStatus).where(eq(backupStatus.bookId, 'u_a')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ lastStatus: 'success', lastBackupAt: '2026-06-03T08:30:00.000Z' })
  })

  it('世代保持: retention 件を残して古いセットを削除', async () => {
    provisionUser(new DbRouter(), 'u_a')
    await backupAllDatabases({ retention: 2, now: new Date('2026-06-01T00:00:00.000Z') })
    await backupAllDatabases({ retention: 2, now: new Date('2026-06-02T00:00:00.000Z') })
    const third = await backupAllDatabases({ retention: 2, now: new Date('2026-06-03T00:00:00.000Z') })
    expect(third.prunedSets).toEqual(['2026-06-01T00-00-00-000'])
    const sets = fs.readdirSync(path.join(dataDir(), 'backups')).filter((d) => /^\d{4}-/.test(d)).sort()
    expect(sets).toEqual(['2026-06-02T00-00-00-000', '2026-06-03T00-00-00-000'])
  })

  it('一部の data plane が壊れていても他は成功し、失敗は status に記録・破損出力は残さない', async () => {
    const router = new DbRouter()
    provisionUser(router, 'u_ok')
    // 不正な SQLite を持つユーザー（バックアップが失敗する）。
    router.controlDb().insert(books).values({ id: 'u_bad', name: 'テスト帳簿', createdAt: 'x', updatedAt: 'x' }).run()
    fs.writeFileSync(path.join(dataDir(), 'books', 'u_bad.sqlite'), 'NOT A SQLITE DATABASE')

    const r = await backupAllDatabases({ now: new Date('2026-06-03T00:00:00.000Z') })
    expect(r.books.find((b) => b.bookId === 'u_ok')!.ok).toBe(true)
    expect(r.books.find((b) => b.bookId === 'u_bad')!.ok).toBe(false)
    expect(fs.existsSync(path.join(r.backupDir, 'books', 'u_ok.sqlite'))).toBe(true)
    // 失敗ユーザーの中途半端な出力は残さない。
    expect(fs.existsSync(path.join(r.backupDir, 'books', 'u_bad.sqlite'))).toBe(false)
    // control（最後にバックアップ）は成功し、status に失敗が記録される。
    expect(r.control.ok).toBe(true)
    const st = new DbRouter().controlDb().select().from(backupStatus).where(eq(backupStatus.bookId, 'u_bad')).all()
    expect(st[0].lastStatus).toBe('failed')
  })

  it('再実行で backup_status は1ユーザー1行（洗い替え）', async () => {
    provisionUser(new DbRouter(), 'u_a')
    await backupAllDatabases({ now: new Date('2026-06-01T00:00:00.000Z') })
    await backupAllDatabases({ now: new Date('2026-06-02T00:00:00.000Z') })
    const rows = new DbRouter().controlDb().select().from(backupStatus).where(eq(backupStatus.bookId, 'u_a')).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].lastBackupAt).toBe('2026-06-02T00:00:00.000Z')
  })

  it('証憑（attachments）を DB スナップショットへ同梱し、無いユーザーはスキップする', async () => {
    const router = new DbRouter()
    provisionUser(router, 'u_a')
    provisionUser(router, 'u_b')
    const attach = path.join(dataDir(), 'books', 'u_a', 'attachments')
    fs.mkdirSync(attach, { recursive: true })
    fs.writeFileSync(path.join(attach, 'receipt-1'), 'RECEIPT BYTES')

    const r = await backupAllDatabases({ now: new Date('2026-06-03T08:30:00.000Z') })
    expect(r.books.every((b) => b.ok)).toBe(true)
    // DB と同じスナップショット内に実ファイルが入る（sha256 突合で検証できる完全なセット）。
    const copied = path.join(r.backupDir, 'books', 'u_a', 'attachments', 'receipt-1')
    expect(fs.readFileSync(copied, 'utf8')).toBe('RECEIPT BYTES')
    // attachments が無い u_b はディレクトリ自体を作らない（スキップ）。
    expect(fs.existsSync(path.join(r.backupDir, 'books', 'u_b'))).toBe(false)
  })

  it('control.sqlite 不在なら throw し、空DBもバックアップも生成しない（D5 偽成功ガード）', async () => {
    for (const suffix of ['', '-wal', '-shm']) {
      fs.rmSync(path.join(tmp, `control.sqlite${suffix}`), { force: true })
    }
    await expect(backupAllDatabases()).rejects.toThrow(/control\.sqlite が見つかりません/)
    // openSqlite による暗黙生成が起きていない＋空セットのディレクトリも作られていない。
    expect(fs.existsSync(path.join(tmp, 'control.sqlite'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'backups'))).toBe(false)
  })

  it('ページ破損した DB は integrity_check で失敗扱いにし、破損スナップショットを残さない', async () => {
    const router = new DbRouter()
    provisionUser(router, 'u_ok')
    router.controlDb().insert(books).values({ id: 'u_corrupt', name: 'テスト帳簿', createdAt: 'x', updatedAt: 'x' }).run()
    // 有効な SQLite を作ってから中間ページを破壊する。`.backup()` はページ単位の生コピーで
    // 成功してしまうため、integrity_check なしだと破損がそのまま「成功」保存される（この穴の再現）。
    const file = path.join(dataDir(), 'books', 'u_corrupt.sqlite')
    const db = new Database(file)
    db.pragma('journal_mode = DELETE') // WAL 経由で破壊が隠れないように
    db.exec('CREATE TABLE t (id INTEGER PRIMARY KEY, v TEXT)')
    const ins = db.prepare('INSERT INTO t (v) VALUES (?)')
    for (let i = 0; i < 500; i++) ins.run('x'.repeat(100))
    db.close()
    const buf = fs.readFileSync(file)
    const pageSize = buf.readUInt16BE(16) // SQLite ヘッダ 16-17 バイト目＝ページサイズ
    buf.fill(0xff, pageSize, pageSize * 2) // 2ページ目を破壊（ヘッダは温存＝open は成功する）
    fs.writeFileSync(file, buf)

    const r = await backupAllDatabases({ now: new Date('2026-06-03T00:00:00.000Z') })
    const bad = r.books.find((b) => b.bookId === 'u_corrupt')!
    expect(bad.ok).toBe(false)
    expect(bad.error).toMatch(/integrity_check/)
    expect(fs.existsSync(path.join(r.backupDir, 'books', 'u_corrupt.sqlite'))).toBe(false)
    expect(r.books.find((b) => b.bookId === 'u_ok')!.ok).toBe(true)
    const st = new DbRouter().controlDb().select().from(backupStatus).where(eq(backupStatus.bookId, 'u_corrupt')).all()
    expect(st[0].lastStatus).toBe('failed')
  })
})
