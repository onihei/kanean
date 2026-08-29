import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { DbRouter } from '../db/router.js'
import { withBook, type BookVariables } from '../books/middleware.js'
import { PreconditionError } from '../import/precondition.js'
import { receiptImport, receiptMatch } from '../import/receiptImport.js'
import { validationError } from './errors.js'

/**
 * レシート取込スキル用 API（skill-import spec「現金レシートの draft 投入」「カード払いレシートの
 * 突合候補の提示」）。ec.ts と同じ `/skill` 空間だが、**画像を運ぶぶんボディ上限が違う**ため分ける。
 *
 * 画像は base64 で JSON に同梱する。仕訳と証憑を1回の呼び出しで作る＝
 * 「仕訳と証憑を離ればなれにしない」（receipt-inbox spec）ための割り切り。
 */

const YEN_MAX = 999_999_999_999
/** 添付1ファイルの上限（20MB）＋ base64 の膨張（4/3）＋メタの余白。 */
const MAX_BODY_BYTES = 28 * 1024 * 1024
const MAX_IMAGE_BYTES = 20 * 1024 * 1024

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式')
const yenAmount = z.number().int().nonnegative().max(YEN_MAX)

const imageSchema = z.object({
  fileName: z.string().min(1).max(255),
  contentType: z.enum(['image/heic', 'image/heif', 'image/jpeg', 'image/png']),
  sha256: z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 は小文字16進64文字'),
  /** 画像本体（base64）。 */
  base64: z.string().min(1),
})

const receiptSchema = z.object({
  // 端末 OCR が読めなかった場合は欠けたまま届く。起票しない判断はサービス側が返す。
  transactionDate: isoDate.optional(),
  totalAmount: yenAmount.optional(),
  merchant: z.string().max(500).optional(),
  proposedAccount: z.string().max(200).optional(),
  usage: z.enum(['business', 'prorated', 'private']).optional(),
  meal: z
    .object({
      partySize: z.number().int().positive().max(999),
      participants: z.array(z.string().min(1).max(100)).max(50).optional(),
    })
    .optional(),
  memo: z.string().max(1000).optional(),
  image: imageSchema,
})

const matchSchema = z.object({
  transactionDate: isoDate,
  totalAmount: yenAmount,
  merchant: z.string().max(500).optional(),
})

export function receiptSkillRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  app.use('*', withBook(router))
  app.use(
    '*',
    bodyLimit({
      maxSize: MAX_BODY_BYTES,
      onError: (c) =>
        c.json({ error: { code: 'validation_error', message: 'request body too large' } }, 413),
    }),
  )

  // 現金レシート → draft 仕訳＋証憑添付。カードはこの経路を通さない（起票しないため）。
  app.post('/receipts/journal-candidates', async (c) => {
    const parsed = receiptSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(validationError(parsed.error), 400)
    const { image, ...rest } = parsed.data
    const bytes = Buffer.from(image.base64, 'base64')
    if (bytes.length === 0) {
      return c.json(
        { error: { code: 'validation_error', message: '画像が空です' } },
        400,
      )
    }
    if (bytes.length > MAX_IMAGE_BYTES) {
      return c.json(
        { error: { code: 'validation_error', message: '画像が上限（20MB）を超えています' } },
        400,
      )
    }
    try {
      return c.json(
        receiptImport(router, c.get('bookId'), {
          ...rest,
          image: {
            fileName: image.fileName,
            contentType: image.contentType,
            sha256: image.sha256,
            bytes,
          },
        }),
      )
    } catch (e) {
      if (e instanceof PreconditionError) {
        return c.json({ error: { code: e.code, message: e.message } }, 409)
      }
      console.error('[receipts/journal-candidates] unexpected error', e)
      return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
    }
  })

  // カード払い → 候補提示のみ。起票の経路を持たない（skill-import spec）。
  app.post('/receipts/match', async (c) => {
    const parsed = matchSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(validationError(parsed.error), 400)
    try {
      return c.json(receiptMatch(router, c.get('bookId'), parsed.data))
    } catch (e) {
      if (e instanceof PreconditionError) {
        return c.json({ error: { code: e.code, message: e.message } }, 409)
      }
      console.error('[receipts/match] unexpected error', e)
      return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
    }
  })

  return app
}
