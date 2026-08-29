import { Hono } from 'hono'
import type { DbRouter } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import { updateLineAccount, confirmEntry, confirmEntriesBatch } from '../../journal/confirm.js'
import { createManualEntry, type CreateManualEntryInput } from '../../journal/manualEntry.js'
import {
  listEntries,
  getEntry,
  updateEntry,
  unconfirmEntry,
  deleteEntry,
  listAuditLogs,
  type UpdateEntryInput,
} from '../../journal/entries.js'
import { bookHelpers, intParam, parseEntriesFilter } from '../helpers.js'

/**
 * 仕訳ルート（起票・確定・編集・削除・監査ログ）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 */
export function entriesRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf, withOpenYearOrNull , requireOpenYear } = bookHelpers(router)

  app.patch('/lines/:lineId', async (c) => {
    const lineId = intParam(c, 'lineId')
    if (lineId == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as { accountId?: number; subAccountId?: number | null; taxCategoryId?: number | null } | null
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON body が必要' }, 400)
    updateLineAccount(dbOf(c), lineId, body)
    return c.json({ ok: true })
  })

  // 手入力・複合仕訳の起票（borrowN:creditM、貸借一致・期間ゲートは createManualEntry が検証）。
  app.post('/entries', async (c) => {
    const { db, fyId } = requireOpenYear(c)
    const body = (await c.req.json().catch(() => null)) as Omit<CreateManualEntryInput, 'fiscalYearId'> | null
    if (!body || !Array.isArray(body.lines)) return c.json({ error: 'lines を含む JSON body が必要' }, 400)
    const id = createManualEntry(db, { ...body, fiscalYearId: fyId })
    return c.json({ id }, 201)
  })

  app.post('/entries/:id/confirm', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    confirmEntry(dbOf(c), id)
    return c.json({ ok: true })
  })

  // 一括確定（例外ベースレビュー）。1件ずつ独立に確定し、失敗行はエラーを記録して続行＝部分成功を許す。
  app.post('/entries/confirm-batch', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { ids?: unknown } | null
    const ids = body?.ids
    if (!Array.isArray(ids) || ids.length === 0) return c.json({ error: 'ids（正整数の配列）が必要' }, 400)
    if (ids.length > 500) return c.json({ error: 'ids は最大500件までです' }, 400)
    if (!ids.every((v): v is number => Number.isInteger(v) && (v as number) > 0))
      return c.json({ error: 'ids は正整数の配列で指定してください' }, 400)
    const results = confirmEntriesBatch(dbOf(c), ids)
    const confirmed = results.filter((r) => r.ok).length
    return c.json({ results, confirmed, failed: results.length - confirmed })
  })

  // 確定済み仕訳の一覧・検索（F-JNL-5）。?status=&from=&to=&q=&accountId=&limit=
  app.get('/entries', (c) => {
    const filter = parseEntriesFilter((k) => c.req.query(k))
    return c.json({ entries: withOpenYearOrNull(c, (db, fyId) => listEntries(db, fyId, filter)) ?? [] })
  })

  app.get('/entries/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    try {
      return c.json({ entry: getEntry(dbOf(c), id) })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404)
    }
  })

  // 仕訳の編集（draft のみ。確定済みは確定取消が前提）。
  app.put('/entries/:id', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as UpdateEntryInput | null
    if (!body || !Array.isArray(body.lines)) return c.json({ error: 'lines を含む JSON body が必要' }, 400)
    updateEntry(dbOf(c), id, body)
    return c.json({ ok: true })
  })

  // 確定取消（confirmed → draft）。
  app.post('/entries/:id/unconfirm', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as { note?: string | null } | null
    unconfirmEntry(dbOf(c), id, body?.note ?? null)
    return c.json({ ok: true })
  })

  // 仕訳の削除（物理削除・監査ログに原状保持）。
  app.delete('/entries/:id', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as { note?: string | null } | null
    deleteEntry(dbOf(c), id, body?.note ?? null)
    return c.json({ ok: true })
  })

  // 監査ログ（?targetId= で特定仕訳の履歴）。
  app.get('/audit-logs', (c) => {
    const targetId = c.req.query('targetId') ? Number(c.req.query('targetId')) : undefined
    return c.json({ logs: listAuditLogs(dbOf(c), targetId) })
  })

  return app
}
