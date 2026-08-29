import type { DocumentView } from '@kanean/shared'
import { Hono } from 'hono'
import type { DbRouter } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import {
  createDocument,
  getDocument,
  listDocuments,
  updateDocument,
  voidDocument,
  createReceiptFromInvoice,
  type DocumentInput,
} from '../../documents/documents.js'
import { issueInvoice, collectPayment } from '../../documents/invoicing.js'
import { bookHelpers, intParam } from '../helpers.js'

/**
 * 書類ルート（請求書・見積・納品・領収。F-INV）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 */
export function documentsRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf, requireOpenYear } = bookHelpers(router)

  app.get('/documents', (c) => {
    const docType = c.req.query('docType') || undefined
    const status = c.req.query('status') || undefined
    const cpRaw = c.req.query('counterpartyId')
    const counterpartyId = cpRaw != null && cpRaw !== '' ? Number(cpRaw) : undefined
    return c.json({ documents: listDocuments(dbOf(c), { docType, status, counterpartyId }) } satisfies { documents: DocumentView[] })
  })
  app.get('/documents/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    try {
      return c.json({ document: getDocument(dbOf(c), id) } satisfies { document: DocumentView })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404)
    }
  })
  app.post('/documents', async (c) => {
    const body = (await c.req.json().catch(() => null)) as DocumentInput | null
    if (!body?.docType || !Array.isArray(body.lines)) return c.json({ error: 'docType と lines が必要' }, 400)
    return c.json({ id: createDocument(dbOf(c), body) })
  })
  app.put('/documents/:id', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as DocumentInput | null
    if (!body?.docType || !Array.isArray(body.lines)) return c.json({ error: 'docType と lines が必要' }, 400)
    updateDocument(dbOf(c), id, body)
    return c.json({ ok: true })
  })
  app.post('/documents/:id/issue', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const { db, fyId } = requireOpenYear(c)
    return c.json({ result: issueInvoice(db, fyId, id) })
  })
  app.post('/documents/:id/collect', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as { paymentDate?: string; depositAccountId?: number | null } | null
    if (!body?.paymentDate) return c.json({ error: 'paymentDate が必要' }, 400)
    const { db, fyId } = requireOpenYear(c)
    return c.json({ result: collectPayment(db, fyId, { documentId: id, paymentDate: body.paymentDate as string, depositAccountId: body.depositAccountId ?? null }) })
  })
  app.post('/documents/:id/void', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    voidDocument(dbOf(c), id)
    return c.json({ ok: true })
  })
  app.post('/documents/:id/receipt', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    return c.json({ id: createReceiptFromInvoice(dbOf(c), id) })
  })

  return app
}
