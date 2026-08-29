import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, fiscalYears, subAccounts } from '../../db/data/schema.js'
import { eq } from 'drizzle-orm'
import { importRows } from '../../import/importer.js'
import { parseBankUfj } from '../../import/parsers/bankUfj.js'
import { journalizeBatch } from '../../journal/journalize.js'
import { listDrafts } from '../../journal/confirm.js'
import { apiRoutes } from '../api.js'
import { apiErrorHandler } from '../errors.js'
import type { BookVariables } from '../../books/middleware.js'

/**
 * 代表ルートの HTTP 契約テスト（issue #127 = B15）。
 * ドメイン関数の単体テストと別に「HTTP 境界での応答形」を固定する:
 * - POST /entries/confirm-batch: 部分成功の封筒＋入力ガード
 * - GET /closing/rollover/precheck: read-only の件数形
 * - 帳票 CSV: Content-Disposition / charset / Shift_JIS の欠落通知ヘッダ
 */

let tmp: string
const BOOK = 'b_contract'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-apicontract-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup() {
  const router = new DbRouter()
  const db = router.bookDb(BOOK)
  seedDataPlane(db)
  const fy = db
    .insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .returning()
    .all()[0]
  const app = new Hono<{ Variables: BookVariables }>()
  app.use('*', async (c, next) => {
    c.set('bookId', BOOK)
    await next()
  })
  app.onError(apiErrorHandler)
  app.route('/', apiRoutes(router))
  return { app, router, db, fyId: fy.id }
}

/** UI CSV トラックで draft を2件作り、その entry id を返す（draft は取込経路でのみ生まれる）。 */
function importTwoDrafts(router: DbRouter, db: DataDb, fyId: number): number[] {
  db.insert(subAccounts)
    .values({ accountId: accId(db, '普通預金'), name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' })
    .run()
  const csv = [
    '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
    '"2026/6/1","ﾃﾞﾝｷ","","1,000","","99,000"',
    '"2026/6/2","ｶﾞｽ","","2,000","","97,000"',
  ].join('\r\n')
  const batch = importRows(router, BOOK, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
  journalizeBatch(db, batch.batchId)
  return listDrafts(db, fyId).map((d) => d.id)
}

const postJson = (app: Hono<{ Variables: BookVariables }>, p: string, body: unknown) =>
  app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

describe('POST /entries/confirm-batch', () => {
  it('部分成功: 存在しない id は失敗として記録し、正常分は確定する', async () => {
    const { app, router, db, fyId } = setup()
    const [id1, id2] = importTwoDrafts(router, db, fyId)
    const res = await postJson(app, '/entries/confirm-batch', { ids: [id1, 999_999, id2] })
    expect(res.status).toBe(200)
    const body = (await res.json()) as { results: { id: number; ok: boolean }[]; confirmed: number; failed: number }
    expect(body.confirmed).toBe(2)
    expect(body.failed).toBe(1)
    expect(body.results.find((r) => r.id === 999_999)?.ok).toBe(false)
  })

  it('入力ガード: 空配列・非整数・500件超は 400', async () => {
    const { app } = setup()
    expect((await postJson(app, '/entries/confirm-batch', { ids: [] })).status).toBe(400)
    expect((await postJson(app, '/entries/confirm-batch', { ids: ['a'] })).status).toBe(400)
    expect((await postJson(app, '/entries/confirm-batch', { ids: [0] })).status).toBe(400)
    expect((await postJson(app, '/entries/confirm-batch', { ids: Array.from({ length: 501 }, (_, i) => i + 1) })).status).toBe(400)
    expect((await postJson(app, '/entries/confirm-batch', {})).status).toBe(400)
  })
})

describe('GET /closing/rollover/precheck', () => {
  it('未処理の取込明細が無ければ 0 件形（read-only・繰越はブロックしない契約の入口）', async () => {
    const { app } = setup()
    const res = await app.request('/closing/rollover/precheck')
    expect(res.status).toBe(200)
    expect(await res.json()).toEqual({ unprocessedRaw: { pending: 0, ignored: 0 } })
  })
})

describe('帳票 CSV の応答ヘッダ', () => {
  it('journal.csv: UTF-8 BOM・charset=utf-8・attachment filename*', async () => {
    const { app } = setup()
    const res = await app.request('/reports/journal.csv')
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(res.headers.get('Content-Disposition')).toContain("attachment; filename*=UTF-8''")
    expect(decodeURIComponent(res.headers.get('Content-Disposition')!.split("''")[1])).toBe('仕訳帳.csv')
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
  })
})
