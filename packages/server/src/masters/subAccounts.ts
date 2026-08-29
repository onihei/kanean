import type { SubAccountInput, ImportAccount, SubAccount } from '@kanean/shared'
export type { SubAccountInput, ImportAccount }
import { getByIdOrThrow, setActiveById } from '../db/crudHelpers.js'
import { requireAccountIdByName } from '../db/lookups.js'
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { accounts, counterparties, importFormats, subAccounts, taxCategories } from '../db/data/schema.js'
import { SOURCE_TYPES, customFormatId, type SourceType } from '../import/types.js'

/**
 * 補助科目マスタ CRUD（data-model §2.3.4 / roadmap Phase1）。
 * 勘定科目の下に属し、補助元帳（Phase 2）の集計軸になる。
 * - default_tax_category_id: 明細の税区分既定（lineTax の解決順 補助>科目）。
 * - counterparty_id: 取引先補助科目（売掛/買掛の取引先別管理）。
 * - 親勘定（account_id）は作成後に変更しない（既存明細の belongs-to を壊さないため）。
 * - 削除は論理削除（is_active=false。D-8）。
 */

export type SubAccountRow = typeof subAccounts.$inferSelect

export type SubAccountPatch = Omit<SubAccountInput, 'accountId'>

/** 参照（勘定科目・税区分・取引先）の存在を検証する。 */
function validateRefs(db: DataDb, accountId: number, defaultTaxCategoryId?: number | null, counterpartyId?: number | null): void {
  const acc = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).all()[0]
  if (!acc) throw new Error(`勘定科目 ${accountId} が見つかりません`)
  if (defaultTaxCategoryId != null) {
    const tc = db.select({ id: taxCategories.id }).from(taxCategories).where(eq(taxCategories.id, defaultTaxCategoryId)).all()[0]
    if (!tc) throw new Error(`税区分 ${defaultTaxCategoryId} が見つかりません`)
  }
  if (counterpartyId != null) {
    const cp = db.select({ id: counterparties.id }).from(counterparties).where(eq(counterparties.id, counterpartyId)).all()[0]
    if (!cp) throw new Error(`取引先 ${counterpartyId} が見つかりません`)
  }
}

export interface ListSubAccountsOptions {
  accountId?: number
  includeInactive?: boolean
}

/** 補助科目一覧。accountId 指定でその勘定配下のみ。既定は有効のみ。 */
export function listSubAccounts(db: DataDb, opts: ListSubAccountsOptions = {}): SubAccount[] {
  const conds = []
  if (opts.accountId != null) conds.push(eq(subAccounts.accountId, opts.accountId))
  if (!opts.includeInactive) conds.push(eq(subAccounts.isActive, true))
  const base = db.select().from(subAccounts)
  const rows = (conds.length ? base.where(and(...conds)) : base)
    .orderBy(asc(subAccounts.accountId), asc(subAccounts.sortOrder), asc(subAccounts.id))
    .all()
  return rows
}

export function getSubAccount(db: DataDb, id: number): SubAccountRow {
  return getByIdOrThrow(db, subAccounts, id, '補助科目')
}

/** 同一勘定で同じ取引先に紐づく補助科目（有効/無効問わず）。重複防止・get-or-create の判定に使う。 */
function findCounterpartySubAccount(db: DataDb, accountId: number, counterpartyId: number): number | undefined {
  return db
    .select({ id: subAccounts.id })
    .from(subAccounts)
    .where(and(eq(subAccounts.accountId, accountId), eq(subAccounts.counterpartyId, counterpartyId)))
    .all()[0]?.id
}

