import type { ItemInput, Item } from '@kanean/shared'
export type { ItemInput }
import { definedEntries, getByIdOrThrow, setActiveById, trimToNull as t } from '../db/crudHelpers.js'
import { asc, eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { items } from '../db/data/schema.js'

/**
 * 品目マスタ CRUD（data-model §2.6 / roadmap Phase1）。
 * 請求書明細（document_lines, Phase 5）から参照する単価・税率・源泉のテンプレート。
 * 削除は論理削除（is_active=false。D-8）。
 */

export type ItemRow = typeof items.$inferSelect

function assertNonNegativeInt(value: number | null | undefined, label: string): number | null {
  if (value == null) return null
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} は0以上の整数で指定してください`)
  return value
}

function buildFields(input: ItemInput) {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('品目名は必須です')
  if (input.taxRate != null && ![8, 10].includes(input.taxRate)) {
    throw new Error('消費税率は 10 / 8 で指定してください（非課税は未指定）')
  }
  return {
    name,
    itemCode: t(input.itemCode),
    unitPrice: assertNonNegativeInt(input.unitPrice, '単価'),
    defaultQuantity: assertNonNegativeInt(input.defaultQuantity, '既定数量'),
    unit: t(input.unit),
    detail: t(input.detail),
    taxRate: input.taxRate ?? null,
    withholding: input.withholding ?? false,
  }
}

export function listItems(db: DataDb, includeInactive = false): Item[] {
  const base = db.select().from(items)
  const rows = (includeInactive ? base : base.where(eq(items.isActive, true)))
    .orderBy(asc(items.name), asc(items.id))
    .all()
  return rows
}

function getItem(db: DataDb, id: number): ItemRow {
  return getByIdOrThrow(db, items, id, '品目')
}

export function createItem(db: DataDb, input: ItemInput): number {
  const fields = buildFields(input)
  return db.insert(items).values({ ...fields, isActive: true }).returning().all()[0].id
}

export function updateItem(db: DataDb, id: number, input: ItemInput): void {
  const existing = getItem(db, id)
  // 入力で undefined のキーは現状維持（部分更新でのフィールド消失を防ぐ）。
  const fields = buildFields({ ...existing, ...definedEntries(input) } as ItemInput)
  db.update(items).set(fields).where(eq(items.id, id)).run()
}

export function setItemActive(db: DataDb, id: number, isActive: boolean): void {
  setActiveById(db, items, id, isActive, '品目')
}
