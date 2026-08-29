import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { Hono } from 'hono'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { listBooks, createBook, renameBook, ensureAtLeastOneBook, DEFAULT_BOOK_NAME } from '../resolve.js'
import { withBook, BOOK_HEADER, type BookVariables } from '../middleware.js'
import { books } from '../../db/control/schema.js'
import { taxCategories } from '../../db/data/schema.js'

let tmp: string

// 各テストで独立した DATA_DIR（control.sqlite を汚さない）。
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-books-'))
  process.env.DATA_DIR = tmp
  migrateControlDb()
})

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('帳簿の作成・一覧・改名', () => {
  it('作成すると data plane が初期化され標準シードが入る', () => {
    const router = new DbRouter()
    const book = createBook(router, '顧問先A')
    expect(book.id).toMatch(/^[0-9A-Z]{26}$/)

    expect(fs.existsSync(path.join(tmp, 'books', `${book.id}.sqlite`))).toBe(true)
    const [{ count }] = router
      .bookDb(book.id)
      .select({ count: sql<number>`count(*)` })
      .from(taxCategories)
      .all()
    expect(count).toBe(14)
  })

  it('ensureAtLeastOneBook は0冊のときだけ既定の帳簿を作る', () => {
    const router = new DbRouter()
    ensureAtLeastOneBook(router)
    expect(listBooks(router).map((b) => b.name)).toEqual([DEFAULT_BOOK_NAME])

    ensureAtLeastOneBook(router) // 2回目は何もしない
    expect(listBooks(router)).toHaveLength(1)
  })

  /**
   * 帳簿の在否は **control plane のレジストリだけ**が決める。`books/*.sqlite` を手で置いても
   * 帳簿にはならない（restorable-export design.md §2「ファイルの存在は意図ではない」）。
   * これは意図した契約であり、だからこそ取り込みには ops/importBook の登録経路が要る。
   */
  it('data plane のファイルが在るだけでは帳簿と見なさない（レジストリが正）', () => {
    const orphan = '01ARZ3NDEKTSV4RRFFQ69G5FAV'
    fs.mkdirSync(path.join(tmp, 'books'), { recursive: true })
    fs.copyFileSync(
      // 実在の正規 DB を孤児として置く（「壊れたファイルだから無視された」ではないことを担保）。
      (() => {
        const seeded = new DbRouter()
        const book = createBook(seeded, '別環境からコピーしてきた帳簿')
        return path.join(tmp, 'books', `${book.id}.sqlite`)
      })(),
      path.join(tmp, 'books', `${orphan}.sqlite`),
    )

    const router = new DbRouter()
    expect(listBooks(router).map((b) => b.id)).not.toContain(orphan)
    ensureAtLeastOneBook(router)
    expect(listBooks(router).map((b) => b.id)).not.toContain(orphan)
  })

  it('N 冊持てる（2冊目でエラーにならない）', () => {
    const router = new DbRouter()
    createBook(router, '顧問先A')
    createBook(router, '顧問先B')
    expect(listBooks(router).map((b) => b.name)).toEqual(['顧問先A', '顧問先B'])
  })

  it('改名しても data plane のファイル名（id）は変わらない', () => {
    const router = new DbRouter()
    const book = createBook(router, '旧名')
    expect(renameBook(router, book.id, '新名')).toBe(true)
    expect(router.controlDb().select().from(books).all()[0].name).toBe('新名')
    expect(fs.existsSync(path.join(tmp, 'books', `${book.id}.sqlite`))).toBe(true)
  })

  it('存在しない帳簿の改名は false', () => {
    expect(renameBook(new DbRouter(), '01ZZZZZZZZZZZZZZZZZZZZZZZZ', 'x')).toBe(false)
  })
})

describe('withBook の解決順（ヘッダ → クエリ → 1冊なら暗黙 → 400）', () => {
  /** 解決された bookId をそのまま返すだけのアプリ。 */
  function appWith(router: DbRouter): Hono<{ Variables: BookVariables }> {
    const app = new Hono<{ Variables: BookVariables }>()
    app.use('*', withBook(router))
    app.get('/probe', (c) => c.json({ bookId: c.get('bookId') }))
    return app
  }

  it('ヘッダで指定した帳簿を使う', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const b = createBook(router, 'B')
    const res = await appWith(router).request('/probe', { headers: { [BOOK_HEADER]: b.id } })
    expect(res.status).toBe(200)
    expect((await res.json()).bookId).toBe(b.id)
  })

  it('クエリで指定した帳簿を使う（ブラウザネイティブの GET 用）', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const b = createBook(router, 'B')
    const res = await appWith(router).request(`/probe?bookId=${b.id}`)
    expect(res.status).toBe(200)
    expect((await res.json()).bookId).toBe(b.id)
  })

  it('1冊だけなら指定を省略できる', async () => {
    const router = new DbRouter()
    const only = createBook(router, 'A')
    const res = await appWith(router).request('/probe')
    expect(res.status).toBe(200)
    expect((await res.json()).bookId).toBe(only.id)
  })

  it('2冊以上で未指定なら 400 と選択肢を返す（推測しない）', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    createBook(router, 'B')
    const res = await appWith(router).request('/probe')
    expect(res.status).toBe(400)
    const body = await res.json()
    expect(body.error.code).toBe('book_required')
    expect(body.books.map((b: { name: string }) => b.name)).toEqual(['A', 'B'])
  })

  it('存在しない帳簿を指定したら 404', async () => {
    const router = new DbRouter()
    createBook(router, 'A')
    const res = await appWith(router).request('/probe', {
      headers: { [BOOK_HEADER]: '01ZZZZZZZZZZZZZZZZZZZZZZZZ' },
    })
    expect(res.status).toBe(404)
    expect((await res.json()).error.code).toBe('book_not_found')
  })

  it('ヘッダはクエリより優先される', async () => {
    const router = new DbRouter()
    const a = createBook(router, 'A')
    const b = createBook(router, 'B')
    const res = await appWith(router).request(`/probe?bookId=${b.id}`, { headers: { [BOOK_HEADER]: a.id } })
    expect((await res.json()).bookId).toBe(a.id)
  })
})
