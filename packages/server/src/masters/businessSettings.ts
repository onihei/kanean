import type { BusinessSettingsView, BusinessSettingsPatch } from '@kanean/shared'
export type { BusinessSettingsView, BusinessSettingsPatch }
import { eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { businessSettings } from '../db/data/schema.js'

/**
 * 事業者設定（business_settings 単一行）の取得・更新。
 * 申告区分・経理方式・消費税方式など、帳票/申告の前提となる基本設定。
 * 値の妥当性（簡易課税の事業区分・税抜/税込経理の選択）は申告時に税理士確認の対象。
 */

/** 1行も無いとき（初期状態）に返す既定値（schema の default と一致）。 */
const DEFAULTS: BusinessSettingsView = {
  configured: false,
  businessName: null,
  ownerName: null,
  phone: null,
  entityType: 'individual',
  filingType: 'blue',
  filingForm: null,
  industry: null,
  prefecture: null,
  ebookStorage: false,
  blueDeductionETax: false,
  evidenceCapture: false,
  taxMethod: 'simplified',
  taxBusinessCategory: null,
  accountingMethod: 'tax_included',
  roundingSales: 'floor',
  roundingPurchase: 'floor',
  depreciationRecordMethod: 'indirect',
}

export function getBusinessSettings(db: DataDb): BusinessSettingsView {
  const row = db.select().from(businessSettings).all()[0]
  if (!row) return { ...DEFAULTS }
  return {
    configured: true,
    businessName: row.businessName ?? null,
    ownerName: row.ownerName ?? null,
    phone: row.phone ?? null,
    entityType: row.entityType,
    filingType: row.filingType,
    filingForm: row.filingForm ?? null,
    industry: row.industry ?? null,
    prefecture: row.prefecture ?? null,
    ebookStorage: row.ebookStorage,
    blueDeductionETax: row.blueDeductionETax,
    evidenceCapture: row.evidenceCapture,
    taxMethod: row.taxMethod,
    taxBusinessCategory: row.taxBusinessCategory ?? null,
    accountingMethod: row.accountingMethod,
    roundingSales: row.roundingSales,
    roundingPurchase: row.roundingPurchase,
    depreciationRecordMethod: row.depreciationRecordMethod,
  }
}

const FILING_TYPES = new Set(['blue', 'white'])
const TAX_METHODS = new Set(['simplified', 'general', 'exempt'])
const ACCOUNTING_METHODS = new Set(['tax_included', 'tax_excluded'])

/** 単一行を upsert（送られたフィールドのみ反映）。区分系は許容値を検証。 */
export function updateBusinessSettings(db: DataDb, patch: BusinessSettingsPatch): void {
  if (patch.filingType !== undefined && !FILING_TYPES.has(patch.filingType)) throw new Error('filingType が不正（blue/white）')
  if (patch.taxMethod !== undefined && !TAX_METHODS.has(patch.taxMethod)) throw new Error('taxMethod が不正（simplified/general/exempt）')
  if (patch.accountingMethod !== undefined && !ACCOUNTING_METHODS.has(patch.accountingMethod)) throw new Error('accountingMethod が不正（tax_included/tax_excluded）')

  const now = new Date().toISOString()
  // updatedAt は必須（notNull）。Partial だと挿入時に undefined 許容となり型が合わないため必須で固定する。
  const set: Partial<typeof businessSettings.$inferInsert> & { updatedAt: string } = { updatedAt: now }
  if (patch.businessName !== undefined) set.businessName = patch.businessName
  if (patch.ownerName !== undefined) set.ownerName = patch.ownerName
  if (patch.phone !== undefined) set.phone = patch.phone
  if (patch.filingType !== undefined) set.filingType = patch.filingType
  if (patch.filingForm !== undefined) set.filingForm = patch.filingForm
  if (patch.industry !== undefined) set.industry = patch.industry
  if (patch.prefecture !== undefined) set.prefecture = patch.prefecture
  if (patch.ebookStorage !== undefined) set.ebookStorage = patch.ebookStorage
  if (patch.blueDeductionETax !== undefined) set.blueDeductionETax = patch.blueDeductionETax
  if (patch.evidenceCapture !== undefined) set.evidenceCapture = patch.evidenceCapture
  if (patch.taxMethod !== undefined) set.taxMethod = patch.taxMethod
  if (patch.taxBusinessCategory !== undefined) set.taxBusinessCategory = patch.taxBusinessCategory
  if (patch.accountingMethod !== undefined) set.accountingMethod = patch.accountingMethod

  const existing = db.select({ id: businessSettings.id }).from(businessSettings).all()[0]
  if (existing) {
    db.update(businessSettings).set(set).where(eq(businessSettings.id, existing.id)).run()
  } else {
    db.insert(businessSettings).values({ ...set, createdAt: now }).run()
  }
}
