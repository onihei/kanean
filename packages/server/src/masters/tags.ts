import type { Tag } from '@kanean/shared'
import { asc, eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { entryTags, tags } from '../db/data/schema.js'

/**
 * タグマスタ CRUD（data-model §2.8.4 / roadmap Phase1 最小 CRUD）。
 * name は UNIQUE。仕訳への付与（entry_tags）UI は後続。
 * 物理削除（is_active 列なし）。削除時は entry_tags の参照も先に外す。
 */

export type TagRow = typeof tags.$inferSelect

export function listTags(db: DataDb): Tag[] {
  return db.select().from(tags).orderBy(asc(tags.name)).all()
}

/** タグ作成。同名が既にあれば既存 id を返す（冪等・UNIQUE 衝突回避）。 */
export function createTag(db: DataDb, name: string): number {
  const n = (name ?? '').trim()
  if (!n) throw new Error('タグ名は必須です')
  const existing = db.select().from(tags).where(eq(tags.name, n)).all()[0]
  if (existing) return existing.id
  return db.insert(tags).values({ name: n }).returning().all()[0].id
}

/** タグを物理削除（付与済み entry_tags も外す）。 */
export function deleteTag(db: DataDb, id: number): void {
  const existing = db.select().from(tags).where(eq(tags.id, id)).all()[0]
  if (!existing) throw new Error(`タグ ${id} が見つかりません`)
  db.transaction((tx) => {
    tx.delete(entryTags).where(eq(entryTags.tagId, id)).run()
    tx.delete(tags).where(eq(tags.id, id)).run()
  })
}
