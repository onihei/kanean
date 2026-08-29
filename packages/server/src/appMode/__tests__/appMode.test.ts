import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { appSettings } from '../../db/control/schema.js'
import { getAppMode, setAppMode, APP_MODE_KEY } from '../appMode.js'
import { appModeRoutes } from '../../http/appMode.js'
import { createBook, archiveBook, listBooks } from '../../books/resolve.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-appmode-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const appWith = (router: DbRouter): Hono => {
  const app = new Hono()
  app.route('/', appModeRoutes(router))
  return app
}

const putMode = (app: Hono, mode: string) =>
  app.request('/app-mode', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ mode }) })

describe('アプリモードの保持', () => {
  it('未設定は null（既定へ倒さない）', () => {
    expect(getAppMode(new DbRouter())).toBeNull()
  })

  it('保存した値を返す', () => {
    const router = new DbRouter()
    setAppMode(router, 'office')
    expect(getAppMode(router)).toBe('office')
    setAppMode(router, 'personal') // upsert
    expect(getAppMode(router)).toBe('personal')
  })

  it('未知・壊れた値は未設定として扱う', () => {
    const router = new DbRouter()
    router
      .controlDb()
      .insert(appSettings)
      .values({ key: APP_MODE_KEY, value: 'tax-office', updatedAt: new Date().toISOString() })
      .run()
    expect(getAppMode(router)).toBeNull()
  })

  it('帳簿を跨いで一つ（帳簿ごとの設定ではない）', () => {
    const router = new DbRouter()
    createBook(router, 'A')
    createBook(router, 'B')
    setAppMode(router, 'office')
    const rows = router.controlDb().select().from(appSettings).where(eq(appSettings.key, APP_MODE_KEY)).all()
    expect(rows).toHaveLength(1)
  })
})

describe('アプリモードの変更（HTTP）', () => {
  it('未設定は mode:null で返る', async () => {
    const res = await appWith(new DbRouter()).request('/app-mode')
    expect(res.status).toBe(200)
    expect((await res.json()).mode).toBeNull()
  })

  it('personal → office は前提条件なしで通る', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    setAppMode(router, 'personal')
    const res = await putMode(appWith(router), 'office')
    expect(res.status).toBe(200)
    expect(getAppMode(router)).toBe('office')
  })

  it('office → personal はアクティブ2冊以上なら 409（候補を返す）', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    createBook(router, 'B')
    setAppMode(router, 'office')

    const res = await putMode(appWith(router), 'personal')
    expect(res.status).toBe(409)
    const body = await res.json()
    expect(body.error.code).toBe('books_not_single')
    expect(body.books.map((b: { name: string }) => b.name)).toEqual(['A', 'B'])
    expect(getAppMode(router)).toBe('office') // 変更されていない
  })

  it('アーカイブして1冊にすれば personal へ切り替えられる', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const b = createBook(router, 'B')
    setAppMode(router, 'office')
    const app = appWith(router)

    expect((await putMode(app, 'personal')).status).toBe(409)
    archiveBook(router, b.id)
    expect((await putMode(app, 'personal')).status).toBe(200)
    expect(getAppMode(router)).toBe('personal')
  })

  it('モード変更は帳簿を削除・改変しない', async () => {
    const router = new DbRouter()
    const a = createBook(router, 'A')
    const b = createBook(router, 'B')
    const app = appWith(router)

    await putMode(app, 'office')
    await putMode(app, 'personal') // 409 で拒否される側
    await putMode(app, 'office')

    expect(listBooks(router).map((x) => x.name)).toEqual(['A', 'B'])
    expect(fs.existsSync(path.join(tmp, 'books', `${a.id}.sqlite`))).toBe(true)
    expect(fs.existsSync(path.join(tmp, 'books', `${b.id}.sqlite`))).toBe(true)
  })

  it('未知の mode は 400', async () => {
    const res = await putMode(appWith(new DbRouter()), 'accountant')
    expect(res.status).toBe(400)
  })
})
