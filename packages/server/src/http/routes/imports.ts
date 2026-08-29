import { RAW_STATUSES, type CsvImportResult, type RawStatus } from '@kanean/shared'
import { Hono } from 'hono'
import type { DbRouter } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import { parseBuffer } from '../../import/dispatch.js'
import { SOURCE_TYPES, customFormatId, type SourceType } from '../../import/types.js'
import type { ColumnMappingConfig } from '../../import/columnMapping.js'
import { importRows } from '../../import/importer.js'
import { reconcileBalances } from '../../import/reconcile.js'
import { listRawTransactions, ignoreRawTransaction, restoreRawTransaction } from '../../import/rawStatus.js'
import { listTransferCandidates, listLinkedTransfers, linkTransfer, unlinkTransfer } from '../../import/settlement.js'
import { journalizeBatch } from '../../journal/journalize.js'
import { listDrafts } from '../../journal/confirm.js'
import { getImportFormat } from '../../masters/importFormats.js'
import { ensureLinkedSubAccount } from '../../masters/subAccounts.js'
import { bookHelpers, intParam, openYear } from '../helpers.js'
import { requireOpenFiscalYear } from '../../db/lookups.js'

/**
 * 取込ルート（CSV 取込・draft レビュー・取込明細の状態・突合・口座間振替の名寄せ）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 */

const DEFAULT_SOURCE_ACCOUNT: Record<SourceType, string> = {
  bank_ufj: '普通預金',
  bank_shinsei: '普通預金',
  card_mufg_visa: '未払金',
}

