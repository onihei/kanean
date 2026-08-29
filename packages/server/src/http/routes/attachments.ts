import { Hono } from 'hono'
import type { DbRouter } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import { addAttachment, listAttachments, getAttachmentRow, readAttachmentBytes, removeAttachment } from '../../attachments/service.js'
import { bookHelpers, intParam, rfc5987 } from '../helpers.js'

/**
 * 証憑（添付ファイル）ルート。仕訳に領収書等を添付する（Phase5 Exit#1・電帳法）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 */
export function attachmentsRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf } = bookHelpers(router)

  // アップロードは生バイナリ（body）＋ fileName(query)・Content-Type(header)。multipart は使わない（/import と同方式）。
  app.post('/entries/:id/attachments', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const fileName = c.req.query('fileName') ?? ''
    const contentType = c.req.header('content-type') ?? ''
    const bytes = Buffer.from(await c.req.arrayBuffer())
    const attachment = addAttachment(dbOf(c), c.get('bookId'), { entryId: id, fileName, contentType, bytes })
    return c.json({ attachment })
  })
  app.get('/entries/:id/attachments', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    return c.json({ attachments: listAttachments(dbOf(c), id) })
  })
  // ダウンロード（プレビュー）。別ユーザーの行は物理別DBゆえ構造的に取得不可（404）。
  app.get('/attachments/:id/download', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const row = getAttachmentRow(dbOf(c), id)
    if (!row || !row.storagePath) return c.json({ error: '添付が見つかりません' }, 404)
    let bytes: Buffer
    try {
      bytes = readAttachmentBytes(c.get('bookId'), row)
    } catch {
      return c.json({ error: 'ファイルが見つかりません' }, 404)
    }
    // RFC5987 ext-value（csvResponse と同じエンコード）。
    const name = row.fileName ?? `attachment-${id}`
    c.header('Content-Type', row.contentType ?? 'application/octet-stream')
    c.header('Content-Disposition', `inline; filename*=UTF-8''${rfc5987(name)}`)
    return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
  })
  app.delete('/attachments/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    try {
      removeAttachment(dbOf(c), c.get('bookId'), id)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404)
    }
  })

  return app
}
