import type { ImportStatus, SkippedDuplicate, ImportSummary } from '@kanean/shared'
export type { ImportStatus, SkippedDuplicate, ImportSummary }
import { SAMPLE_LIMIT } from './precondition.js'
import { eq } from 'drizzle-orm'
import type { DbRouter } from '../db/router.js'
import { importBatches, rawTransactions } from '../db/data/schema.js'
import { getOpenFiscalYear } from '../db/lookups.js'
import type { ParsedRow, ParseError } from './types.js'

/**
 * 取込 importer。ParsedRow[] を raw_transactions へ投入する。
 * - 会計期間ゲート（C-8）: 開いている会計年度の範囲外は取り込まない。
 * - 冪等（C-6）: UNIQUE(account_ref, dedup_hash) の重複はスキップ。
 * - 部分取込（C-9）: パース失敗行（parseErrors）と行単位の挿入失敗を退避し、正常行は取り込む。
 *   バッチ status を done/partial/failed で記録し、失敗内訳サンプルを保存・返却する（黙って落とさない）。
 */

export interface ImportArgs {
  /** 組込3形式（bank_ufj 等）または `format:{id}`（ユーザー定義フォーマット）。バッチへ保存する。 */
  sourceType: string
  accountRef: string
  fileName?: string
  rows: ParsedRow[]
  /** パース段階で失敗した行（dispatch/parser 由来）。バッチへ集約する。 */
  parseErrors?: ParseError[]
}

/** duplicates/errors 明細の返却・保存上限（年度CSV再取込時に応答・DOM・列が肥大しないよう先頭のみ）。 */

export function importRows(router: DbRouter, bookId: string, args: ImportArgs): ImportSummary {
  const db = router.bookDb(bookId)

  const open = getOpenFiscalYear(db)
  if (!open) {
    throw new Error('開いている会計年度がありません（取込前に会計年度を作成してください）')
  }
  const { startDate, endDate } = open
  const now = new Date().toISOString()

  const batch = db
    .insert(importBatches)
    .values({
      sourceType: args.sourceType,
      accountRef: args.accountRef,
      fileName: args.fileName ?? null,
      importedAt: now,
      rowCount: args.rows.length,
      status: 'done',
    })
    .returning()
    .all()[0]

  let inserted = 0
  let skippedDup = 0
  let skippedOutOfPeriod = 0
  const duplicates: SkippedDuplicate[] = []
  // パース失敗行を起点に、行単位の挿入失敗も同じ errors に積む（行番号で原因を辿れる）。
  const errors: ParseError[] = [...(args.parseErrors ?? [])]

  for (const row of args.rows) {
    // 会計期間ゲート: 範囲外（翌期等）は登録しない（ISO日付の辞書順比較で範囲判定）。
    if (row.txnDate < startDate || row.txnDate > endDate) {
      skippedOutOfPeriod++
      continue
    }
    try {
      const res = db
        .insert(rawTransactions)
        .values({
          batchId: batch.id,
          txnDate: row.txnDate,
          amount: row.amount,
          direction: row.direction,
          balance: row.balance ?? null,
          description: row.description,
          rawPayload: row.rawPayload,
          dedupHash: row.dedupHash,
          accountRef: args.accountRef,
          status: 'pending',
        })
        .onConflictDoNothing()
        .run()
      // UNIQUE(account_ref, dedup_hash) 衝突＝同一 hash が既存。出現インデックス方式なので、同一取込内の
      // 同日同額同摘要は別 hash で衝突しない。衝突は基本「同一データの再取込（既に取込済み）」だが、
      // 別取込の同日同額同摘要は内容だけでは再取込と区別できないため、ここに現れた行は
      // 「既取込 or 同一内容の別取引の可能性」として可視化し、利用者の確認に委ねる（黙って落とさない）。
      if (res.changes === 0) {
        skippedDup++
        if (duplicates.length < SAMPLE_LIMIT) {
          duplicates.push({ txnDate: row.txnDate, amount: row.amount, direction: row.direction, description: row.description })
        }
      } else inserted++
    } catch (err) {
      // 想定外の挿入失敗（行単位）。正常行は止めず退避する。
      errors.push({ rowNo: 0, raw: row.rawPayload, message: (err as Error).message })
    }
  }

  // 失敗ありで取込0 = failed、失敗ありで取込あり = partial、失敗なし = done。
  const status: ImportStatus = errors.length === 0 ? 'done' : inserted > 0 || skippedDup > 0 ? 'partial' : 'failed'
  const errorSample = errors.slice(0, SAMPLE_LIMIT)
  db.update(importBatches)
    .set({ status, errorCount: errors.length, errorSample: errors.length > 0 ? JSON.stringify(errorSample) : null })
    .where(eq(importBatches.id, batch.id))
    .run()

  return {
    batchId: batch.id,
    inserted,
    skippedDup,
    skippedOutOfPeriod,
    duplicates,
    errorCount: errors.length,
    errors: errorSample,
    status,
    periodStart: startDate,
    periodEnd: endDate,
  }
}
