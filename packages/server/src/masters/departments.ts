import type { Department } from '@kanean/shared'
import { getByIdOrThrow, setActiveById } from '../db/crudHelpers.js'
import { asc, eq, sql } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { departments } from '../db/data/schema.js'

/**
 * 部門マスタ CRUD（data-model §2.4 / roadmap Phase1）。
 * journal_lines.department_id の参照元（明細レベルの区分。部門別集計は Phase 2）。
 * 削除は論理削除（is_active=false。D-8）。
 */

export type DepartmentRow = typeof departments.$inferSelect

export function listDepartments(db: DataDb, includeInactive = false): Department[] {
  const base = db.select().from(departments)
  const rows = (includeInactive ? base : base.where(eq(departments.isActive, true)))
    .orderBy(asc(departments.sortOrder), asc(departments.id))
    .all()
  return rows
}

function getDepartment(db: DataDb, id: number): DepartmentRow {
  return getByIdOrThrow(db, departments, id, '部門')
}

export function createDepartment(db: DataDb, name: string): number {
  const n = (name ?? '').trim()
  if (!n) throw new Error('部門名は必須です')
  const [{ next }] = db
    .select({ next: sql<number>`coalesce(max(${departments.sortOrder}), -1) + 1` })
    .from(departments)
    .all()
  return db.insert(departments).values({ name: n, isActive: true, sortOrder: next }).returning().all()[0].id
}

export function updateDepartment(db: DataDb, id: number, name: string): void {
  getDepartment(db, id)
  const n = (name ?? '').trim()
  if (!n) throw new Error('部門名は必須です')
  db.update(departments).set({ name: n }).where(eq(departments.id, id)).run()
}

export function setDepartmentActive(db: DataDb, id: number, isActive: boolean): void {
  setActiveById(db, departments, id, isActive, '部門')
}
