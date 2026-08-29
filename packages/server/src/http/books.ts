import { Hono } from 'hono'
import { z } from 'zod'
import type { DbRouter } from '../db/router.js'
import { listBooks, createBook, renameBook, archiveBook, unarchiveBook } from '../books/resolve.js'
import { getAppMode } from '../appMode/appMode.js'

/**
 * 帳簿の一覧・作成・改名・アーカイブ（books spec）。
 * **削除は提供しない**（不可逆で、消えるのは税務データ。design D4）。一覧から下げたいだけなら
 * アーカイブを使う＝ control plane の状態変更のみで、data plane のファイルは残る。
 * `withBook` の外側に置く＝一覧取得・アーカイブ操作に帳簿の指定を要求しない
 * （アーカイブ済み帳簿への更新系を弾く withBook を、control plane 操作が通らないようにする）。
 */

const nameSchema = z.object({ name: z.string().trim().min(1).max(100) })

export function bookRoutes(router: DbRouter): Hono {
  const app = new Hono()

  // 既定はアクティブのみ。?includeArchived=1 でアーカイブ済みを含む全件（真偽フラグは masters と同じ '1'）。
  app.get('/books', (c) =>
    c.json({ books: listBooks(router, { includeArchived: c.req.query('includeArchived') === '1' }) }),
  )

  app.post('/books', async (c) => {
    // じぶんの帳簿では帳簿の作成を提供しない（app-mode spec「アクティブな帳簿はちょうど1冊であり、
    // 帳簿の作成を提供しない」）。web は作成 UI を出さないが、不変条件は API 側でも守る（issue #149）。
    if (getAppMode(router) === 'personal') {
      return c.json(
        {
          error: {
            code: 'mode_personal',
            message: '「じぶんの帳簿」モードでは帳簿を作成できません。事務所モードへ切り替えてください',
          },
        },
        409,
      )
    }
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: { code: 'validation_error', message: 'name は1〜100文字で指定してください' } }, 400)
    }
    return c.json({ book: createBook(router, parsed.data.name) }, 201)
  })

  app.patch('/books/:id', async (c) => {
    const parsed = nameSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: { code: 'validation_error', message: 'name は1〜100文字で指定してください' } }, 400)
    }
    if (!renameBook(router, c.req.param('id'), parsed.data.name)) {
      return c.json({ error: { code: 'book_not_found', message: '指定された帳簿が存在しません' } }, 404)
    }
    return c.json({ ok: true })
  })

  app.post('/books/:id/archive', (c) => {
    const result = archiveBook(router, c.req.param('id'))
    if (result === 'not_found') {
      return c.json({ error: { code: 'book_not_found', message: '指定された帳簿が存在しません' } }, 404)
    }
    if (result === 'last_active') {
      return c.json(
        {
          error: {
            code: 'last_active_book',
            message: '最後の1冊はアーカイブできません（開ける帳簿が無くなるため）',
          },
        },
        409,
      )
    }
    return c.json({ ok: true })
  })

  app.post('/books/:id/unarchive', (c) => {
    if (!unarchiveBook(router, c.req.param('id'))) {
      return c.json({ error: { code: 'book_not_found', message: '指定された帳簿が存在しません' } }, 404)
    }
    return c.json({ ok: true })
  })

  return app
}
