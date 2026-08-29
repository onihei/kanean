import { Hono } from 'hono'
import { bodyLimit } from 'hono/body-limit'
import { z } from 'zod'
import type { DbRouter } from '../db/router.js'
import { withBook, type BookVariables } from '../books/middleware.js'
import { listLinkedServices } from '../import/ecServices.js'
import { lookupEcClassification } from '../journal/ecClassifyService.js'
import { ecImport } from '../import/ecImport.js'
import { PreconditionError } from '../import/precondition.js'
import { bankImport } from '../import/bankImport.js'
import { validationError } from './errors.js'

/**
 * 連携サービス取込スキル用 API（ec-import-api.md）。認証は行わない（local-access spec
 * 「取込スキルの呼び出し境界」）。同一マシンのスキルがループバック経由で直接呼ぶ。
 * 対象帳簿は withBook が解決する（1冊なら指定不要・2冊以上は X-Book-Id 必須。books spec）。
 * /api とはボディ上限・エラー形式が異なるため /skill に分けてマウントする。
 */

// 円整数の安全上限（2^53 安全圏。これを超える額は domain 層に渡さず 400 で弾く）。
const YEN_MAX = 999_999_999_999
// 配列・本文サイズの上限（DoS 抑止）。
const MAX_ORDERS = 5000
const MAX_LINES = 1000
const MAX_ITEMS = 2000
const MAX_TXNS = 10000 // 銀行明細（1口座・open期間分）。年間でも十分な天井。
const MAX_BODY_BYTES = 5 * 1024 * 1024

const yenAmount = (allowZero: boolean) =>
  (allowZero ? z.number().int().nonnegative() : z.number().int().positive()).max(YEN_MAX)

const lookupSchema = z.object({
  source: z.string().min(1).max(200),
  items: z.array(z.string().max(1000)).max(MAX_ITEMS),
  windowMonths: z.number().int().positive().max(1200).optional(),
  limit: z.number().int().positive().max(5000).optional(),
})

const ecLineSchema = z.object({
  lineNo: z.number().int().nonnegative(),
  itemName: z.string().min(1).max(1000),
  quantity: z.number().positive(),
  lineAmount: yenAmount(true), // ポイント全額充当の 0 円明細は許容（負数は弾く）
  proposedAccount: z.string().max(200).optional(),
  treatment: z.enum(['expense', 'owner_draw', 'unresolved']).optional(),
  reason: z.string().max(2000).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  policyRef: z.string().max(200).optional(),
  evidenceRef: z.string().min(1).max(2000),
})

const ecOrderSchema = z.object({
  orderId: z.string().min(1).max(200),
  orderDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式'),
  orderTotal: yenAmount(true),
  paymentHint: z.string().max(200).optional(),
  currency: z.string().max(10).optional(),
  // 注文レベル調整（[csv-format §4.3] 方式B。非負円整数・省略=0）。本体が未払金=請求額になるよう調整仕訳を生成。
  // 割引は lineAmount を純額化（適格請求書PDFの商品別小計）して取り込むため、ここには持たない。
  shipping: yenAmount(true).optional(), // 送料・手数料 → 借)雑費
  pointsUsed: yenAmount(true).optional(), // ポイント利用 → 貸)事業主借
  pointsEarned: yenAmount(true).optional(), // ポイント付与 → 借)事業主貸/貸)雑収入（任意）
  lines: z.array(ecLineSchema).min(1).max(MAX_LINES),
})

const journalCandidatesSchema = z.object({
  accountRef: z.string().min(1).max(200), // 投入先（連携サービスの linked_account_ref。GET /skill/linked-services の accountRef）
  fileName: z.string().max(500).optional(),
  orders: z.array(ecOrderSchema).min(1).max(MAX_ORDERS),
})

// 銀行（普通預金）取引1行（[bank-import-api.md]）。amount は方向と分離した非負円整数。
const bankTxnSchema = z.object({
  txnDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式'),
  amount: yenAmount(true),
  direction: z.enum(['in', 'out']),
  description: z.string().min(1).max(1000),
  balance: z.number().int().min(-YEN_MAX).max(YEN_MAX).nullable().optional(), // 差引残高（残高チェーン。負残高も許容）
  proposedAccount: z.string().max(200).optional(),
  treatment: z.enum(['expense', 'owner_draw', 'owner_contribution', 'revenue', 'settlement', 'unresolved']).optional(),
  reason: z.string().max(2000).optional(),
  confidence: z.enum(['high', 'medium', 'low']).optional(),
  policyRef: z.string().max(200).optional(),
  evidenceRef: z.string().max(2000).optional(),
  counterSubAccountRef: z.string().max(200).optional(),
})

const bankJournalCandidatesSchema = z.object({
  accountRef: z.string().min(1).max(200), // 投入先（銀行口座の linked_account_ref。GET /skill/linked-services の bankAccounts[].accountRef）
  fileName: z.string().max(500).optional(),
  transactions: z.array(bankTxnSchema).min(1).max(MAX_TXNS),
})

// validationError は http/errors.ts の共有版を使う（逐語重複していた。issue #115）。
export function ecSkillRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  // `*` で受けると、同じ `/skill` にマウントされた他のアプリのルート（レシート取込は
  // 画像を運ぶので本文上限が違う）にもこの上限が掛かる。自分のパスにだけ効かせる。
  const OWN_PATHS = ['/linked-services', '/classification-history/*', '/ec/*', '/bank/*']
  for (const path of OWN_PATHS) {
    app.use(path, withBook(router))
    app.use(path, bodyLimit({ maxSize: MAX_BODY_BYTES, onError: (c) => c.json({ error: { code: 'validation_error', message: 'request body too large' } }, 413) }))
  }

  // §1 巡回対象＋最終取得日
  app.get('/linked-services', (c) => c.json(listLinkedServices(router.bookDb(c.get('bookId')))))

  // §2 分類履歴（絞り込み済み）
  app.post('/classification-history/lookup', async (c) => {
    const parsed = lookupSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(validationError(parsed.error), 400)
    const { source, items, windowMonths, limit } = parsed.data
    return c.json(lookupEcClassification(router.bookDb(c.get('bookId')), source, items, { windowMonths, limit }))
  })

  // §3 仕訳候補を draft 投入
  app.post('/ec/journal-candidates', async (c) => {
    const parsed = journalCandidatesSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(validationError(parsed.error), 400)
    try {
      return c.json(ecImport(router, c.get('bookId'), parsed.data))
    } catch (e) {
      // 前提不足（会計年度なし / 連携サービス未登録 / シード未投入）は curated なコード＋メッセージで 409。
      if (e instanceof PreconditionError) {
        return c.json({ error: { code: e.code, message: e.message } }, 409)
      }
      // 想定外は内部詳細を漏らさない（ログのみ）。
      console.error('[ec/journal-candidates] unexpected error', e)
      return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
    }
  })

  // 銀行（普通預金）仕訳候補を draft 投入（[bank-import-api.md]）。EC と別経路＝貸方が普通預金一脚・treatment 語彙が広い。
  app.post('/bank/journal-candidates', async (c) => {
    const parsed = bankJournalCandidatesSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(validationError(parsed.error), 400)
    try {
      return c.json(bankImport(router, c.get('bookId'), parsed.data))
    } catch (e) {
      if (e instanceof PreconditionError) {
        return c.json({ error: { code: e.code, message: e.message } }, 409)
      }
      console.error('[bank/journal-candidates] unexpected error', e)
      return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
    }
  })

  return app
}
