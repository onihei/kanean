import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import Database from 'better-sqlite3'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { backupAllDatabases } from '../backup.js'
import { listSnapshots, inspectSnapshot, restoreFromSnapshot } from '../restore.js'
import { dataDir } from '../../config.js'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-restore-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** control.books へ登録し、data plane を作成（backup.test.ts と同型）。 */
function provisionUser(router: DbRouter, id: string): void {
  router.controlDb().insert(books).values({ id, name: 'テスト帳簿', createdAt: 'x', updatedAt: 'x' }).run()
  router.bookDb(id)
}

/** テスト用の証憑ファイルを直接配置する（storage.ts を経由しない＝bookId 形式に依存しない）。 */
function writeAttachment(bookId: string, name: string, content: string): string {
  const dir = path.join(dataDir(), 'books', bookId, 'attachments')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, name)
  fs.writeFileSync(file, content)
  return file
}

describe('リストア（退避→コピー配置・整合性検証）', () => {
  it('listSnapshots がセットごとの timestamp・帳簿・integrity を新しい順で返す', async () => {
    provisionUser(new DbRouter(), 'u_a')
    writeAttachment('u_a', 'r1', 'A')
    await backupAllDatabases({ now: new Date('2026-06-01T00:00:00.000Z') })
    await backupAllDatabases({ now: new Date('2026-06-02T00:00:00.000Z') })

    const sets = listSnapshots()
    expect(sets.map((s) => s.timestamp)).toEqual(['2026-06-02T00-00-00-000', '2026-06-01T00-00-00-000'])
    expect(sets[0].hasControl).toBe(true)
    expect(sets[0].controlIntegrity).toBe('ok')
    expect(sets[0].books).toEqual([{ bookId: 'u_a', integrity: 'ok', hasAttachments: true }])
  })

  it('dry-run（apply なし）は検査結果だけ返し、現行データにも FS にも触れない', async () => {
    provisionUser(new DbRouter(), 'u_a')
    const { timestamp } = await backupAllDatabases({ now: new Date('2026-06-01T00:00:00.000Z') })

    const r = restoreFromSnapshot(timestamp, { now: new Date('2026-06-05T00:00:00.000Z') })
    expect(r.applied).toBe(false)
    expect(r.snapshot.books.map((b) => b.bookId)).toEqual(['u_a'])
    // 退避ディレクトリは作られない。
    expect(fs.existsSync(r.preRestoreDir)).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'control.sqlite'))).toBe(true)
  })

  it('--apply: 現行データ（DB・WAL残骸・attachments）を退避し、スナップショットをコピーで配置する', async () => {
    const router = new DbRouter()
    provisionUser(router, 'u_a')
    writeAttachment('u_a', 'r1', 'V1')
    const { timestamp, backupDir } = await backupAllDatabases({
      now: new Date('2026-06-01T00:00:00.000Z'),
    })

    // バックアップ後に現行データを変異させる（＝復元で巻き戻ることを観測する差分）。
    const userDbFile = path.join(tmp, 'books', 'u_a.sqlite')
    const mut = new Database(userDbFile)
    mut.exec('CREATE TABLE marker (x INTEGER)')
    mut.close()
    fs.writeFileSync(path.join(tmp, 'books', 'u_a', 'attachments', 'r1'), 'V2')
    // DB 本体の無い WAL 残骸（復元後の DB と混ざると破損する典型）も退避されること。
    fs.writeFileSync(path.join(tmp, 'books', 'u_zombie.sqlite-wal'), 'STALE WAL')

    const r = restoreFromSnapshot(timestamp, {
      apply: true,
      now: new Date('2026-06-05T00:00:00.000Z'),
    })
    expect(r.applied).toBe(true)

    // 退避先: 変異後の現行データ一式（marker 入りDB・V2 証憑・WAL 残骸）が丸ごと移動している。
    const pre = r.preRestoreDir
    expect(pre).toBe(path.join(tmp, 'pre-restore-2026-06-05T00-00-00-000'))
    expect(fs.existsSync(path.join(pre, 'control.sqlite'))).toBe(true)
    expect(fs.readFileSync(path.join(pre, 'books', 'u_a', 'attachments', 'r1'), 'utf8')).toBe('V2')
    expect(fs.readFileSync(path.join(pre, 'books', 'u_zombie.sqlite-wal'), 'utf8')).toBe('STALE WAL')

    // 現行: WAL/SHM 残骸が books/ に残っていない（先に確認してから DB を開く）。
    const leftovers = fs.readdirSync(path.join(tmp, 'books')).filter((f) => /-(wal|shm)$/.test(f))
    expect(leftovers).toEqual([])
    // 現行: スナップショット時点へ巻き戻っている（marker 無し・証憑は V1）。
    const restored = new Database(userDbFile)
    const markers = restored
      .prepare("SELECT count(*) AS c FROM sqlite_master WHERE name = 'marker'")
      .get() as { c: number }
    restored.close()
    expect(markers.c).toBe(0)
    expect(fs.readFileSync(path.join(tmp, 'books', 'u_a', 'attachments', 'r1'), 'utf8')).toBe('V1')
    // スナップショット自体は温存（コピー配置＝rename ではない）。再リストアできる。
    expect(fs.existsSync(path.join(backupDir, 'control.sqlite'))).toBe(true)
    expect(fs.existsSync(path.join(backupDir, 'books', 'u_a.sqlite'))).toBe(true)
  })

  it('破損したスナップショットは --apply を拒否し、現行データに一切触れない', async () => {
    provisionUser(new DbRouter(), 'u_a')
    const { timestamp, backupDir } = await backupAllDatabases({
      now: new Date('2026-06-01T00:00:00.000Z'),
    })
    // スナップショット側のユーザーDBを破壊（integrity_check が 'ok' 以外を返す）。
    fs.writeFileSync(path.join(backupDir, 'books', 'u_a.sqlite'), 'NOT A SQLITE DATABASE')

    expect(() =>
      restoreFromSnapshot(timestamp, { apply: true, now: new Date('2026-06-05T00:00:00.000Z') }),
    ).toThrow(/整合性検証に失敗/)
    // 退避すら行われず、現行データは無傷。
    expect(fs.existsSync(path.join(tmp, 'pre-restore-2026-06-05T00-00-00-000'))).toBe(false)
    expect(fs.existsSync(path.join(tmp, 'control.sqlite'))).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'books', 'u_a.sqlite'))).toBe(true)
  })

  it('不正なタイムスタンプ・存在しないスナップショットはエラー（パストラバーサル拒否を含む）', () => {
    expect(() => inspectSnapshot('../evil')).toThrow(/不正なタイムスタンプ形式/)
    expect(() => restoreFromSnapshot('2026-01-01T00-00-00-000')).toThrow(/見つかりません/)
  })
})
