import { eq } from 'drizzle-orm'
import type { DataDb, DataTx } from './router.js'
import { accounts, fiscalYears } from './data/schema.js'

/**
 * 名前→id・open 年度の共有ルックアップ（B9=#121）。
 * 同じ select が10ファイル超にコピーされ、throw 版/null 版の2系統とエラー文言が
 * 不統一だった。**挙動の判断（0 フォールバック・PreconditionError 化・文言差）は
 * 呼び出し側に残し**、ここは選択句だけを一本化する。
 */

/** 勘定科目名 → id。見つからなければ null（「補助科目なし→0」等の解釈は呼び出し側の責務）。 */
export function findAccountIdByName(db: DataDb | DataTx, name: string): number | null {
  return db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, name)).all()[0]?.id ?? null
}

/** 勘定科目名 → id。見つからなければ throw（シード済みの前提科目が消えている＝データ異常）。 */
export function requireAccountIdByName(db: DataDb | DataTx, name: string): number {
  const id = findAccountIdByName(db, name)
  if (id == null) throw new Error(`勘定科目 "${name}" が見つかりません`)
  return id
}

/** 開いている会計年度（1本だけ open の運用）。無ければ undefined。 */
export function getOpenFiscalYear(db: DataDb | DataTx): typeof fiscalYears.$inferSelect | undefined {
  return db.select().from(fiscalYears).where(eq(fiscalYears.status, 'open')).all()[0]
}

/**
 * 開いている会計年度。無ければ throw。
 * 取込系（bank/ecImport）は 409 になる PreconditionError を投げる必要があるため、
 * ここではなく get 版＋呼び出し側 throw を使う（素の Error にすると 409→500 に退行。B9 注意②）。
 */
export function requireOpenFiscalYear(db: DataDb | DataTx): typeof fiscalYears.$inferSelect {
  const open = getOpenFiscalYear(db)
  if (!open) throw new Error('開いている会計年度がありません')
  return open
}
