import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { taxCategories } from '../../db/data/schema.js'
import { listBooks, createBook, archiveBook, unarchiveBook, ensureAtLeastOneBook, DEFAULT_BOOK_NAME } from '../resolve.js'
import { withBook, BOOK_HEADER, type BookVariables } from '../middleware.js'
import { setAppMode } from '../../appMode/appMode.js'
import { bookRoutes } from '../../http/books.js'
import { apiRoutes } from '../../http/api.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-archive-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** 帳簿API＋withBook＋業務API を本番と同じ順序で載せたアプリ。 */
function appWith(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  app.route('/', bookRoutes(router))
  app.use('*', withBook(router))
  app.route('/', apiRoutes(router))
  return app
}

describe('帳簿のアーカイブ', () => {
  it('アーカイブしても data plane のファイル・証憑は残る', () => {
    const router = new DbRouter()
    createBook(router, '顧問先A')
    const b = createBook(router, '顧問先B')
    const dbFile = path.join(tmp, 'books', `${b.id}.sqlite`)
    const attachments = path.join(tmp, 'books', b.id, 'attachments')
    fs.mkdirSync(attachments, { recursive: true })
    fs.writeFileSync(path.join(attachments, 'receipt.pdf'), 'dummy')

    expect(archiveBook(router, b.id)).toBe('ok')

    expect(fs.existsSync(dbFile)).toBe(true)
    expect(fs.existsSync(path.join(attachments, 'receipt.pdf'))).toBe(true)
  })

  it('既定の一覧から外れ、includeArchived で戻る', () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const b = createBook(router, 'B')
    archiveBook(router, b.id)

    expect(listBooks(router).map((x) => x.name)).toEqual(['A'])
    expect(listBooks(router, { includeArchived: true }).map((x) => x.name)).toEqual(['A', 'B'])
    expect(listBooks(router, { includeArchived: true }).find((x) => x.id === b.id)?.archivedAt).toMatch(/^\d{4}-/)
  })

  it('復帰すると既定の一覧に戻る', () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const b = createBook(router, 'B')
    archiveBook(router, b.id)
    expect(unarchiveBook(router, b.id)).toBe(true)
    expect(listBooks(router).map((x) => x.name)).toEqual(['A', 'B'])
  })

  it('最後のアクティブ帳簿はアーカイブできない（空帳簿が生えるのを防ぐ）', () => {
    const router = new DbRouter()
    const only = createBook(router, 'A')
    expect(archiveBook(router, only.id)).toBe('last_active')
    expect(listBooks(router)).toHaveLength(1)
  })

  it('存在しない帳簿のアーカイブ・復帰は not_found / false', () => {
    const router = new DbRouter()
    createBook(router, 'A')
    expect(archiveBook(router, '01ZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe('not_found')
    expect(unarchiveBook(router, '01ZZZZZZZZZZZZZZZZZZZZZZZZ')).toBe(false)
  })

  it('アクティブ0冊（control を外から書き換えた等）なら ensureAtLeastOneBook が1冊作る', () => {
    const router = new DbRouter()
    createBook(router, 'A')
    // API 経由では最後の1冊をアーカイブできないので、外部要因で 0冊になった状態を直接作る。
    router.controlDb().update(books).set({ archivedAt: new Date().toISOString() }).run()
    expect(listBooks(router)).toHaveLength(0)

    ensureAtLeastOneBook(router)
    expect(listBooks(router).map((b) => b.name)).toEqual([DEFAULT_BOOK_NAME])
  })

  it('アーカイブ→復帰で会計データは変わらない', () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const b = createBook(router, 'B')
    const count = () =>
      router
        .bookDb(b.id)
        .select({ n: sql<number>`count(*)` })
        .from(taxCategories)
        .all()[0].n

    const before = count()
    archiveBook(router, b.id)
    expect(count()).toBe(before)
    unarchiveBook(router, b.id)
    expect(count()).toBe(before)
  })
})

