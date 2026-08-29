import type { TaxForecastScenario, TaxForecastWhatIf, TaxForecast } from '@kanean/shared'
export type { TaxForecastScenario, TaxForecastWhatIf, TaxForecast }
import { eq } from 'drizzle-orm'
import { type Yen, yen } from '@kanean/shared'
import {
  annualizeIncome,
  blueSpecialDeduction,
  computeIncomeTaxReturn,
  estimateBusinessTax,
  estimateResidentTax,
  simplifiedTax,
  type TaxRate,
} from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { fiscalYears } from '../db/data/schema.js'
import { taxSalesSummary } from '../reports/reports.js'
import { buildBlueReturnSummary } from './blueReturn.js'
import { buildIncomeTaxReturn } from './incomeTax.js'
import { buildConsumptionTaxReturn } from './consumptionTax.js'

/**
 * 納税予測・期中 what-if シミュレーション（roadmap の差別化機能）の組成。
 *
 * confirmed 仕訳の期中実績（既存の申告組成 buildIncomeTaxReturn / buildBlueReturnSummary /
 * taxSalesSummary を再利用）を経過月数で年換算し、年間の税負担（所得税・住民税・個人事業税・
 * 消費税）を予測する。extraExpense / extraDeduction を与えると「もし追加で経費/所得控除を
 * 使ったら」の what-if を併算し、税負担差（delta）を返す。
 *
 * 税額計算チェーンは全て core の純関数（annualizeIncome → blueSpecialDeduction →
 * computeIncomeTaxReturn / estimateResidentTax / estimateBusinessTax / simplifiedTax）に委譲し、
 * 本モジュールは DB 組成と年換算の入力整形のみを担う（規約: 会計計算は core に隔離）。
 *
 * ⚠️ legalRisk:medium — 参考値・税理士確認前。応答の disclaimer を UI が必ず表示する前提。
 */

/** 予測 API 応答に含める免責（roadmap の「参考値・税理士サインオフ前」方針の吸収）。 */
export const TAX_FORECAST_DISCLAIMER =
  '本予測は確定済み仕訳の年換算による参考値です（住民税・個人事業税は概算）。' +
  '実際の税額は税制改正・自治体の決定・業種等により異なります。申告・納税の判断は税理士に確認してください。'

export interface TaxForecastOptions {
  /** what-if: 追加で使う経費（年額・非負円整数）。 */
  extraExpense?: Yen
  /** what-if: 追加の所得控除（年額・非負円整数。小規模企業共済・iDeCo 等の想定）。 */
  extraDeduction?: Yen
  /** 「今日」。既定は実時刻（テスト容易性のため注入可能）。 */
  now?: Date
}

/**
 * 期首（YYYY-MM-DD）から now までの経過月数。進行中の当月も1ヶ月と数える
 * （suggestInitialFiscalYear と同じ「サーバ時刻を正とする」流儀で現地時刻の暦月比較）。
 * 年度開始前は1（÷0回避の保守値）、年度期間超過は12（年換算＝恒等）にクランプする。
 */
function elapsedMonthsOf(startDate: string, now: Date): number {
  const startYear = Number(startDate.slice(0, 4))
  const startMonth = Number(startDate.slice(5, 7))
  const months = (now.getFullYear() - startYear) * 12 + (now.getMonth() + 1 - startMonth) + 1
  return Math.min(12, Math.max(1, months))
}

/** 課税標準額の千円未満切捨て（申告書レイヤの端数規約。consumptionTax.ts と同じ扱い）。 */
function truncateThousand(n: number): number {
  return Math.floor(n / 1000) * 1000
}

