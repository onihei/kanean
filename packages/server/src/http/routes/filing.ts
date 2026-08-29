import { Hono } from 'hono'
import { FILING_TAX_KINDS, FILING_METHODS, type FilingTaxKind, type FilingMethod } from '@kanean/shared'
import type { DbRouter } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import {
  filingPrecheck,
  buildFilingSheet,
  createFilingRecord,
  listFilingRecords,
  deleteFilingRecord,
  addFilingAttachment,
} from '../../filing/service.js'
import { bookHelpers, intParam } from '../helpers.js'

/**
 * 申告の提出支援ルート（filing spec）。precheck・入力指示書は参照系（open 年度なしは 200＋null）、
 * 完了記録は更新系（open 年度なしは 400）。アーカイブ帳簿の 409 は withBook が共通処理。
 */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/
const isTaxKind = (v: unknown): v is FilingTaxKind => FILING_TAX_KINDS.includes(v as FilingTaxKind)
const isMethod = (v: unknown): v is FilingMethod => FILING_METHODS.includes(v as FilingMethod)

export function filingRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf, withOpenYearOrNull, requireOpenYear } = bookHelpers(router)

  // 申告前チェック（決定的判定。「提出可能」は返さない）。
  app.get('/filing/precheck', (c) => {
    const precheck = withOpenYearOrNull(c, (db, fyId) => filingPrecheck(db, fyId))
    return c.json({ precheck: precheck ?? null })
  })

  // 入力指示書（作成コーナー転記値一覧＋検算ブロック）。
  app.get('/filing/instruction-sheet', (c) => {
    const sheet = withOpenYearOrNull(c, (db, fyId) => buildFilingSheet(db, fyId))
    return c.json({ sheet: sheet ?? null })
  })

  // 完了記録の一覧（?year= で年分絞り込み）。
  app.get('/filing/records', (c) => {
    const rawYear = c.req.query('year')
    let year: number | undefined
    if (rawYear != null && rawYear !== '') {
      year = Number(rawYear)
      if (!Number.isInteger(year)) return c.json({ error: 'year が不正' }, 400)
    }
    return c.json({ records: listFilingRecords(dbOf(c), year) })
  })

  // 完了記録の作成（open 年度に紐づく）。
  app.post('/filing/records', async (c) => {
    const body = (await c.req.json().catch(() => null)) as {
      taxKind?: unknown
      method?: unknown
      submittedOn?: unknown
      receiptNumber?: unknown
      memo?: unknown
    } | null
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON body が必要' }, 400)
    if (!isTaxKind(body.taxKind)) return c.json({ error: `taxKind は ${FILING_TAX_KINDS.join(' / ')} のいずれか` }, 400)
    if (!isMethod(body.method)) return c.json({ error: `method は ${FILING_METHODS.join(' / ')} のいずれか` }, 400)
    if (typeof body.submittedOn !== 'string' || !DATE_RE.test(body.submittedOn)) {
      return c.json({ error: 'submittedOn (YYYY-MM-DD) が必要' }, 400)
    }
    const receiptNumber = body.receiptNumber == null ? null : String(body.receiptNumber)
    const memo = body.memo == null ? null : String(body.memo)
    if (receiptNumber && receiptNumber.length > 100) return c.json({ error: 'receiptNumber が長すぎます' }, 400)
    if (memo && memo.length > 1000) return c.json({ error: 'memo が長すぎます' }, 400)
    const { db, fyId } = requireOpenYear(c)
    const record = createFilingRecord(db, fyId, {
      taxKind: body.taxKind,
      method: body.method,
      submittedOn: body.submittedOn,
      receiptNumber,
      memo,
    })
    return c.json({ record })
  })

  // 完了記録の削除（添付ごと。誤登録の訂正用・UI のみ）。
  app.delete('/filing/records/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    try {
      deleteFilingRecord(dbOf(c), c.get('bookId'), id)
      return c.json({ ok: true })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 404)
    }
  })

  // 控えの添付（受信通知・申告書控え PDF 等。attachments と同方式＝生バイナリ＋fileName query）。
  app.post('/filing/records/:id/attachments', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const fileName = c.req.query('fileName') ?? ''
    const contentType = c.req.header('content-type') ?? ''
    const bytes = Buffer.from(await c.req.arrayBuffer())
    try {
      const attachment = addFilingAttachment(dbOf(c), c.get('bookId'), id, { fileName, contentType, bytes })
      return c.json({ attachment })
    } catch (err) {
      const message = (err as Error).message
      return c.json({ error: message }, message.includes('見つかりません') ? 404 : 400)
    }
  })

  return app
}
