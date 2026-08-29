import type { CounterpartyInput, Counterparty } from '@kanean/shared'
export type { CounterpartyInput }
import { definedEntries, getByIdOrThrow, setActiveById, trimToNull as t } from '../db/crudHelpers.js'
import { asc, eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { counterparties } from '../db/data/schema.js'

/**
 * 取引先マスタ CRUD（data-model §2.5 / roadmap Phase1）。
 * journal_lines.counterparty_id・documents.counterparty_id・sub_accounts.counterparty_id の参照元。
 * 削除は論理削除（is_active=false。D-8 帳簿訂正履歴要件）。参照されていても安全に無効化できる。
 */

export type CounterpartyRow = typeof counterparties.$inferSelect

const INVOICE_REG_NO = /^T\d{13}$/


/** 入力を検証し、永続化する列値（id/is_active/timestamps を除く）へ整形。 */
function buildFields(input: CounterpartyInput) {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('取引先名は必須です')

  const invoiceRegNo = t(input.invoiceRegNo)
  if (invoiceRegNo && !INVOICE_REG_NO.test(invoiceRegNo)) {
    throw new Error('登録番号は「T」+13桁の数字で指定してください（例 T1234567890123）')
  }

  return {
    name,
    nameKana: t(input.nameKana),
    honorific: t(input.honorific),
    customerCode: t(input.customerCode),
    invoiceRegNo,
    peppolId: t(input.peppolId),
    paymentTermMonth: t(input.paymentTermMonth),
    paymentTermDay: t(input.paymentTermDay),
    holidayAdjustment: t(input.holidayAdjustment),
    zip: t(input.zip),
    prefecture: t(input.prefecture),
    address1: t(input.address1),
    address2: t(input.address2),
    phone: t(input.phone),
    email: t(input.email),
    ccEmail: t(input.ccEmail),
    contactName: t(input.contactName),
    contactTitle: t(input.contactTitle),
    memo: t(input.memo),
  }
}

/** 取引先一覧（名前順）。既定は有効のみ。 */
export function listCounterparties(db: DataDb, includeInactive = false): Counterparty[] {
  const base = db.select().from(counterparties)
  const rows = (includeInactive ? base : base.where(eq(counterparties.isActive, true)))
    .orderBy(asc(counterparties.name), asc(counterparties.id))
    .all()
  return rows
}

export function getCounterparty(db: DataDb, id: number): CounterpartyRow {
  return getByIdOrThrow(db, counterparties, id, '取引先')
}

export function createCounterparty(db: DataDb, input: CounterpartyInput): number {
  const fields = buildFields(input)
  const now = new Date().toISOString()
  return db
    .insert(counterparties)
    .values({ ...fields, isActive: true, createdAt: now, updatedAt: now })
    .returning()
    .all()[0].id
}

export function updateCounterparty(db: DataDb, id: number, input: CounterpartyInput): void {
  const existing = getCounterparty(db, id)
  // 入力で undefined のキーは現状維持（部分更新でのフィールド消失を防ぐ）。
  // existing は同名カラムを全て持つので、buildFields が拾う入力キーを上書きできる。
  const fields = buildFields({ ...existing, ...definedEntries(input) } as CounterpartyInput)
  db.update(counterparties)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(counterparties.id, id))
    .run()
}

export function setCounterpartyActive(db: DataDb, id: number, isActive: boolean): void {
  setActiveById(db, counterparties, id, isActive, '取引先', { touchUpdatedAt: true })
}
