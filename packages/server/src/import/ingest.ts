import type { DataDb } from '../db/router.js'
import { rawTransactions } from '../db/data/schema.js'

/**
 * 行単位 ingest の最小核（B4=#117 ②）: raw 挿入（冪等＝dedup_hash の onConflictDoNothing）→
 * 仕訳化を1トランザクションで原子化する。途中失敗はその行の raw ごとロールバック
 * （dedup を残さない＝再取込可）。
 *
 * EC/銀行の2経路が同文で持っていた核だけを共有し、summary の積み方（経路ごとに
 * レコード形状が違う）は呼び出し側に残す（全面ジェネリック化は棄却済み・B4 注意）。
 */
export function ingestRow<R>(
  db: DataDb,
  values: typeof rawTransactions.$inferInsert,
  journalizeRow: (db: DataDb, raw: typeof rawTransactions.$inferSelect) => R,
): { kind: 'dup' } | { kind: 'ok'; result: R } {
  return db.transaction(() => {
    const insertedRaw = db.insert(rawTransactions).values(values).onConflictDoNothing().returning().all()[0]
    if (!insertedRaw) return { kind: 'dup' as const }
    return { kind: 'ok' as const, result: journalizeRow(db, insertedRaw) }
  })
}
