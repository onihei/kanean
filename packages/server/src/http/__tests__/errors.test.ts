import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { HTTPException } from 'hono/http-exception'
import { createApp } from '../../app.js'
import { apiErrorHandler, DomainError, NotFoundError } from '../errors.js'

/**
 * /api のエラー集約（issue #115）。
 *
 * 同型 try-catch ×68 を root onError へ寄せた。ここで固定するのは「throw したときに
 * per-route catch 時代と同じ応答（flat な {error: string} ＋ ステータス）になる」こと。
 */

describe('apiErrorHandler の対応表', () => {
  function appWith(thrower: () => never) {
    const app = new Hono()
    app.onError(apiErrorHandler)
    app.get('/x', () => thrower())
    return app
  }

  it('素の Error は 400 ＋ message（Phase 1 = per-route catch と同じ契約）', async () => {
    const res = await appWith(() => {
      throw new Error('勘定科目 "普通預金" が見つかりません')
    }).request('/x')
    expect(res.status).toBe(400)
    expect(await res.json()).toEqual({ error: '勘定科目 "普通預金" が見つかりません' })
  })

  it('DomainError は宣言したステータスで返る', async () => {
    const res = await appWith(() => {
      throw new DomainError('既に進行中です', 409)
    }).request('/x')
    expect(res.status).toBe(409)
    expect(await res.json()).toEqual({ error: '既に進行中です' })
  })

  it('NotFoundError は 404', async () => {
    const res = await appWith(() => {
      throw new NotFoundError('entry 999 が見つかりません')
    }).request('/x')
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: 'entry 999 が見つかりません' })
  })

  it('Hono 組込の HTTPException（bodyLimit の 413 等）は素通しする', async () => {
    const res = await appWith(() => {
      throw new HTTPException(413, { message: 'too large' })
    }).request('/x')
    expect(res.status).toBe(413)
  })
})

describe('本番配線（createApp の root onError）', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-onerror-'))
    process.env.DATA_DIR = tmp
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('ドメイン層の throw が per-route catch なしで 400 {error} に落ちる', async () => {
    const { app } = createApp()
    const post = () =>
      app.request('/api/fiscal-years', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ year: 2026 }),
      })
    expect((await post()).status).toBe(200)
    // 2回目は createInitialFiscalYear が throw → onError 経由で従来と同じ flat 400
    const res = await post()
    expect(res.status).toBe(400)
    const body = (await res.json()) as { error: string }
    expect(typeof body.error).toBe('string')
    expect(body.error.length).toBeGreaterThan(0)
  })
})
