import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { ACQUISITION_PARTITION } from '@kanean/acquisition/runtime/electron'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { exportBookData } from '../../ops/exportBook.js'
import { openZip } from '../../ops/zip.js'
import { diagnosticsDir, selectorsPath } from '@kanean/acquisition'
import { dataDir } from '../../config.js'

/**
 * 巡回のログイン状態は**パスワードに準じる秘密**（acquisition spec）。
 * 「同期・エクスポート・バックアップの対象に含めない」を、注意ではなく検証できる形にしておく。
 */

let tmp: string
const BOOK = '01ARZ3NDEKTSV4RRFFQ69G5FAV' // 帳簿 id は ULID（エクスポートが検証する）

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-secret-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('巡回セッションの置き場所', () => {
  it('会計データの領域（$DATA_DIR）には置かない', () => {
    // Electron の永続区画は userData 配下に作られる。`$DATA_DIR` を指す名前ではないこと。
    expect(ACQUISITION_PARTITION.startsWith('persist:')).toBe(true)
    expect(ACQUISITION_PARTITION).not.toContain(tmp)
    expect(ACQUISITION_PARTITION).not.toContain('/')
  })

  it('較正・診断は $DATA_DIR 側だが、秘密ではない（人にも AI にも渡してよい）', () => {
    expect(selectorsPath(tmp, 'bank_ufj').startsWith(tmp)).toBe(true)
    expect(diagnosticsDir(tmp, 'bank_ufj').startsWith(tmp)).toBe(true)
  })
})

describe('エクスポート', () => {
  it('取込まわりのファイルを持ち出さない', async () => {
    const router = new DbRouter()
    router.controlDb().insert(books).values({ id: BOOK, name: 'テスト帳簿', createdAt: 'x', updatedAt: 'x' }).run()
    router.bookDb(BOOK)

    // 巡回まわりの成果物（診断・較正・ジョブ）が $DATA_DIR にある状態を作る
    const diag = diagnosticsDir(dataDir(), 'bank_ufj')
    fs.mkdirSync(diag, { recursive: true })
    fs.writeFileSync(path.join(diag, 'page.html'), '<html>ログイン後の画面</html>')
    fs.mkdirSync(path.dirname(selectorsPath(dataDir(), 'bank_ufj')), { recursive: true })
    fs.writeFileSync(selectorsPath(dataDir(), 'bank_ufj'), '{"loggedInText":"ログアウト"}')
    const jobs = path.join(dataDir(), 'acquisition', 'jobs')
    fs.mkdirSync(jobs, { recursive: true })
    fs.writeFileSync(path.join(jobs, 'job-1.json'), '{"jobId":"job-1"}')

    const zipPath = path.join(tmp, 'out.zip')
    await exportBookData(router, BOOK, zipPath)
    const names = openZip(zipPath).entries.map((e) => e.name)

    expect(names.some((n) => n.includes('acquisition'))).toBe(false)
    expect(names.some((n) => n.includes('selectors'))).toBe(false)
    expect(names.some((n) => n.includes('diagnostics'))).toBe(false)
    // 会計データ本体は入っている（この検証が「空の zip だから通った」ではないことの担保）
    expect(names.some((n) => n.endsWith('.sqlite'))).toBe(true)
  })
})
