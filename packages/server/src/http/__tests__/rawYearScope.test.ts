import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, accounts, subAccounts, importBatches, rawTransactions, journalEntries } from '../../db/data/schema.js'
import { apiRoutes } from '../api.js'
import { apiErrorHandler } from '../errors.js'
import type { BookVariables } from '../../books/middleware.js'

/**
 * 取込明細の年スコープと会計期間ゲートを HTTP 層で確認する（[[csv-import]] / [[journal]] / [[closing]]）。
 * ドメイン側の単体テストは import/__tests__/rawStatus.test.ts。ここではクエリ・ステータスコードの契約を見る。
 */

let tmp: string
const USER = 'u_rawyear'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-rawyear-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

/** 2026 を open にした帳簿＋口座補助＋取込バッチ。 */
function setup(): { app: Hono<{ Variables: BookVariables }>; db: DataDb; batchId: number } {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  db.insert(subAccounts)
    .values({ accountId: accId(db, '普通預金'), name: 'UFJ普通', linkedAccountRef: 'ufj-1', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' })
    .run()
  const batchId = db
    .insert(importBatches)
    .values({ sourceType: 'bank_ufj', accountRef: 'ufj-1', status: 'done', importedAt: '2026-06-01T00:00:00Z' })
    .returning()
    .all()[0].id
  const app = new Hono<{ Variables: BookVariables }>()
  app.use('*', async (c, next) => {
    c.set('bookId', USER)
    await next()
  })
  // 本番は root app（app.ts）が onError を持つ。同じ配線で mount する（issue #115）。
  app.onError(apiErrorHandler)
  app.route('/', apiRoutes(router))
  return { app, db, batchId }
}

function addRaw(db: DataDb, batchId: number, txnDate: string, status: string, amount: number): number {
  return db
    .insert(rawTransactions)
    .values({ batchId, txnDate, amount, direction: 'out', description: `x${amount}`, dedupHash: `h${amount}`, accountRef: 'ufj-1', status })
    .returning()
    .all()[0].id
}

/** 2026 を closed にして 2027 を open にする（繰越後の状態）。 */
function rollTo2027(db: DataDb): void {
  db.update(fiscalYears).set({ status: 'closed' }).where(eq(fiscalYears.startDate, '2026-01-01')).run()
  db.insert(fiscalYears).values({ startDate: '2027-01-01', endDate: '2027-12-31', status: 'open', createdAt: '2027-01-01T00:00:00Z' }).run()
}

describe('GET /raw-transactions — 年スコープ', () => {
  it('既定は開いている会計年度に閉じ、外した件数を outOfYearTotal で返す', async () => {
    const { app, db, batchId } = setup()
    addRaw(db, batchId, '2026-05-01', 'pending', 1000)
    addRaw(db, batchId, '2026-06-01', 'ignored', 2000)
    rollTo2027(db)
    addRaw(db, batchId, '2027-03-01', 'pending', 3000)

    const res = await app.request('/raw-transactions')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { rawTransactions: { amount: number }[]; total: number; truncated: boolean; outOfYearTotal: number }
    expect(body.rawTransactions.map((r) => r.amount)).toEqual([3000])
    expect(body.total).toBe(1)
    expect(body.truncated).toBe(false)
    expect(body.outOfYearTotal).toBe(2)
  })

  it('?years=all で年の絞り込みを解除する（outOfYearTotal は 0）', async () => {
    const { app, db, batchId } = setup()
    addRaw(db, batchId, '2026-05-01', 'pending', 1000)
    rollTo2027(db)
    addRaw(db, batchId, '2027-03-01', 'pending', 3000)

    const body = (await (await app.request('/raw-transactions?years=all')).json()) as { rawTransactions: unknown[]; total: number; outOfYearTotal: number }
    expect(body.rawTransactions).toHaveLength(2)
    expect(body.total).toBe(2)
    expect(body.outOfYearTotal).toBe(0)
  })

  it('years の未知の値は既定（open）扱い', async () => {
    const { app, db, batchId } = setup()
    addRaw(db, batchId, '2026-05-01', 'pending', 1000)
    rollTo2027(db)

    const body = (await (await app.request('/raw-transactions?years=past')).json()) as { total: number; outOfYearTotal: number }
    expect(body.total).toBe(0)
    expect(body.outOfYearTotal).toBe(1)
  })

  it('status と併用できる', async () => {
    const { app, db, batchId } = setup()
    addRaw(db, batchId, '2026-05-01', 'pending', 1000)
    addRaw(db, batchId, '2026-06-01', 'ignored', 2000)

    const body = (await (await app.request('/raw-transactions?status=ignored')).json()) as { rawTransactions: { amount: number }[]; total: number }
    expect(body.rawTransactions.map((r) => r.amount)).toEqual([2000])
    expect(body.total).toBe(1)
  })
})

describe('POST /raw-transactions/:id/restore — 会計期間ゲート', () => {
  it('繰越後の過年度明細は 400（API を直接叩いても仕訳を作れない）', async () => {
    const { app, db, batchId } = setup()
    const rawId = addRaw(db, batchId, '2026-05-01', 'ignored', 1000)
    rollTo2027(db)

    const res = await app.request(`/raw-transactions/${rawId}/restore`, { method: 'POST' })
    expect(res.status).toBe(400)
    expect((await res.json()) as { error: string }).toMatchObject({ error: expect.stringContaining('範囲外') })
    expect(db.select().from(rawTransactions).where(eq(rawTransactions.id, rawId)).all()[0].status).toBe('ignored')
    expect(db.select().from(journalEntries).all()).toHaveLength(0)
  })

  it('当年度の明細は従来どおり復帰できる', async () => {
    const { app, db, batchId } = setup()
    const rawId = addRaw(db, batchId, '2026-05-01', 'ignored', 1000)

    const res = await app.request(`/raw-transactions/${rawId}/restore`, { method: 'POST' })
    expect(res.status).toBe(200)
    expect(db.select().from(rawTransactions).where(eq(rawTransactions.id, rawId)).all()[0].status).toBe('journalized')
  })
})

describe('GET /closing/rollover/precheck — 繰越前の警告', () => {
  it('当期の未処理件数を pending / ignored の内訳で返す', async () => {
    const { app, db, batchId } = setup()
    addRaw(db, batchId, '2026-05-01', 'pending', 1000)
    addRaw(db, batchId, '2026-06-01', 'pending', 2000)
    addRaw(db, batchId, '2026-07-01', 'ignored', 3000)
    addRaw(db, batchId, '2026-08-01', 'journalized', 4000)

    const res = await app.request('/closing/rollover/precheck')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ unprocessedRaw: { pending: 2, ignored: 1 } })
  })

  it('会計年度が無ければ 400', async () => {
    const { app, db } = setup()
    db.update(fiscalYears).set({ status: 'closed' }).run()
    expect((await app.request('/closing/rollover/precheck')).status).toBe(400)
  })
})