/** open 年度の年間税負担を予測する（＋任意の what-if）。年度が無ければ throw。 */
export function buildTaxForecast(
  db: DataDb,
  fiscalYearId: number,
  opts: TaxForecastOptions = {},
): TaxForecast {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fiscalYearId} が見つかりません`)
  const elapsedMonths = elapsedMonthsOf(fy.startDate, opts.now ?? new Date())

  // 実績の組成は既存の申告チェーンを再利用（控除入力 taxReturnInputs・売上・㊸㊺・申告区分）。
  const actualReturn = buildIncomeTaxReturn(db, fiscalYearId)
  const blue = buildBlueReturnSummary(db, fiscalYearId)
  // 消費税は事業区分（business_settings）の解決を既存組成から再利用する。
  const consumption = buildConsumptionTaxReturn(db, fiscalYearId)

  // 消費税予測: 課税売上の税抜額（税率別）を年換算 → 千円未満切捨て（申告書レイヤの端数規約）
  // → core simplifiedTax。返還等対価・貸倒れは発生が不規則で年換算になじまないため織り込まない。
  // extraExpense は経費（仕入税額はみなし控除）なので簡易課税の納付額に影響せず、両シナリオ共通。
  const base: Partial<Record<TaxRate, Yen>> = {}
  for (const b of taxSalesSummary(db, fiscalYearId).baseByRate) {
    if (b.rate !== 10 && b.rate !== 8) continue
    base[b.rate as TaxRate] = yen(truncateThousand(annualizeIncome(b.net, elapsedMonths)))
  }
  const consumptionTax = simplifiedTax({ category: consumption.businessCategory, base }).total

  // 年換算は青色申告特別控除**前**の㊸に対して行う。㊺（控除後）を直接年換算すると
  // 定額（年額）の青色控除まで 12/n 倍に膨らみ予測が過大控除になるため、
  // 年換算後の㊸へ core blueSpecialDeduction を改めて適用して㊺を出す。
  const projectedPre = annualizeIncome(blue.incomeBeforeDeduction, elapsedMonths)

  const scenario = (preDeductionIncome: Yen, extraDeduction: Yen): TaxForecastScenario => {
    const blueCalc = blueSpecialDeduction({
      incomeBeforeDeduction: preDeductionIncome,
      filingType: blue.filingType,
      bookkeeping: 'double_entry', // 本システムは複式簿記（blueReturn.ts と同じ前提）
      qualifiesFor65: blue.qualifiesFor65,
    })
    const calc = computeIncomeTaxReturn({
      totalIncome: blueCalc.incomeAfter,
      // 保存済みの所得控除入力を使い、what-if の追加控除は「その他の所得控除」へ加算する。
      deductions: {
        ...actualReturn.inputs,
        otherDeductions: actualReturn.inputs.otherDeductions + extraDeduction,
      },
      // 予測は「年間の税負担額」を示す。源泉・予定納税は既払い分の精算であって負担額を
      // 変えないため、ここでは控除しない（taxWithSurtax をそのまま incomeTax とする）。
      withholding: yen(0),
      estimatedPrepaid: yen(0),
    })
    const residentTax = estimateResidentTax(calc.taxableIncome)
    // 個人事業税に青色申告特別控除の適用はない → 課税標準の概算に控除前㊸（年換算）を使う。
    const businessTax = estimateBusinessTax(preDeductionIncome)
    return {
      businessIncome: blueCalc.incomeAfter,
      taxableIncome: calc.taxableIncome,
      incomeTax: calc.taxWithSurtax,
      residentTax,
      businessTax,
      consumptionTax,
      totalTax: yen(calc.taxWithSurtax + residentTax + businessTax + consumptionTax),
    }
  }

  const projected = scenario(projectedPre, yen(0))

  let whatIf: TaxForecastWhatIf | undefined
  if (opts.extraExpense != null || opts.extraDeduction != null) {
    const extraExpense = opts.extraExpense ?? yen(0)
    const extraDeduction = opts.extraDeduction ?? yen(0)
    const s = scenario(yen(projectedPre - extraExpense), extraDeduction)
    whatIf = { ...s, extraExpense, extraDeduction, delta: yen(s.totalTax - projected.totalTax) }
  }

  return {
    fiscalYearId,
    elapsedMonths,
    actual: { businessIncome: actualReturn.businessIncome, sales: actualReturn.businessRevenue },
    projected,
    whatIf,
    disclaimer: TAX_FORECAST_DISCLAIMER,
  }
}
