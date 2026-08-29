import type { ConsumptionTaxBaseRow, ConsumptionTaxReturn } from '@kanean/shared'
export type { ConsumptionTaxBaseRow, ConsumptionTaxReturn }
import { type Yen, yen } from '@kanean/shared'
import { simplifiedTax, nationalTaxOf, DEEMED_PURCHASE_RATE, type SimplifiedCategory, type TaxRate } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { businessSettings } from '../db/data/schema.js'
import { taxSalesSummary } from '../reports/reports.js'

/**
 * 消費税及び地方消費税申告書（簡易課税用）の組成（accounting-spec §3 / form-mapping §3）。
 *
 * 入力源は taxSalesSummary（税区分別 課税売上集計・税抜課税標準額）。本サービスが申告書
 * 固有の処理を足す:
 *  - 課税標準額の **千円未満切捨て**（税率別。core simplifiedTax は税抜額を受け取る前提で
 *    千円未満切捨ては申告書レイヤの責務）。
 *  - 事業区分（business_settings.tax_business_category。既定 第5種＝みなし50%）の解決。
 *  - 付表4-3/5-3 と第一表の欄構造への整形。返還等対価・貸倒れの国税分を控除。
 *
 * 計算は core simplifiedTax（ゴールデン: 税抜1000万@10% → 国390k/地方110k/合計500k）に委譲。
 *
 * ⚠️ legalRisk:high — 事業区分・みなし仕入率・課税標準額の端数（千円未満切捨て）・申告様式は
 *    税理士サインオフ対象。本表は参考値で「提出可能」を単独で宣言しない。
 *    課税標準額は本システムの税込経理（行単位で内税確定済）の税抜額を千円未満切捨てしたもので、
 *    「税込合計×100/110 を切捨て」の公式手順と行単位丸めの差が出うる（要検証）。
 */

/** 事業区分ラベル（第N種）→ SimplifiedCategory。 */
const CATEGORY_BY_LABEL: Readonly<Record<string, SimplifiedCategory>> = {
  第1種: 1,
  第2種: 2,
  第3種: 3,
  第4種: 4,
  第5種: 5,
  第6種: 6,
}

const TAX_RATES: TaxRate[] = [10, 8]

function truncateThousand(n: number): number {
  return Math.floor(n / 1000) * 1000
}

function isTaxRate(rate: number | null): rate is TaxRate {
  return rate === 10 || rate === 8
}

/** 開いている課税期間（会計年度）の消費税申告書（簡易課税）を組成する。 */
export function buildConsumptionTaxReturn(db: DataDb, fiscalYearId: number): ConsumptionTaxReturn {
  const settings = db.select().from(businessSettings).all()[0]
  const taxMethod = settings?.taxMethod ?? 'simplified'
  const businessCategory = CATEGORY_BY_LABEL[settings?.taxBusinessCategory ?? ''] ?? 5
  const deemedRate = DEEMED_PURCHASE_RATE[businessCategory]

  const summary = taxSalesSummary(db, fiscalYearId)

  // 課税標準額（税抜・千円未満切捨て）。税率別売上税額（国税）は core の単一実装に委譲する。
  const base: Partial<Record<TaxRate, Yen>> = {}
  const rowOrder: TaxRate[] = []
  for (const b of summary.baseByRate) {
    if (!isTaxRate(b.rate)) continue
    base[b.rate] = yen(truncateThousand(b.net))
    rowOrder.push(b.rate)
  }

  // 返還等対価・貸倒れの国税分（税区分行ごとに税抜額×国税割合を切捨てして税率別に合算。
  // 国税換算は core の nationalTaxOf＝第一表と同一実装。行単位 floor の粒度は従来どおり）。
  const returnsNational: Partial<Record<TaxRate, Yen>> = {}
  const badDebtNational: Partial<Record<TaxRate, Yen>> = {}
  for (const r of summary.rows) {
    if (!isTaxRate(r.rate)) continue
    const natl = nationalTaxOf(yen(r.netAmount), r.rate)
    if (r.adjustment === 'return') returnsNational[r.rate] = yen((returnsNational[r.rate] ?? 0) + natl)
    else if (r.adjustment === 'bad_debt') badDebtNational[r.rate] = yen((badDebtNational[r.rate] ?? 0) + natl)
  }

  const result = simplifiedTax({ category: businessCategory, base, returnsNational, badDebtNational })

  // 付表4-3/5-3 の税率別行（売上税額は core の税率別内訳をそのまま整形＝第一表と常に一致）。
  const baseRows: ConsumptionTaxBaseRow[] = rowOrder.map((rate) => ({
    rate,
    taxBase: base[rate]!,
    salesTaxNational: result.salesTaxNationalByRate[rate] ?? yen(0),
  }))

  const sumRate = (m: Partial<Record<TaxRate, Yen>>) => yen(TAX_RATES.reduce<number>((s, r) => s + (m[r] ?? 0), 0))

  const applicable = taxMethod === 'simplified'

  return {
    taxMethod,
    businessCategory,
    deemedRate,
    baseRows,
    taxBaseTotal: yen(baseRows.reduce((s, r) => s + r.taxBase, 0)),
    salesTaxNational: result.salesTaxNational,
    deemedDeduction: result.deemedDeduction,
    returnNational: sumRate(returnsNational),
    badDebtNational: sumRate(badDebtNational),
    national: result.national,
    local: result.local,
    midPaid: yen(0),
    payable: result.total,
    applicable,
    note: applicable ? null : `税方式が ${taxMethod} のため、本表は簡易課税前提の参考値です。`,
  }
}
