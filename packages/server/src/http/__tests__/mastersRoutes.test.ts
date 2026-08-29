import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { apiRoutes } from '../api.js'
import { apiErrorHandler } from '../errors.js'
import type { BookVariables } from '../../books/middleware.js'

/**
 * マスタ CRUD の HTTP 契約（B8=#120 の安全網）。
 * masterCrud / activeRoute ファクトリ化でステータス（201/400）とエラーメッセージが
 * 変わっていないことを、代表1マスタ（取引先）で固定する。
 */

let tmp: string
const BOOK = 'b_masters'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-masters-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function setup() {
  const router = new DbRouter()
  seedDataPlane(router.bookDb(BOOK))
  const app = new Hono<{ Variables: BookVariables }>()
  app.use('*', async (c, next) => {
    c.set('bookId', BOOK)
    await next()
  })
  // 本番は root app（app.ts）が onError を持つ。同じ配線で mount する。
  app.onError(apiErrorHandler)
  app.route('/', apiRoutes(router))
  return app
}

const json = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
})

describe('取引先 CRUD の契約', () => {
  it('作成 201 {id} → 一覧 → 更新 {ok} → 無効化 {ok} → 既定一覧から消える', async () => {
    const app = setup()

    const created = await app.request('/counterparties', json({ name: 'マツダ商店' }))
    expect(created.status).toBe(201)
    const { id } = (await created.json()) as { id: number }
    expect(id).toBeGreaterThan(0)

    const listed = (await (await app.request('/counterparties')).json()) as { counterparties: { id: number; name: string }[] }
    expect(listed.counterparties.map((c) => c.name)).toContain('マツダ商店')

    const updated = await app.request(`/counterparties/${id}`, { ...json({ name: 'マツダ商店 改' }), method: 'PUT' })
    expect(updated.status).toBe(200)
    expect(await updated.json()).toEqual({ ok: true })

    const deactivated = await app.request(`/counterparties/${id}/active`, json({ isActive: false }))
    expect(deactivated.status).toBe(200)
    expect(await deactivated.json()).toEqual({ ok: true })

    // 既定は有効のみ・includeInactive=1 で無効も見える（論理削除＝データは残る）
    const activeOnly = (await (await app.request('/counterparties')).json()) as { counterparties: unknown[] }
    expect(activeOnly.counterparties).toHaveLength(0)
    const all = (await (await app.request('/counterparties?includeInactive=1')).json()) as {
      counterparties: { name: string; isActive: boolean }[]
    }
    expect(all.counterparties[0]).toMatchObject({ name: 'マツダ商店 改', isActive: false })
  })

  it('検証エラーの文言とステータスが従来どおり', async () => {
    const app = setup()

    const noName = await app.request('/counterparties', json({}))
    expect(noName.status).toBe(400)
    expect(await noName.json()).toEqual({ error: 'name が必要' })

    const badId = await app.request('/counterparties/abc', { ...json({ name: 'x' }), method: 'PUT' })
    expect(badId.status).toBe(400)
    expect(await badId.json()).toEqual({ error: 'id が不正' })

    const badActive = await app.request('/counterparties/1/active', json({}))
    expect(badActive.status).toBe(400)
    expect(await badActive.json()).toEqual({ error: 'isActive (boolean) が必要' })

    // 存在しない id はドメイン層の get-or-throw → onError で 400 ＋ 共通文言
    const missing = await app.request('/counterparties/999/active', json({ isActive: false }))
    expect(missing.status).toBe(400)
    expect(await missing.json()).toEqual({ error: '取引先 999 が見つかりません' })

    // ドメイン検証（登録番号の形式）も従来どおり 400 で文言が届く
    const badRegNo = await app.request('/counterparties', json({ name: 'x', invoiceRegNo: 'X123' }))
    expect(badRegNo.status).toBe(400)
    expect(((await badRegNo.json()) as { error: string }).error).toContain('登録番号')
  })
})