export function importsRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf } = bookHelpers(router)

  app.get('/drafts', (c) => {
    const db = dbOf(c)
    const fy = openYear(db)
    // subAccountId 指定で連携サービス毎の draft に絞る（取込元行 line_no=1 の補助科目一致）。
    const subRaw = c.req.query('subAccountId')
    const subAccountId = subRaw != null && /^[1-9][0-9]*$/.test(subRaw) ? Number(subRaw) : undefined
    // 不正値は黙って全件表示に化けさせず 400（from/to/confidence と同じ契約。issue #143）。
    if (subRaw != null && subAccountId == null) return c.json({ error: 'subAccountId は正の整数で指定してください' }, 400)
    const limitRaw = c.req.query('limit')
    const limit = limitRaw != null && /^[1-9][0-9]*$/.test(limitRaw) ? Number(limitRaw) : undefined
    if (limitRaw != null && limit == null) return c.json({ error: 'limit は正の整数で指定してください' }, 400)
    // 取込レビュー用フィルタ: from/to=entry_date 範囲・q=摘要部分一致・confidence=AI仕訳の確信度。
    // 不正な値は黙って無視せず 400（打ち間違いで「全件表示」に化けると確認漏れの温床になる）。
    const from = c.req.query('from')
    const to = c.req.query('to')
    const dateRe = /^\d{4}-\d{2}-\d{2}$/
    if (from != null && !dateRe.test(from)) return c.json({ error: 'from は YYYY-MM-DD 形式で指定してください' }, 400)
    if (to != null && !dateRe.test(to)) return c.json({ error: 'to は YYYY-MM-DD 形式で指定してください' }, 400)
    const confRaw = c.req.query('confidence')
    const confidence = (['high', 'medium', 'low'] as const).find((v) => v === confRaw)
    if (confRaw != null && confidence == null) return c.json({ error: 'confidence は high/medium/low のいずれか' }, 400)
    const q = c.req.query('q') || undefined
    return c.json({ drafts: fy ? listDrafts(db, fy.id, { subAccountId, from, to, q, confidence, limit }) : [] })
  })

  // 残高同期・突合（口座別の累積残高 vs CSV残高・取りこぼし検知。Phase3・C-10）。
  app.get('/reports/reconciliation', (c) => c.json({ report: reconcileBalances(dbOf(c)) }))

  // 取込明細の状態フィルタ＋退避/復帰（Phase3「未確定明細の溜め込み強化」・ignored 配線）。
  app.get('/raw-transactions', (c) => {
    const q = c.req.query('status')
    const status = RAW_STATUSES.includes(q as RawStatus) ? (q as RawStatus) : undefined
    // 年スコープ: 既定は開いている会計年度に閉じる。?years=all で解除（それ以外の値は既定扱い）。
    const years = c.req.query('years') === 'all' ? 'all' : 'open'
    // wire 形は shared の RawTransactionListResponse（listRawTransactions の返り値型）が正（issue #245）。
    return c.json(listRawTransactions(dbOf(c), { status, years }))
  })
  app.post('/raw-transactions/:id/ignore', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    ignoreRawTransaction(dbOf(c), id)
    return c.json({ ok: true })
  })
  app.post('/raw-transactions/:id/restore', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    restoreRawTransaction(dbOf(c), id)
    return c.json({ ok: true })
  })

  // 取込元をまたぐ決済リンク／名寄せ（口座間振替。Phase3・legalRisk:high＝候補提示＋draft のみ）。
  app.get('/settlement/transfer-candidates', (c) => c.json({ candidates: listTransferCandidates(dbOf(c)) }))
  app.get('/settlement/links', (c) => c.json({ links: listLinkedTransfers(dbOf(c)) }))
  app.post('/settlement/link', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { outRawId?: number; inRawId?: number } | null
    if (!body || !Number.isInteger(body.outRawId) || !Number.isInteger(body.inRawId)) return c.json({ error: 'outRawId・inRawId が必要' }, 400)
    linkTransfer(dbOf(c), body.outRawId!, body.inRawId!)
    return c.json({ ok: true })
  })
  app.post('/settlement/unlink', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { rawId?: number } | null
    if (!body || !Number.isInteger(body.rawId)) return c.json({ error: 'rawId が必要' }, 400)
    unlinkTransfer(dbOf(c), body.rawId!)
    return c.json({ ok: true })
  })

  // CSV取込: ?sourceType=&accountRef=&accountName= 、body=ファイルバイト列
  app.post('/import', async (c) => {
    const sourceType = c.req.query('sourceType')
    const accountRef = c.req.query('accountRef')
    if (!sourceType || !accountRef) return c.json({ error: 'sourceType と accountRef が必要' }, 400)
    const db = dbOf(c)

    // ユーザー定義フォーマット（`format:{id}`）なら列マッピング設定を解決（デコード・汎用パースに使う）。
    let format: ColumnMappingConfig | undefined
    const fid = customFormatId(sourceType)
    if (fid != null) {
      format = getImportFormat(db, fid).config ?? undefined // 破損 config は getImportFormat が throw
    } else if (!SOURCE_TYPES.includes(sourceType as SourceType)) {
      return c.json({ error: `未対応の source_type: ${sourceType}` }, 400)
    }
    const accountName =
      c.req.query('accountName') ??
      (format ? format.defaultAccountName ?? '普通預金' : DEFAULT_SOURCE_ACCOUNT[sourceType as SourceType])

    let parsed
    try {
      parsed = parseBuffer(sourceType, Buffer.from(await c.req.arrayBuffer()), format)
    } catch (err) {
      // デコード/構造的破損など致命的失敗のみ（行単位の解釈失敗は parsed.errors に入り中断しない）。
      return c.json({ error: `パース失敗: ${(err as Error).message}` }, 400)
    }
    const { rows, errors: parseErrors } = parsed
    if (rows.length === 0) {
      // 空ファイル/明細なし（エラーも無い）: 取り込むものが無い。
      if (parseErrors.length === 0) return c.json({ error: '取込対象の明細がありません' }, 400)
      // 全行が解釈不能: バッチは作らないが、失敗内訳を ImportSummary 形で 200 返却し UI に行単位表示させる
      // （C-9・黙って落とさない。partial の 200 経路と表示を統一）。
      return c.json({
        import: {
          batchId: 0,
          inserted: 0,
          skippedDup: 0,
          skippedOutOfPeriod: 0,
          duplicates: [],
          errorCount: parseErrors.length,
          errors: parseErrors.slice(0, 50),
          status: 'failed' as const,
          periodStart: '',
          periodEnd: '',
        },
        journalized: { drafted: 0, skippedOutOfPeriod: 0 },
      } satisfies CsvImportResult)
    }

    // 口座マスタ未登録の自動リンク・投入・仕訳化。勘定科目名が見つからない等の入力起因失敗は
    // 素の 500 でなく 400(JSON) で返す（他ルートと同じ契約。例: custom format の defaultAccountName 未シード）。
    // 会計年度は初回セットアップで明示作成済みの前提（CSV先頭行からの自動確定は廃止）。
    requireOpenFiscalYear(db)
    ensureLinkedSubAccount(db, accountRef, accountName, sourceType)
    const summary = importRows(router, c.get('bookId'), { sourceType, accountRef, rows, parseErrors })
    const journalized = journalizeBatch(db, summary.batchId)
    return c.json({ import: summary, journalized } satisfies CsvImportResult)
  })

  return app
}
