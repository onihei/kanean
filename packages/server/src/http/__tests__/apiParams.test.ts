import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { DbRouter } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears } from '../../db/data/schema.js'
import { upsertProrationSetting, listProrationSettings } from '../../proration/proration.js'
import { apiRoutes } from '../api.js'
import { apiErrorHandler } from '../errors.js'
import type { BookVariables } from '../../books/middleware.js'

/**
 * ルートパラメータの整数ガード（intParam）の HTTP レベル契約テスト。
 * apiRoutes は c.get('bookId') しか使わないため、withBook の代わりに bookId を
 * セットするスタブ middleware でマウントする。
 */

let tmp: string
const USER = 'u_params'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-apiparams-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function setup() {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  const app = new Hono<{ Variables: BookVariables }>()
  app.use('*', async (c, next) => {
    c.set('bookId', USER)
    await next()
  })
  // 本番は root app（app.ts）が onError を持つ。同じ配線で mount する（issue #115）。
  app.onError(apiErrorHandler)
  app.route('/', apiRoutes(router))
  return { app, router, db }
}

describe('/drafts のクエリガード（不正値を黙って全件表示に化けさせない・issue #143）', () => {
  it('subAccountId / limit の不正値は 400、正当値は 200', async () => {
    const { app } = setup()
    expect((await app.request('/drafts?subAccountId=abc')).status).toBe(400)
    expect((await app.request('/drafts?subAccountId=0')).status).toBe(400)
    expect((await app.request('/drafts?limit=abc')).status).toBe(400)
    expect((await app.request('/drafts?limit=-1')).status).toBe(400)
    expect((await app.request('/drafts?subAccountId=1&limit=10')).status).toBe(200)
  })
})

describe('ルートパラメータの整数ガード（:id 系の NaN 遮断）', () => {
  it('DELETE /proration-settings/abc は 400（旧実装は何も消さず {ok:true} のサイレント偽成功）', async () => {
    const { app, db } = setup()
    const fyId = db.select().from(fiscalYears).all()[0].id
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: 1, businessRatio: 60 })

    const res = await app.request('/proration-settings/abc', { method: 'DELETE' })
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: 'id が不正' })
    // 設定は消えていない。
    expect(listProrationSettings(db, fyId)).toHaveLength(1)
  })

  it('非整数 id は一律 400 { error: "id が不正" }（GET/POST/PUT/DELETE 横断）', async () => {
    const { app } = setup()
    const cases: [string, string][] = [
      ['GET', '/entries/abc'],
      ['GET', '/entries/1.5'],
      ['POST', '/entries/abc/confirm'],
      ['DELETE', '/entries/abc'],
      ['GET', '/reports/ledger/abc'],
      ['GET', '/reports/sub-ledger/abc'],
      ['GET', '/fixed-assets/abc/schedule'],
      ['GET', '/documents/abc'],
      ['DELETE', '/opening-balances/abc'],
      ['DELETE', '/tags/abc'],
      ['DELETE', '/rules/abc'],
    ]
    for (const [method, url] of cases) {
      const res = await app.request(url, { method })
      expect(res.status, `${method} ${url}`).toBe(400)
      expect(await res.json(), `${method} ${url}`).toEqual({ error: 'id が不正' })
    }
  })

  it('整数 id はガードを通過してドメイン層に到達する（存在しない id は別メッセージ）', async () => {
    const { app } = setup()
    const res = await app.request('/entries/999999')
    expect(res.status).toBe(404) // ドメインの「見つかりません」（ガードの 400 ではない）
    const body = (await res.json()) as { error: string }
    expect(body.error).not.toBe('id が不正')
  })
})
