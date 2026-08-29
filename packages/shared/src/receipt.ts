import { z } from 'zod'

/**
 * レシート搬送の契約（receipt-inbox spec）。端末が inbox へ書くメタと、
 * Mac 側が書き戻す status の**唯一の定義**。
 *
 * ここが正で、JSON Schema はこれから生成する（`pnpm --filter @kanean/shared build:schema`）。
 * 生成物とゴールデンフィクスチャは `contract/receipt/` に置き、**TS 側と Dart 側の
 * 両方のテストが同じフィクスチャを読む** — 片側だけ解釈を変えるとどちらかが落ちる。
 *
 * zod を web のバンドルに混ぜないよう index からは export せず、
 * `@kanean/shared/receipt` の subpath で公開する（nodePaths.ts と同じ扱い）。
 */

/** 契約の版。端末と Mac が独立に更新されるため、読み手が版で分岐できるようにする。 */
export const RECEIPT_SCHEMA_VERSION = 1

/** 1件は `{ULID}` を共有する画像とメタの対で表される（design D6）。 */
const ulid = z
  .string()
  .regex(/^[0-7][0-9A-HJKMNP-TV-Z]{25}$/, 'ULID（Crockford Base32・26文字）である必要がある')

const sha256 = z.string().regex(/^[0-9a-f]{64}$/, 'SHA-256 は小文字16進64文字')

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD')

const isoDateTime = z.string().datetime({ offset: true })

/** 円整数。負・非整数・安全上限超えは受けない（[[skill-import]]「投入時の検証と権威」と同じ規律）。 */
const yenAmount = z.number().int().nonnegative().lt(1e12)

/**
 * 支払手段。**現金は起票し、カードは起票しない**（[[acquisition]] の取込と二重計上しないため）。
 * 撮影の瞬間にしか安く取れない情報なので、既定値を持たせず端末側で必ず選ばせる。
 */
export const PAYMENT_METHODS = ['cash', 'card'] as const
export type PaymentMethod = (typeof PAYMENT_METHODS)[number]

/** 用途。按分の判断材料として運ぶだけで、按分計算そのものは本体側が持つ。 */
export const RECEIPT_USAGES = ['business', 'prorated', 'private'] as const
export type ReceiptUsage = (typeof RECEIPT_USAGES)[number]

/** 簡易検査の指摘（receipt-capture spec「撮影時の簡易検査」）。押し切られた場合も理由を残す。 */
export const QUALITY_FLAGS = ['blur', 'glare', 'cropped'] as const
export type QualityFlag = (typeof QUALITY_FLAGS)[number]

/** 端末が inbox へ置く画像そのものの素性。冪等性の鍵は `sha256`（design D7）。 */
export const receiptImageSchema = z.object({
  /** 対になる画像のファイル名。拡張子は端末の出力形式による（HEIC/JPEG）。 */
  fileName: z.string().min(1).max(255),
  contentType: z.enum(['image/heic', 'image/heif', 'image/jpeg', 'image/png']),
  sizeBytes: z.number().int().positive(),
  sha256,
})
export type ReceiptImage = z.infer<typeof receiptImageSchema>

/**
 * 端末内の文字認識が読めたもの。**読み取りの正は Mac 側**なので、
 * 読めなくても撮影は成立する＝どちらも欠けてよい（receipt-capture spec）。
 */
export const receiptOcrSchema = z.object({
  date: isoDate.optional(),
  totalAmount: yenAmount.optional(),
})
export type ReceiptOcr = z.infer<typeof receiptOcrSchema>

/**
 * 飲食の文脈。交際費／会議費の判定は 1人あたり金額と参加者記録が要件で、
 * これも撮影時にしか取れない（proposal の Why）。
 */
export const receiptMealSchema = z.object({
  partySize: z.number().int().positive().max(999),
  /** 相手（誰と）。人数だけ分かって相手が空でもよい。 */
  participants: z.array(z.string().min(1).max(100)).max(50).optional(),
})
export type ReceiptMeal = z.infer<typeof receiptMealSchema>

/**
 * 画像に添えるメタ。**端末が付けた文脈をそのまま運び、解釈を含まない**
 * （何を起票するかの判断は本体側の権威）。
 */
export const receiptMetaSchema = z.object({
  schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
  /** 件の識別子。画像・メタ・status の三者を結ぶ鍵。 */
  id: ulid,
  capturedAt: isoDateTime,
  image: receiptImageSchema,
  /** 必須。端末側で未選択のまま送信させない（receipt-capture spec「現金とカードの分岐」）。 */
  paymentMethod: z.enum(PAYMENT_METHODS),
  usage: z.enum(RECEIPT_USAGES).optional(),
  meal: receiptMealSchema.optional(),
  memo: z.string().max(1000).optional(),
  ocr: receiptOcrSchema.optional(),
  /** 検査が指摘したうえで利用者が押し切った場合、その理由がここに残る。 */
  qualityFlags: z.array(z.enum(QUALITY_FLAGS)).max(QUALITY_FLAGS.length).optional(),
})
export type ReceiptMeta = z.infer<typeof receiptMetaSchema>

/**
 * 登録しなかった理由（receipt-inbox spec「status による逆方向の応答」）。
 * `unmatched_card` はカードのレシートに対応する明細が見つからなかった場合＝黙って起票しない。
 */
export const RECEIPT_SKIP_REASONS = [
  'duplicate',
  'unreadable',
  'out_of_period',
  'unmatched_card',
] as const
export type ReceiptSkipReason = (typeof RECEIPT_SKIP_REASONS)[number]

/** 登録された結果の要約。**帳簿の内容・残高・他の仕訳は運ばない**（receipt-inbox spec）。 */
export const receiptSummarySchema = z.object({
  entryId: z.number().int().positive(),
  date: isoDate,
  totalAmount: yenAmount,
  accountName: z.string().min(1).max(100),
})
export type ReceiptSummary = z.infer<typeof receiptSummarySchema>

/**
 * Mac 側が書き戻す status。`outcome` は登録できたかどうかの二値で、
 * 未登録なら必ず理由が付く（黙って落とさない）。
 */
export const receiptStatusSchema = z.discriminatedUnion('outcome', [
  z.object({
    schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
    id: ulid,
    processedAt: isoDateTime,
    outcome: z.literal('registered'),
    summary: receiptSummarySchema,
  }),
  z.object({
    schemaVersion: z.literal(RECEIPT_SCHEMA_VERSION),
    id: ulid,
    processedAt: isoDateTime,
    outcome: z.literal('skipped'),
    reason: z.enum(RECEIPT_SKIP_REASONS),
    /** 人に見せる1行。理由コードだけでは足りない補足。 */
    detail: z.string().max(500).optional(),
  }),
])
export type ReceiptStatus = z.infer<typeof receiptStatusSchema>

/** inbox 上のファイル名（design D6: `{ULID}.json` と `{ULID}.<ext>` の対）。 */
export function receiptMetaFileName(id: string): string {
  return `${id}.json`
}

/** status のファイル名。inbox と同じ `{ULID}` を鍵にする。 */
export function receiptStatusFileName(id: string): string {
  return `${id}.json`
}
