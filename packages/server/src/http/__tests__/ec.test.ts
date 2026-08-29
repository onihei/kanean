import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { DbRouter, migrateControlDb, type DataDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, subAccounts, fiscalYears } from '../../db/data/schema.js'
import { receiptSkillRoutes } from '../receipts.js'
import { ecSkillRoutes } from '../ec.js'
import type { BookVariables } from '../../books/middleware.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-ecroute-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup() {
  const router = new DbRouter()
  router.controlDb().insert(books).values({ id: 'u1', name: 'テスト帳簿', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }).run()
  // data plane: open 年度＋Amazon 未払金チャネル。
  const db = router.bookDb('u1')
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  db.insert(subAccounts)
    .values({ accountId: accId(db, '未払金'), name: 'Amazon', linkedAccountRef: 'amazon', importSourceType: 'amazon', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
    .run()
  const app = new Hono<{ Variables: BookVariables }>()
  app.route('/skill', ecSkillRoutes(router))
  return { app, router, db }
}

const JSON_HEADERS = { 'Content-Type': 'application/json' }

describe('ecSkillRoutes (認証なし・ループバック境界)', () => {
  it('Authorization ヘッダなしで通る', async () => {
    const { app } = setup()
    expect((await app.request('/skill/linked-services')).status).toBe(200)
  })

  it('旧スキルが送る Authorization ヘッダは無視され、エラーにならない', async () => {
    const { app } = setup()
    expect((await app.request('/skill/linked-services', { headers: { Authorization: 'Bearer mwi_deadbeef' } })).status).toBe(200)
    expect((await app.request('/skill/linked-services', { headers: { Authorization: 'token123' } })).status).toBe(200)
  })

  it('POST /skill/ec/journal-candidates: 負数の金額は 400', async () => {
    const { app } = setup()
    const res = await app.request('/skill/ec/journal-candidates', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        accountRef: 'amazon',
        orders: [{ orderId: 'N-1', orderDate: '2026-05-20', orderTotal: 100, lines: [{ lineNo: 1, itemName: 'x', quantity: 1, lineAmount: -100, evidenceRef: 'e' }] }],
      }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error')
  })

  it('GET /skill/linked-services: Amazon を返す', async () => {
    const { app } = setup()
    const res = await app.request('/skill/linked-services', { headers: JSON_HEADERS })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { services: { source: string }[] }
    expect(body.services.map((s) => s.source)).toContain('amazon')
  })

  it('POST /skill/ec/journal-candidates: draft を生成し summary を返す', async () => {
    const { app } = setup()
    const res = await app.request('/skill/ec/journal-candidates', {
      method: 'POST',
      headers: JSON_HEADERS,
      body: JSON.stringify({
        accountRef: 'amazon',
        orders: [
          {
            orderId: '249-1',
            orderDate: '2026-05-20',
            orderTotal: 2980,
            lines: [{ lineNo: 1, itemName: 'SanDisk microSDXC 256GB', quantity: 1, lineAmount: 2980, proposedAccount: '消耗品費', treatment: 'expense', evidenceRef: 'e/1' }],
          },
        ],
      }),
    })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { acceptedLines: number; draftEntries: unknown[] }
    expect(body.acceptedLines).toBe(1)
    expect(body.draftEntries).toHaveLength(1)
  })

  it('POST /skill/ec/journal-candidates: 不正ボディは 400 (validation_error)', async () => {
    const { app } = setup()
    const res = await app.request('/skill/ec/journal-candidates', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ source: 'amazon' }) })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('validation_error')
  })

  it('POST /skill/classification-history/lookup: 200', async () => {
    const { app } = setup()
    const res = await app.request('/skill/classification-history/lookup', { method: 'POST', headers: JSON_HEADERS, body: JSON.stringify({ source: 'amazon', items: ['SanDisk microSDXC 256GB'] }) })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { candidates: unknown[]; policy: unknown }
    expect(body).toHaveProperty('candidates')
    expect(body).toHaveProperty('policy')
  })
})

describe('/skill のマウント境界', () => {
  // `/skill` には EC 用とレシート用の2つのアプリが載っている。EC 側が `*` で本文上限を
  // 掛けていたため、画像を運ぶレシート取込が 5MB で弾かれていた（実機の1枚目で踏んだ）。
  function setupBoth() {
    const { router } = setup()
    const app = new Hono<{ Variables: BookVariables }>()
    app.route('/skill', ecSkillRoutes(router))
    app.route('/skill', receiptSkillRoutes(router))
    return app
  }

  it('レシート取込は EC の本文上限（5MB）に縛られない', async () => {
    const app = setupBoth()
    // 6MB 相当の base64。EC の上限が掛かっていれば 413 になる。
    const image = {
      fileName: 'a.png',
      contentType: 'image/png',
      sha256: 'a'.repeat(64),
      base64: 'A'.repeat(6 * 1024 * 1024),
    }
    const res = await app.request('/skill/receipts/journal-candidates', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Book-Id': 'u1' },
      // 日付を落としてあるので起票には進まない（ここで見たいのは本文上限だけ）。
      body: JSON.stringify({ totalAmount: 1200, image }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ outcome: 'skipped', reason: 'unreadable' })
  })

  it('EC 側は従来どおり 5MB で弾く', async () => {
    const app = setupBoth()
    const res = await app.request('/skill/bank/journal-candidates', {
      method: 'POST',
      headers: { ...JSON_HEADERS, 'X-Book-Id': 'u1' },
      body: JSON.stringify({ accountRef: 'x', transactions: [], padding: 'A'.repeat(6 * 1024 * 1024) }),
    })
    expect(res.status).toBe(413)
  })
})
