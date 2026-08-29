import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { fixedAssets } from '../../db/data/schema.js'
import { dataDir } from '../../config.js'
import { listBooks } from '../../books/resolve.js'
import { exportBookData } from '../../ops/exportBook.js'
import { createZip } from '../../ops/zip.js'
import { importRoutes } from '../import.js'

/**
 * `POST /api/import` の HTTP 契約（restorable-export）。
 * 取り込みは **withBook より前**にマウントされるので、対象帳簿の指定なしで呼べる
 * （帳簿が1冊も無い環境で最初に叩かれるのが本来の用途）。
 */

const BOOK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

let srcDir: string
let dstDir: string
beforeEach(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-importroute-src-'))
  dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-importroute-dst-'))
})
afterEach(() => {
  fs.rmSync(srcDir, { recursive: true, force: true })
  fs.rmSync(dstDir, { recursive: true, force: true })
})

/** 元環境でエクスポート zip を作り、そのバイト列を返す。 */
async function exportedZip(): Promise<Buffer> {
  process.env.DATA_DIR = srcDir
  migrateControlDb()
  const router = new DbRouter()
  router
    .controlDb()
    .insert(books)
    .values({ id: BOOK_ID, name: 'マツダ商店', createdAt: 'x', updatedAt: 'x' })
    .run()
  router.bookDb(BOOK_ID).insert(fixedAssets).values({
    name: 'マツダ2',
    acquisitionCost: 2_200_000,
    depreciationMethod: 'declining_balance',
    createdAt: 'x',
    updatedAt: 'x',
  }).run()
  const zipPath = path.join(srcDir, 'export.zip')
  await exportBookData(router, BOOK_ID, zipPath)
  return fs.readFileSync(zipPath)
}

/** 取り込み先環境（帳簿0冊）にルートをマウントする。 */
function setup() {
  process.env.DATA_DIR = dstDir
  migrateControlDb()
  const router = new DbRouter()
  const app = new Hono()
  app.route('/api', importRoutes(router))
  return { app, router }
}

/** zip の生バイト列を body に載せた POST。 */
async function post(app: Hono, url: string, zip: Buffer): Promise<Response> {
  return app.request(url, {
    method: 'POST',
    body: new Uint8Array(zip),
    headers: { 'Content-Type': 'application/zip' },
  })
}

describe('POST /api/import（エクスポートの取り込み）', () => {
  it('帳簿0冊の環境へ zip を投げると帳簿として登録される', async () => {
    const zip = await exportedZip()
    const { app, router } = setup()
    expect(listBooks(router)).toHaveLength(0)

    const res = await post(app, '/api/import', zip)

    expect(res.status).toBe(201)
    const body = (await res.json()) as { bookId: string; bookName: string; outcome: string }
    expect(body).toMatchObject({ bookId: BOOK_ID, bookName: 'マツダ商店', outcome: 'same-id' })
    expect(listBooks(router).map((b) => b.id)).toEqual([BOOK_ID])
    expect(router.bookDb(BOOK_ID).select().from(fixedAssets).all()[0].name).toBe('マツダ2')
  })

  it('bookId が衝突すると 409 で、選択に必要な帳簿名を返す', async () => {
    const zip = await exportedZip()
    const { app, router } = setup()
    await post(app, '/api/import', zip)

    const res = await post(app, '/api/import', zip)

    expect(res.status).toBe(409)
    const body = (await res.json()) as {
      error: { code: string }
      conflict: { bookId: string; incomingName: string; existingName: string }
    }
    expect(body.error.code).toBe('book_id_conflict')
    expect(body.conflict).toEqual({
      bookId: BOOK_ID,
      incomingName: 'マツダ商店',
      existingName: 'マツダ商店',
    })
    expect(listBooks(router)).toHaveLength(1) // 黙って増えていない
  })

  it('?mode=new で別 ULID の帳簿として取り込む', async () => {
    const zip = await exportedZip()
    const { app, router } = setup()
    await post(app, '/api/import', zip)

    const res = await post(app, '/api/import?mode=new', zip)

    expect(res.status).toBe(201)
    const body = (await res.json()) as { bookId: string; outcome: string; sourceBookId: string }
    expect(body.outcome).toBe('new-id')
    expect(body.bookId).not.toBe(BOOK_ID)
    expect(body.sourceBookId).toBe(BOOK_ID)
    expect(listBooks(router)).toHaveLength(2)
  })

  it('?mode=replace で既存を置換する', async () => {
    const zip = await exportedZip()
    const { app, router } = setup()
    await post(app, '/api/import', zip)
    router.bookDb(BOOK_ID).insert(fixedAssets).values({
      name: '置換で消える資産',
      acquisitionCost: 1,
      depreciationMethod: 'straight_line',
      createdAt: 'x',
      updatedAt: 'x',
    }).run()

    const res = await post(app, '/api/import?mode=replace', zip)

    expect(res.status).toBe(201)
    expect((await res.json()) as { outcome: string }).toMatchObject({ outcome: 'replaced' })
    expect(listBooks(router)).toHaveLength(1)
    expect(router.bookDb(BOOK_ID).select().from(fixedAssets).all().map((a) => a.name)).toEqual([
      'マツダ2',
    ])
  })

  it('不正な mode は 400', async () => {
    const zip = await exportedZip()
    const { app } = setup()
    const res = await post(app, '/api/import?mode=merge', zip)
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error')
  })

  it('Kanean のエクスポートでない zip は 400 で理由を返す（既存に触れない）', async () => {
    const { app, router } = setup()
    const bogus = createZip([{ name: 'readme.txt', data: Buffer.from('hello') }])

    const res = await post(app, '/api/import', bogus)

    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('invalid_export')
    expect(body.error.message).toMatch(/manifest\.json/)
    expect(listBooks(router)).toHaveLength(0)
  })

  it('受信した一時 zip（$DATA_DIR/tmp/）を残さない', async () => {
    const zip = await exportedZip()
    const { app } = setup()
    await post(app, '/api/import', zip)
    const tmpDir = path.join(dataDir(), 'tmp')
    const leftovers = fs.existsSync(tmpDir) ? fs.readdirSync(tmpDir) : []
    expect(leftovers).toEqual([])
  })
})
