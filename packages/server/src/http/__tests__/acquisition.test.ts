import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { DbRouter, migrateControlDb, type DataDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, fiscalYears, subAccounts } from '../../db/data/schema.js'
import { setCrawler } from '../../acquisition/crawler.js'
import { acquisitionRoutes } from '../acquisition.js'
import type { BookVariables } from '../../books/middleware.js'

/**
 * 取込 API のレスポンス契約（issue #142）。
 *
 * 14 ルートの中で MCP と UI の両方が読む形を、実サーバのハンドラ（createApp 相当の合成）で固定する。
 * MCP 側のテストは fake app 方式で実ハンドラを通らないため、突き合わせはここが唯一の場所。
 */

const BOOK = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-acqroute-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
  setCrawler(null) // サーバ単体＝巡回の殻なし（デスクトップだけが注入する）
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function setup(opts: { openYear?: boolean; linkedService?: boolean } = {}) {
  const router = new DbRouter()
  router.controlDb().insert(books).values({ id: BOOK, name: 'テスト帳簿', createdAt: 'x', updatedAt: 'x' }).run()
  const db = router.bookDb(BOOK)
  seedDataPlane(db)
  if (opts.openYear) {
    db.insert(fiscalYears)
      .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: 'x' })
      .run()
  }
  if (opts.linkedService) {
    const bank = (db as DataDb).select().from(accounts).where(eq(accounts.name, '普通預金')).all()[0]
    db.insert(subAccounts)
      .values({
        accountId: bank.id,
        name: '三菱UFJ銀行',
        linkedAccountRef: 'bank_ufj-1',
        importSourceType: 'bank_ufj',
        isActive: true,
        sortOrder: 0,
        createdAt: 'x',
        updatedAt: 'x',
      })
      .run()
  }
  const app = new Hono<{ Variables: BookVariables }>()
  app.use('*', async (c, next) => {
    c.set('bookId', BOOK)
    await next()
  })
  app.route('/api', acquisitionRoutes(router))
  return { app, router, db }
}

describe('GET /api/acquisition/unclassified', () => {
  it('open 年度が無くても policy を含む完全な形を返す（MCP は policy 前提で読む）', async () => {
    const { app } = setup({ openYear: false })
    const res = await app.request('/api/acquisition/unclassified')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { items: unknown[]; hints: unknown[]; policy: string; total: number }
    expect(body.items).toEqual([])
    expect(body.hints).toEqual([])
    expect(body.total).toBe(0)
    // policy が undefined で MCP へ渡ると「方針に従う」導線が壊れる（issue #142 の実害）
    expect(typeof body.policy).toBe('string')
    expect(body.policy.length).toBeGreaterThan(0)
  })

  it('open 年度があれば listUnclassified の形（items/hints/policy/total）を返す', async () => {
    const { app } = setup({ openYear: true })
    const res = await app.request('/api/acquisition/unclassified')
    expect(res.status).toBe(200)
    const body = (await res.json()) as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['hints', 'items', 'policy', 'total'])
  })
})

describe('POST /api/acquisition/unclassified', () => {
  it('open 年度が無ければ全件 unmatched の 200（失敗にしない）', async () => {
    const { app } = setup({ openYear: false })
    const res = await app.request('/api/acquisition/unclassified', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ answers: [{ id: 'a1b2c3d4e5f6', proposedAccount: '消耗品費' }] }),
    })
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ applied: 0, unmatched: 1, unknownAccounts: [], remaining: 0 })
  })

  it('zod 不正（answers 欠落）は 400 validation_error', async () => {
    const { app } = setup()
    const res = await app.request('/api/acquisition/unclassified', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({}),
    })
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: { code: string; details: unknown[] } }
    expect(body.error.code).toBe('validation_error')
    expect(body.error.details.length).toBeGreaterThan(0)
  })
})

describe('POST /api/acquisition/jobs', () => {
  it('巡回の殻が無い環境では 503 crawler_unavailable（ジョブを作らず断る）', async () => {
    const { app } = setup({ openYear: true, linkedService: true })
    const res = await app.request('/api/acquisition/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ source: 'bank_ufj' }),
    })
    expect(res.status).toBe(503)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('crawler_unavailable')
    expect(body.error.message).toContain('デスクトップアプリ')
    // failed ジョブの残骸も作らない
    const jobs = (await (await app.request('/api/acquisition/jobs')).json()) as { jobs: unknown[] }
    expect(jobs.jobs).toEqual([])
  })

  it('zod 不正（source 欠落）は 400 validation_error', async () => {
    const { app } = setup()
    const res = await app.request('/api/acquisition/jobs', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ since: '2026-01-01' }),
    })
    expect(res.status).toBe(400)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('validation_error')
  })
})

describe('GET /api/acquisition/jobs/:jobId', () => {
  it('未知の jobId は 404', async () => {
    const { app } = setup()
    const res = await app.request('/api/acquisition/jobs/no-such-job')
    expect(res.status).toBe(404)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('job_not_found')
  })
})

describe('較正と診断', () => {
  it('既知の source の較正は 200（bundled/effective を含む）', async () => {
    const { app } = setup()
    const res = await app.request('/api/acquisition/bank_ufj/calibration')
    expect(res.status).toBe(200)
    const body = (await res.json()) as { source: string; origin: string; bundled: object; effective: object }
    expect(body.source).toBe('bank_ufj')
    expect(body.origin).toBe('bundled')
  })

  it('未知の source は 409（unknown_source）', async () => {
    const { app } = setup()
    const res = await app.request('/api/acquisition/no_such_site/calibration')
    expect(res.status).toBe(409)
  })

  it('直近の失敗診断が無ければ 404 not_found', async () => {
    const { app } = setup()
    const res = await app.request('/api/acquisition/bank_ufj/diagnostic')
    expect(res.status).toBe(404)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('not_found')
  })
})
