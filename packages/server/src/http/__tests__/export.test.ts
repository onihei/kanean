import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { writeAttachmentFile } from '../../attachments/storage.js'
import { dataDir } from '../../config.js'
import { exportRoutes } from '../export.js'
import type { BookVariables } from '../../books/middleware.js'
import { readZip } from '../../ops/__tests__/zipTestUtil.js'

const UID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-exportroute-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** withBook 相当のスタブ（bookId を固定注入）で /api にマウントしたアプリを作る。 */
function setup() {
  const router = new DbRouter()
  router.controlDb().insert(books).values({ id: UID, name: 'テスト帳簿', createdAt: 'x', updatedAt: 'x' }).run()
  router.bookDb(UID)
  const app = new Hono<{ Variables: BookVariables }>()
  app.use('*', async (c, next) => {
    c.set('bookId', UID)
    await next()
  })
  app.route('/api', exportRoutes(router))
  return { app, router }
}

/** 一時 zip の削除（stream close で unlink）は非同期のため、少し待って確認する。 */
async function waitForCleanup(dir: string, timeoutMs = 2000): Promise<string[]> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    const zips = fs.existsSync(dir) ? fs.readdirSync(dir).filter((f) => f.endsWith('.zip')) : []
    if (zips.length === 0 || Date.now() > deadline) return zips
    await new Promise((r) => setTimeout(r, 25))
  }
}

describe('GET /api/export（フルデータエクスポート）', () => {
  it('application/zip＋Content-Disposition で zip をストリーム返却する', async () => {
    const { app } = setup()
    const receipt = Buffer.from('receipt bytes')
    writeAttachmentFile(UID, receipt)

    const res = await app.request('/api/export')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toContain('application/zip')
    // RFC5987: attachment; filename*=UTF-8''kanean-export-YYYYMMDD.zip
    expect(res.headers.get('Content-Disposition')).toMatch(
      /^attachment; filename\*=UTF-8''kanean-export-\d{8}\.zip$/,
    )

    const body = Buffer.from(await res.arrayBuffer())
    expect(Number(res.headers.get('Content-Length'))).toBe(body.length)
    const names = readZip(body).map((e) => e.name)
    expect(names).toContain('manifest.json')
    expect(names).toContain(`books/${UID}.sqlite`)
    expect(names.some((n) => n.startsWith(`books/${UID}/attachments/`))).toBe(true)
  })

  it('送出後に一時 zip（$DATA_DIR/tmp/）を削除する', async () => {
    const { app } = setup()
    const res = await app.request('/api/export')
    expect(res.status).toBe(200)
    await res.arrayBuffer() // ストリームを最後まで消費 → close → unlink
    expect(await waitForCleanup(path.join(dataDir(), 'tmp'))).toEqual([])
  })
})
