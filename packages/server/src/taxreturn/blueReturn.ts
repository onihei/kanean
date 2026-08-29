import type { BlueReturnSummary } from '@kanean/shared'
export type { BlueReturnSummary }
import { eq } from 'drizzle-orm'
import { blueSpecialDeduction } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { businessSettings } from '../db/data/schema.js'
import { profitAndLoss } from '../reports/reports.js'

/**
 * 青色申告決算書（損益）の所得金額確定（form-mapping §1.1）。
 *   ㊸ 控除前所得金額（= profitAndLoss().netIncome）
 *   → ㊹ 青色申告特別控除額（core blueSpecialDeduction で 65/55/10万 判定）
 *   → ㊺ 所得金額（= ㊸ − ㊹。確定申告書 第一表 事業所得 KAKUTEI.1.AMOUNT_BIZ へ転記）
 *
 * 本システムは複式簿記（貸借対照表を生成）なので bookkeeping='double_entry' 前提。
 * 65万円の電子要件（e-Tax提出 または 優良な電子帳簿）は business_settings.blue_deduction_e_tax で
 * ユーザー/税理士が明示（既定 false＝保守的55万円）。
 *
 * ⚠️ legalRisk:high — 65/55/10万の要件充足の事実認定・申告様式は税理士サインオフ対象。
 *    「提出可能」を単独で宣言しない。複数所得の合算は対象外（事業所得単独前提）。
 */

export function buildBlueReturnSummary(db: DataDb, fiscalYearId: number): BlueReturnSummary {
  const settings = db.select().from(businessSettings).all()[0]
  const filingType: 'blue' | 'white' = settings?.filingType === 'white' ? 'white' : 'blue'
  const qualifiesFor65 = settings?.blueDeductionETax ?? false

  const incomeBeforeDeduction = profitAndLoss(db, fiscalYearId).netIncome
  const r = blueSpecialDeduction({
    incomeBeforeDeduction,
    filingType,
    bookkeeping: 'double_entry', // 本システムは複式簿記（貸借対照表を生成）
    qualifiesFor65,
  })

  return {
    incomeBeforeDeduction,
    deductionLimit: r.limit,
    deduction: r.deduction,
    income: r.incomeAfter,
    filingType,
    qualifiesFor65,
    basis: r.basis,
  }
}

/** 65万円控除の電子要件フラグを設定（business_settings 単一行を upsert）。 */
export function setBlueDeductionETax(db: DataDb, value: boolean): void {
  const now = new Date().toISOString()
  const existing = db.select({ id: businessSettings.id }).from(businessSettings).all()[0]
  if (existing) {
    db.update(businessSettings).set({ blueDeductionETax: value, updatedAt: now }).where(eq(businessSettings.id, existing.id)).run()
  } else {
    db.insert(businessSettings).values({ blueDeductionETax: value, createdAt: now, updatedAt: now }).run()
  }
}