export function createSubAccount(db: DataDb, input: SubAccountInput): number {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('補助科目名は必須です')
  validateRefs(db, input.accountId, input.defaultTaxCategoryId, input.counterpartyId)
  // 同一(勘定, 取引先)の補助科目は二重作成しない（請求書起票/開始残高の自動作成と手動作成で残高が割れるのを防ぐ）。
  if (input.counterpartyId != null && findCounterpartySubAccount(db, input.accountId, input.counterpartyId) != null) {
    throw new Error('この勘定科目には同じ取引先の補助科目が既にあります')
  }

  // 同一勘定の末尾へ。sort_order は現状の最大+1。
  const [{ next }] = db
    .select({ next: sql<number>`coalesce(max(${subAccounts.sortOrder}), -1) + 1` })
    .from(subAccounts)
    .where(eq(subAccounts.accountId, input.accountId))
    .all()
  const linkedAccountRef = (input.linkedAccountRef ?? '').trim() || null
  const now = new Date().toISOString()
  return db
    .insert(subAccounts)
    .values({
      accountId: input.accountId,
      name,
      defaultTaxCategoryId: input.defaultTaxCategoryId ?? null,
      counterpartyId: input.counterpartyId ?? null,
      linkedAccountRef,
      isActive: true,
      sortOrder: next,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()[0].id
}

/**
 * 取引先別の補助科目を取得（無ければ取引先名で作成）。売掛/買掛の取引先別管理を
 * 請求書起票・開始残高の両経路で共用し、同一(勘定, 取引先)の補助科目が二重作成されないことを保証する。
 */
export function getOrCreateCounterpartySubAccount(db: DataDb, accountId: number, counterpartyId: number): number {
  const existing = findCounterpartySubAccount(db, accountId, counterpartyId)
  if (existing != null) return existing
  const cp = db.select({ name: counterparties.name }).from(counterparties).where(eq(counterparties.id, counterpartyId)).all()[0]
  if (!cp) throw new Error(`取引先 ${counterpartyId} が見つかりません`)
  return createSubAccount(db, { accountId, name: cp.name, counterpartyId })
}

/** 補助科目を更新（親勘定 account_id は不変。名称・既定税区分・取引先・取込参照のみ）。 */
export function updateSubAccount(db: DataDb, id: number, patch: SubAccountPatch): void {
  const existing = getSubAccount(db, id)
  const name = (patch.name ?? '').trim()
  if (!name) throw new Error('補助科目名は必須です')
  validateRefs(db, existing.accountId, patch.defaultTaxCategoryId, patch.counterpartyId)
  if (patch.counterpartyId != null) {
    const dupId = findCounterpartySubAccount(db, existing.accountId, patch.counterpartyId)
    if (dupId != null && dupId !== id) throw new Error('この勘定科目には同じ取引先の補助科目が既にあります')
  }
  const linkedAccountRef = (patch.linkedAccountRef ?? '').trim() || null
  db.update(subAccounts)
    .set({
      name,
      defaultTaxCategoryId: patch.defaultTaxCategoryId ?? null,
      counterpartyId: patch.counterpartyId ?? null,
      linkedAccountRef,
      updatedAt: new Date().toISOString(),
    })
    .where(eq(subAccounts.id, id))
    .run()
}

export function setSubAccountActive(db: DataDb, id: number, isActive: boolean): void {
  setActiveById(db, subAccounts, id, isActive, '補助科目', { touchUpdatedAt: true })
}

// --- 口座マスタ（取込口座 = linked_account_ref を持つ補助科目）F-IMP-8 ---------

/** 口座マスタ一覧 = linked_account_ref を持つ補助科目（親勘定名を結合）。取込フォームの選択肢。 */
export function listImportAccounts(db: DataDb): ImportAccount[] {
  const rows = db
    .select({
      subAccountId: subAccounts.id,
      name: subAccounts.name,
      accountRef: subAccounts.linkedAccountRef,
      accountId: subAccounts.accountId,
      accountName: accounts.name,
      sourceType: subAccounts.importSourceType,
      isActive: subAccounts.isActive,
    })
    .from(subAccounts)
    .innerJoin(accounts, eq(subAccounts.accountId, accounts.id))
    // 有効な取込口座のみ（無効化＝アーカイブ済みは選択肢に出さない。listSubAccounts の既定と整合）。
    .where(and(isNotNull(subAccounts.linkedAccountRef), eq(subAccounts.isActive, true)))
    .orderBy(asc(subAccounts.accountId), asc(subAccounts.sortOrder), asc(subAccounts.id))
    .all()
  return rows.map((r) => ({ ...r, accountRef: r.accountRef as string }))
}

export interface CreateImportAccountInput {
  sourceType: string
  accountRef: string
  /** 親勘定科目 id（例: 普通預金 / 未払金）。 */
  accountId: number
  name?: string | null
}

/**
 * 口座マスタへ取込口座を新規登録する（補助科目として作成し linked_account_ref と import_source_type を設定）。
 * account_ref は一意（取込時の口座解決が一意になるよう重複を拒否）。
 */
export function createImportAccount(db: DataDb, input: CreateImportAccountInput): number {
  const accountRef = (input.accountRef ?? '').trim()
  if (!accountRef) throw new Error('口座識別子（account_ref）は必須です')
  // 取込形式は組込3形式、またはユーザー定義フォーマット（`format:{id}` で id が実在）のいずれか。
  const fid = customFormatId(input.sourceType)
  if (fid != null) {
    const fmt = db.select({ id: importFormats.id }).from(importFormats).where(eq(importFormats.id, fid)).all()[0]
    if (!fmt) throw new Error(`取込フォーマット ${fid} が見つかりません`)
  } else if (!SOURCE_TYPES.includes(input.sourceType as SourceType)) {
    throw new Error(`未対応の取込形式: ${input.sourceType}`)
  }
  const acc = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.accountId)).all()[0]
  if (!acc) throw new Error(`勘定科目 ${input.accountId} が見つかりません`)
  const dup = db.select({ id: subAccounts.id }).from(subAccounts).where(eq(subAccounts.linkedAccountRef, accountRef)).all()[0]
  if (dup) throw new Error(`口座識別子 "${accountRef}" は既に登録されています`)

  const name = (input.name ?? '').trim() || accountRef
  const [{ next }] = db
    .select({ next: sql<number>`coalesce(max(${subAccounts.sortOrder}), -1) + 1` })
    .from(subAccounts)
    .where(eq(subAccounts.accountId, input.accountId))
    .all()
  const now = new Date().toISOString()
  return db
    .insert(subAccounts)
    .values({
      accountId: input.accountId,
      name,
      linkedAccountRef: accountRef,
      importSourceType: input.sourceType,
      isActive: true,
      sortOrder: next,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()[0].id
}

/**
 * account_ref に紐づく補助科目が無ければ、指定勘定科目の下に作成して紐付ける（口座マスタ自動登録）。
 * http/routes/imports.ts から移動（issue #124 = B12）。createImportAccount への統合は
 * sortOrder と重複時の挙動が変わるため、ここでは行わない（統合するなら意識的に別判断）。
 */
export function ensureLinkedSubAccount(db: DataDb, accountRef: string, accountName: string, sourceType: string) {
  const existing = db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, accountRef)).all()[0]
  if (existing) return existing
  const accountId = requireAccountIdByName(db, accountName)
  const now = new Date().toISOString()
  db.insert(subAccounts)
    .values({ accountId, name: accountRef, linkedAccountRef: accountRef, importSourceType: sourceType, isActive: true, sortOrder: 0, createdAt: now, updatedAt: now })
    .run()
  return db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, accountRef)).all()[0]
}
