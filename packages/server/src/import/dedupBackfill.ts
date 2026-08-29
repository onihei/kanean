import { asc, eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { rawTransactions } from '../db/data/schema.js'
import { dedupContentKey, occurrenceDedupHash } from './types.js'

/**
 * 既存 raw_transactions の dedup_hash を出現インデックス方式（csv-format C-6）へ再計算する移行（冪等）。
 *
 * 旧スキーム（残高/何回目依存・区切り子なし）で取り込まれた行は、新スキームで同じ CSV を再取込しても
 * dedup_hash が一致せず、UNIQUE(account_ref, dedup_hash) で衝突しない＝二重計上される（legalRisk:high）。
 * これを防ぐため、保存済み列 (account_ref, txn_date, amount, direction, description) から
 * (account_ref, 内容) グループ・id 昇順で出現インデックスを振り直し、dedup_hash を新方式へ更新する。
 * レシピ（列・順序・区切り子・出現連番）は取込時の withDedupHashes と同じ
 * occurrenceDedupHash / dedupContentKey（types.ts の単一真実源）を共有するため、
 * 移行後は同一 CSV の再取込が冪等になる。
 *
 * 既に新スキームの行は再計算結果が一致＝更新0。何度実行しても安全（deploy 毎に呼んでよい）。
 * @returns dedup_hash を更新した行数
 */
export function backfillDedupHashes(db: DataDb): number {
  const rows = db
    .select({
      id: rawTransactions.id,
      accountRef: rawTransactions.accountRef,
      txnDate: rawTransactions.txnDate,
      amount: rawTransactions.amount,
      direction: rawTransactions.direction,
      description: rawTransactions.description,
      dedupHash: rawTransactions.dedupHash,
    })
    .from(rawTransactions)
    // (account_ref, 内容) でまとめ、id 昇順＝取込（パース）順で出現インデックスを再現する。
    .orderBy(
      asc(rawTransactions.accountRef),
      asc(rawTransactions.txnDate),
      asc(rawTransactions.amount),
      asc(rawTransactions.direction),
      asc(rawTransactions.description),
      asc(rawTransactions.id),
    )
    .all()

  const occurrence = new Map<string, number>()
  const pending: { id: number; next: string }[] = []
  for (const r of rows) {
    const content = { txnDate: r.txnDate, amount: r.amount, direction: r.direction, description: r.description ?? '' }
    // 出現インデックスは口座（account_ref）毎に数える＝ UNIQUE(account_ref, dedup_hash) のスコープと一致。
    const groupKey = dedupContentKey(content, r.accountRef)
    const n = occurrence.get(groupKey) ?? 0
    occurrence.set(groupKey, n + 1)
    const next = occurrenceDedupHash(content, n)
    if (next !== r.dedupHash) pending.push({ id: r.id, next })
  }
  if (pending.length === 0) return 0
  // 単一トランザクションで適用：想定外の UNIQUE 衝突等が起きても原子的にロールバックし、
  // 半移行状態を残さない（冪等なので失敗後はそのまま再実行できる）。
  db.transaction((tx) => {
    for (const p of pending) tx.update(rawTransactions).set({ dedupHash: p.next }).where(eq(rawTransactions.id, p.id)).run()
  })
  return pending.length
}
