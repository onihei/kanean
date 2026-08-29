import type { TaxReturnInputsView, IncomeTaxReturn } from '@kanean/shared'
export type { TaxReturnInputsView, IncomeTaxReturn }
import { and, eq } from 'drizzle-orm'
import { yen } from '@kanean/shared'
import { computeIncomeTaxReturn, DEDUCTION_FIELDS } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { journalEntries, journalLines, subAccounts, taxReturnInputs } from '../db/data/schema.js'
import { findAccountIdByName as accountIdByName } from '../db/lookups.js'
import { profitAndLoss } from '../reports/reports.js'
import { buildBlueReturnSummary } from './blueReturn.js'
import { withholdingDetail } from './withholding.js'

/**
 * 確定申告書 第一表・第二表（所得税）の組成（form-mapping §2）。
 *
 * 本モジュールは **DB 組成**（青色決算書の所得・源泉徴収の帳簿集計・控除入力の load/upsert）と
 * View への整形のみを担い、第一表の数列計算（千円/百円未満切捨て・速算表・納付/還付分岐）は
 * core の computeIncomeTaxReturn（純関数・ゴールデンテスト対象）に委譲する。
 *
 * 所得控除は帳簿から導出できないユーザー入力（tax_return_inputs）。源泉徴収税額は帳簿から自動集計。
 *
 * ⚠️ legalRisk:high（担当=human）— 所得控除の妥当性・累進税率・所得税額・申告納税額は
 *    税理士サインオフ対象。複数所得の合算・損益通算・各種税額控除は対象外（事業所得単独前提）。
 *    「提出可能」を単独で宣言しない。
 */

const WITHHOLDING_ACCOUNT = '事業主貸'
const WITHHOLDING_SUB = '源泉所得税'

const DEFAULT_INPUTS: TaxReturnInputsView = {
  basicDeduction: 480_000,
  socialInsurance: 0,
  lifeInsurance: 0,
  medical: 0,
  spouseDependents: 0,
  otherDeductions: 0,
  estimatedPrepaid: 0,
}

/** 事業主貸/源泉所得税 の confirmed 残高（借方−貸方＝源泉徴収された所得税の累計）。 */
function withholdingTotal(db: DataDb, fiscalYearId: number): number {
  const accId = accountIdByName(db, WITHHOLDING_ACCOUNT)
  if (accId == null) return 0
  const sub = db
    .select({ id: subAccounts.id })
    .from(subAccounts)
    .where(and(eq(subAccounts.accountId, accId), eq(subAccounts.name, WITHHOLDING_SUB)))
    .all()[0]
  if (!sub) return 0

  const lines = db
    .select({ side: journalLines.side, amount: journalLines.amount })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.fiscalYearId, fiscalYearId),
        eq(journalEntries.status, 'confirmed'),
        eq(journalLines.accountId, accId),
        eq(journalLines.subAccountId, sub.id),
      ),
    )
    .all()
  let debit = 0
  let credit = 0
  for (const l of lines) {
    if (l.side === 'debit') debit += l.amount
    else credit += l.amount
  }
  return Math.max(0, debit - credit)
}

function loadInputs(db: DataDb, fiscalYearId: number): TaxReturnInputsView {
  const r = db.select().from(taxReturnInputs).where(eq(taxReturnInputs.fiscalYearId, fiscalYearId)).all()[0]
  if (!r) return { ...DEFAULT_INPUTS }
  return {
    basicDeduction: r.basicDeduction,
    socialInsurance: r.socialInsurance,
    lifeInsurance: r.lifeInsurance,
    medical: r.medical,
    spouseDependents: r.spouseDependents,
    otherDeductions: r.otherDeductions,
    estimatedPrepaid: r.estimatedPrepaid,
  }
}

export function buildIncomeTaxReturn(db: DataDb, fiscalYearId: number): IncomeTaxReturn {
  const businessIncome = buildBlueReturnSummary(db, fiscalYearId).income // ㊺
  const businessRevenue = profitAndLoss(db, fiscalYearId).sales.total // 収入金額（売上）
  const totalIncome = businessIncome // 事業所得単独前提

  const inputs = loadInputs(db, fiscalYearId)
  const withholding = withholdingTotal(db, fiscalYearId)

  // 第一表の数列計算（端数規約・納付/還付分岐）は core の純関数に委譲。
  const calc = computeIncomeTaxReturn({
    totalIncome: yen(totalIncome),
    deductions: inputs,
    withholding: yen(withholding),
    estimatedPrepaid: yen(inputs.estimatedPrepaid),
  })

  return {
    businessRevenue,
    businessIncome,
    totalIncome: yen(totalIncome),
    inputs,
    totalDeductions: calc.totalDeductions,
    taxableIncome: calc.taxableIncome,
    baseTax: calc.baseTax,
    surtax: calc.surtax,
    taxWithSurtax: calc.taxWithSurtax,
    withholding: yen(withholding),
    estimatedPrepaid: yen(inputs.estimatedPrepaid),
    payableRaw: calc.payableRaw,
    payable: calc.payable,
    refund: calc.refund,
    incomeDetail: withholdingDetail(db, fiscalYearId),
  }
}

export type UpsertTaxReturnInputs = Partial<TaxReturnInputsView>

/** 確定申告書の所得控除・予定納税の入力を upsert（年度別・単一行）。負値は弾く。 */
export function upsertTaxReturnInputs(db: DataDb, fiscalYearId: number, input: UpsertTaxReturnInputs): void {
  const now = new Date().toISOString()
  const fields = [...DEDUCTION_FIELDS, 'estimatedPrepaid'] as const
  const values: Partial<Record<(typeof fields)[number], number>> = {}
  for (const k of fields) {
    const v = input[k]
    if (v == null) continue
    if (!Number.isSafeInteger(v) || v < 0) throw new Error(`${k} は0以上の整数（円）で指定してください`)
    values[k] = v
  }

  const existing = db.select({ id: taxReturnInputs.id }).from(taxReturnInputs).where(eq(taxReturnInputs.fiscalYearId, fiscalYearId)).all()[0]
  if (existing) {
    db.update(taxReturnInputs).set({ ...values, updatedAt: now }).where(eq(taxReturnInputs.id, existing.id)).run()
  } else {
    db.insert(taxReturnInputs).values({ fiscalYearId, ...values, createdAt: now, updatedAt: now }).run()
  }
}
