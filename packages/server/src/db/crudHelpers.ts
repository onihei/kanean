import { eq } from 'drizzle-orm'
import type { AnySQLiteColumn, SQLiteTable } from 'drizzle-orm/sqlite-core'
import type { DataDb } from './router.js'

/**
 * マスタ CRUD の共有ヘルパ（B8=#120）。get-or-throw ×5・setActive ×5・trimToNull ×3・
 * 部分更新マージ ×2 の構造的重複を一本化する。masters/ への横断 import を避けるため
 * db/ に置く（journal/rules.ts も使う）。
 */

/** 空文字を NULL に寄せる（任意テキスト列の正規化）。 */
export const trimToNull = (v?: string | null): string | null => {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

/**
 * 入力で undefined のキーを落とす（部分更新マージ）。
 * `buildFields({ ...existing, ...definedEntries(input) })` の形で「未指定フィールドは現状維持」を作る。
 */
export function definedEntries<T extends object>(input: T): Partial<T> {
  return Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined)) as Partial<T>
}

type TableWithId = SQLiteTable & { id: AnySQLiteColumn }

/** id で1行取得。無ければ `${label} ${id} が見つかりません`（5マスタ共通の文言）で throw。 */
export function getByIdOrThrow<T extends TableWithId>(
  db: DataDb,
  table: T,
  id: number,
  label: string,
): T['$inferSelect'] {
  const row = db
    .select()
    .from(table as SQLiteTable)
    .where(eq(table.id, id))
    .all()[0]
  if (!row) throw new Error(`${label} ${id} が見つかりません`)
  return row as T['$inferSelect']
}

/**
 * 論理削除/復活（is_active）。物理削除は仕訳・書類の参照を壊すため行わない。
 * updated_at 列を持つマスタ（取引先・補助科目・仕訳ルール）は touchUpdatedAt で更新時刻も進める。
 */
export function setActiveById<T extends TableWithId>(
  db: DataDb,
  table: T,
  id: number,
  isActive: boolean,
  label: string,
  opts: { touchUpdatedAt?: boolean } = {},
): void {
  getByIdOrThrow(db, table, id, label)
  const set: Record<string, unknown> = opts.touchUpdatedAt
    ? { isActive, updatedAt: new Date().toISOString() }
    : { isActive }
  db.update(table as SQLiteTable)
    .set(set)
    .where(eq(table.id, id))
    .run()
}