describe('アーカイブ済み帳簿の保護（withBook 一点集約）', () => {
  it('参照系は通り、更新系は 409（本番と同じルート構成で確認）', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const b = createBook(router, 'B')
    archiveBook(router, b.id)
    const app = appWith(router)

    const read = await app.request('/accounts', { headers: { [BOOK_HEADER]: b.id } })
    expect(read.status).toBe(200)

    for (const [method, path, body] of [
      ['POST', '/entries', '{"lines":[]}'],
      ['POST', '/entries/1/confirm', null],
      ['PATCH', '/lines/1', '{"accountId":1}'],
      ['DELETE', '/entries/1', null],
    ] as const) {
      const res = await app.request(path, {
        method,
        headers: { [BOOK_HEADER]: b.id, 'content-type': 'application/json' },
        body: body ?? undefined,
      })
      expect([method, res.status]).toEqual([method, 409])
      expect((await res.json()).error.code).toBe('book_archived')
    }
  })

  it('アクティブな帳簿の更新系は通る', async () => {
    const router = new DbRouter()
    const a = createBook(router, 'A')
    createBook(router, 'B')
    const res = await appWith(router).request('/entries', {
      method: 'POST',
      headers: { [BOOK_HEADER]: a.id, 'content-type': 'application/json' },
      body: '{"lines":[]}',
    })
    // 会計年度が無い等で 400 にはなるが、アーカイブガード（409）には掛からない。
    expect(res.status).not.toBe(409)
  })

  it('アーカイブ済みを除いてアクティブが1冊なら暗黙解決できる', async () => {
    const router = new DbRouter()
    const a = createBook(router, 'A')
    const b = createBook(router, 'B')
    archiveBook(router, b.id)
    const app = new Hono<{ Variables: BookVariables }>()
    app.use('*', withBook(router))
    app.get('/probe', (c) => c.json({ bookId: c.get('bookId') }))

    const res = await app.request('/probe')
    expect(res.status).toBe(200)
    expect((await res.json()).bookId).toBe(a.id)
  })

  it('400 の候補にアーカイブ済みは含めない', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    createBook(router, 'B')
    const c = createBook(router, 'C')
    archiveBook(router, c.id)
    const app = new Hono<{ Variables: BookVariables }>()
    app.use('*', withBook(router))
    app.get('/probe', (ctx) => ctx.json({ bookId: ctx.get('bookId') }))

    const res = await app.request('/probe')
    expect(res.status).toBe(400)
    expect((await res.json()).books.map((x: { name: string }) => x.name)).toEqual(['A', 'B'])
  })
})

describe('帳簿API（HTTP）', () => {
  it('一覧の既定はアクティブのみ・includeArchived=1 で全件', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const b = createBook(router, 'B')
    archiveBook(router, b.id)
    const app = new Hono()
    app.route('/', bookRoutes(router))

    const def = await (await app.request('/books')).json()
    expect(def.books.map((x: { name: string }) => x.name)).toEqual(['A'])

    const all = await (await app.request('/books?includeArchived=1')).json()
    expect(all.books.map((x: { name: string }) => x.name)).toEqual(['A', 'B'])
  })

  it('archive / unarchive と、最後の1冊の 409', async () => {
    const router = new DbRouter()
    const a = createBook(router, 'A')
    const b = createBook(router, 'B')
    const app = new Hono()
    app.route('/', bookRoutes(router))

    expect((await app.request(`/books/${b.id}/archive`, { method: 'POST' })).status).toBe(200)

    const last = await app.request(`/books/${a.id}/archive`, { method: 'POST' })
    expect(last.status).toBe(409)
    expect((await last.json()).error.code).toBe('last_active_book')

    expect((await app.request(`/books/${b.id}/unarchive`, { method: 'POST' })).status).toBe(200)
    expect(listBooks(router)).toHaveLength(2)
  })

  it('存在しない帳簿は 404', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const app = new Hono()
    app.route('/', bookRoutes(router))
    expect((await app.request('/books/01ZZZZZZZZZZZZZZZZZZZZZZZZ/archive', { method: 'POST' })).status).toBe(404)
    expect((await app.request('/books/01ZZZZZZZZZZZZZZZZZZZZZZZZ/unarchive', { method: 'POST' })).status).toBe(404)
  })
})

describe('personal モードの不変条件（issue #149）', () => {
  it('personal では POST /books が 409 mode_personal（office へ戻せば作れる）', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    setAppMode(router, 'personal')
    const app = new Hono()
    app.route('/', bookRoutes(router))

    const res = await app.request('/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B' }),
    })
    expect(res.status).toBe(409)
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe('mode_personal')
    expect(listBooks(router)).toHaveLength(1)

    setAppMode(router, 'office')
    const ok = await app.request('/books', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'B' }),
    })
    expect(ok.status).toBe(201)
    expect(listBooks(router)).toHaveLength(2)
  })
})

describe('既定の帳簿名は変わらない', () => {
  it('0冊なら マイ帳簿 を作る', () => {
    const router = new DbRouter()
    ensureAtLeastOneBook(router)
    expect(listBooks(router).map((b) => b.name)).toEqual([DEFAULT_BOOK_NAME])
  })
})
