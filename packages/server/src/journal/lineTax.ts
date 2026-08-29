import { and, eq } from 'drizzle-orm'
import { yen, type Rounding } from '@kanean/shared'
import { inclusiveTax } from '@kanean/core'
import type { DataDb, DataTx } from '../db/router.js'
import { accounts, businessSettings, subAccounts, taxCategories } from '../db/data/schema.js'

/**
 * 仕訳明細の税区分自動付与と税額算出（accounting-spec §4 / roadmap Phase1 F-JNL-3）。
 * - 税区分: 明示 > 補助科目の既定 > 勘定科目の既定（default_tax_category_id はシード済）。
 * - 税額: 課税区分のみ。**税込経理（既定）の内税逆算**。端数は
 *   売上=rounding_sales / 仕入=rounding_purchase（business_settings、既定 floor）。
 * - 非課税/対象外、または率なしは tax_amount=null。
 * - amount は記帳額（税込グロス）前提。税抜経理（本体・仮払/仮受の分離記帳, §4.1）は
 *   別フェーズ。現状 accounting_method は tax_included 固定運用のため内税逆算に統一する。
 */

export interface LineTaxInput {
  accountId: number
  subAccountId?: number | null
  /** 明示指定（あれば既定より優先）。 */
  taxCategoryId?: number | null
  /** 税込経理なら税込金額、税抜経理なら本体金額。 */
  amount: number
}

export interface ResolvedLineTax {
  taxCategoryId: number | null
  taxAmount: number | null
}

const asRounding = (v: string | undefined): Rounding => (v === 'ceil' || v === 'round' ? v : 'floor')

/** 明細の税区分と税額を解決する。 */
export function resolveLineTax(db: DataDb | DataTx, input: LineTaxInput): ResolvedLineTax {
  let taxCategoryId = input.taxCategoryId ?? null

  // 補助科目の既定（その補助が当該勘定に属する場合のみ＝別勘定の補助の混入を防ぐ）。
  if (taxCategoryId == null && input.subAccountId != null) {
    taxCategoryId =
      db
        .select({ d: subAccounts.defaultTaxCategoryId })
        .from(subAccounts)
        .where(and(eq(subAccounts.id, input.subAccountId), eq(subAccounts.accountId, input.accountId)))
        .all()[0]?.d ?? null
  }
  if (taxCategoryId == null) {
    taxCategoryId = db.select({ d: accounts.defaultTaxCategoryId }).from(accounts).where(eq(accounts.id, input.accountId)).all()[0]?.d ?? null
  }
  if (taxCategoryId == null) return { taxCategoryId: null, taxAmount: null }

  const tc = db.select().from(taxCategories).where(eq(taxCategories.id, taxCategoryId)).all()[0]
  if (!tc || tc.taxability !== 'taxable' || !tc.rate || tc.rate <= 0) {
    return { taxCategoryId, taxAmount: null }
  }

  const bs = db.select().from(businessSettings).all()[0]
  const rounding = asRounding(tc.direction === 'sale' ? bs?.roundingSales : bs?.roundingPurchase)
  const taxAmount = inclusiveTax(yen(input.amount), tc.rate, rounding)
  return { taxCategoryId, taxAmount }
}
