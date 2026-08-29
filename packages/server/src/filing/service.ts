import { desc, eq, sql } from 'drizzle-orm'
import { yen } from '@kanean/shared'
import { buildFilingInstructionSheet } from '@kanean/core'
import type {
  FilingPrecheck,
  FilingIssue,
  FilingInstructionSheet,
  FilingRecord,
  FilingTaxKind,
  FilingMethod,
  AttachmentMeta,
} from '@kanean/shared'
export type { FilingPrecheck, FilingIssue, FilingInstructionSheet, FilingRecord } from '@kanean/shared'
import type { DataDb } from '../db/router.js'
import { filingRecords, fiscalYears, taxReturnInputs, businessSettings, journalEntries, attachments } from '../db/data/schema.js'
import { trialBalance, taxSalesSummary } from '../reports/reports.js'
import { buildBlueReturnStatement } from '../reports/blueReturnStatement.js'
import { buildBlueBalanceSheet } from '../reports/blueBalanceSheet.js'
import {
  depreciationBreakdown,
  salaryBreakdown,
  rentBreakdown,
  senjuBreakdown,
  monthlySalesPurchase,
  reserveAllowanceCalc,
} from '../reports/breakdowns.js'
import { buildBlueReturnSummary } from '../taxreturn/blueReturn.js'
import { buildIncomeTaxReturn } from '../taxreturn/incomeTax.js'
import { buildConsumptionTaxReturn } from '../taxreturn/consumptionTax.js'
import { addAttachmentTo, listAttachmentsFor, removeAttachment, type AttachmentFileInput } from '../attachments/service.js'

/**
 * 申告の提出支援（filing spec）。
 *  - precheck: 申告前の前提を決定的に判定（blocking / warning）。「提出可能」は語彙に無い。
 *  - instruction sheet: tax-return の組成 organ を core の射影で作成コーナー転記値一覧へ写す。
 *  - records: 提出の事実の記録（受付番号・控え添付）。有効性は判定しない。
 * ⚠️ legalRisk:high — 出力は税理士サインオフ前の参考値。
 */

const PRECHECK_DISCLAIMER =
  '不備が見つからない場合も「提出可能」を意味しません。申告の最終確認は税理士に委ねてください。'

/** 年分（暦年）。個人は暦年会計なので開始日の年 = 年分。 */
function yearOf(db: DataDb, fiscalYearId: number): number {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fiscalYearId} が見つかりません`)
  return Number(fy.startDate.slice(0, 4))
}

export function filingPrecheck(db: DataDb, fiscalYearId: number): FilingPrecheck {
  const issues: FilingIssue[] = []

  // 貸借の一致（総勘定レベル）。
  const trial = trialBalance(db, fiscalYearId)
  if (!trial.balanced) {
    issues.push({
      level: 'blocking',
      code: 'trial_unbalanced',
      message: '仕訳の貸借が一致していません（試算表で差額を確認してください）',
      screen: 'trial',
    })
  }

  // 貸借対照表（様式）の一致（期首残高・元入金連結を含む）。
  const bsSheet = buildBlueBalanceSheet(db, fiscalYearId)
  if (!bsSheet.balanced) {
    issues.push({
      level: 'blocking',
      code: 'bs_unbalanced',
      message: '貸借対照表の資産合計と負債・資本合計が一致していません（開始残高・元入金を確認してください）',
      screen: 'bs',
    })
  }

  // 減価償却: 資産台帳の必要経費算入額と帳簿の減価償却費⑱の整合。
  const statement = buildBlueReturnStatement(db, fiscalYearId)
  const depBox = statement.pl.expenses.find((e) => e.code === 'AOIRO.PL.EXP_DEP')
  const dep = depreciationBreakdown(db, fiscalYearId)
  if ((depBox?.amount ?? 0) !== dep.businessAmountTotal) {
    issues.push({
      level: 'blocking',
      code: 'depreciation_mismatch',
      message: `減価償却費の帳簿計上額（${depBox?.amount ?? 0}円）と資産台帳の必要経費算入額（${dep.businessAmountTotal}円）が一致していません（償却仕訳の起票を確認してください）`,
      screen: null,
    })
  }

  // 青色申告特別控除の設定（e-Tax 送信するなら 65 万の電子要件を満たしうる）。
  const summary = buildBlueReturnSummary(db, fiscalYearId)
  if (summary.filingType === 'blue' && !summary.qualifiesFor65) {
    issues.push({
      level: 'warning',
      code: 'blue65_unset',
      message:
        '青色申告特別控除が55万円の設定です。e-Tax で送信するなら65万円の電子要件を満たす可能性があります（設定を確認してください）',
      screen: 'incometax',
    })
  }

  // 消費税の前提（簡易課税・事業区分）。
  const settings = db.select().from(businessSettings).all()[0]
  if ((settings?.taxMethod ?? 'simplified') !== 'simplified') {
    issues.push({
      level: 'warning',
      code: 'consumption_not_simplified',
      message: '税方式が簡易課税ではないため、入力指示書に消費税（C 群）は含まれません',
      screen: 'tax',
    })
  } else if (!settings?.taxBusinessCategory) {
    issues.push({
      level: 'warning',
      code: 'tax_category_default',
      message: '消費税の事業区分が未設定のため既定（第5種・みなし仕入率50%）で計算しています',
      screen: 'settings',
    })
  }

  // 所得控除入力の保存有無。
  const inputsRow = db.select().from(taxReturnInputs).where(eq(taxReturnInputs.fiscalYearId, fiscalYearId)).all()[0]
  if (!inputsRow) {
    issues.push({
      level: 'warning',
      code: 'deduction_inputs_missing',
      message: '所得控除（社会保険料・生命保険料等）が未入力です（既定値＝基礎控除のみで計算しています）',
      screen: 'incometax',
    })
  }

  // 未確定 draft（集計には含まれない。黙って落とさない）。
  const draftCount =
    db
      .select({ c: sql<number>`count(*)` })
      .from(journalEntries)
      .where(sql`${journalEntries.fiscalYearId} = ${fiscalYearId} and ${journalEntries.status} = 'draft'`)
      .all()[0]?.c ?? 0
  if (draftCount > 0) {
    issues.push({
      level: 'warning',
      code: 'drafts_pending',
      message: `承認待ちの draft 仕訳が ${draftCount} 件あります（集計には含まれていません）`,
      screen: 'raw',
    })
  }

  return {
    fiscalYearId,
    year: yearOf(db, fiscalYearId),
    issues,
    draftCount,
    disclaimer: PRECHECK_DISCLAIMER,
  }
}

/** 入力指示書。組成は tax-return の organ と同一（金額は構造上一致する）。 */
export function buildFilingSheet(db: DataDb, fiscalYearId: number): FilingInstructionSheet {
  const blueStatement = {
    pl: buildBlueReturnStatement(db, fiscalYearId).pl,
    balanceSheet: buildBlueBalanceSheet(db, fiscalYearId),
    summary: buildBlueReturnSummary(db, fiscalYearId),
    monthly: monthlySalesPurchase(db, fiscalYearId),
    salary: salaryBreakdown(db, fiscalYearId),
    senju: senjuBreakdown(db, fiscalYearId),
    rent: rentBreakdown(db, fiscalYearId),
    depreciation: depreciationBreakdown(db, fiscalYearId),
    reserveAllowance: reserveAllowanceCalc(db, fiscalYearId),
  }
  const consumptionGrossByRate = taxSalesSummary(db, fiscalYearId)
    .baseByRate.filter((b) => b.rate === 10 || b.rate === 8)
    .map((b) => ({ rate: b.rate, gross: yen(b.net + b.tax) }))
  return buildFilingInstructionSheet({
    fiscalYearId,
    year: yearOf(db, fiscalYearId),
    blueStatement,
    incomeTax: buildIncomeTaxReturn(db, fiscalYearId),
    consumption: buildConsumptionTaxReturn(db, fiscalYearId),
    consumptionGrossByRate,
  })
}

// --- 完了記録 ---------------------------------------------------------------

type FilingRecordRow = typeof filingRecords.$inferSelect

function toRecord(db: DataDb, row: FilingRecordRow): FilingRecord {
  return {
    id: row.id,
    fiscalYearId: row.fiscalYearId,
    taxKind: row.taxKind as FilingTaxKind,
    method: row.method as FilingMethod,
    submittedOn: row.submittedOn,
    receiptNumber: row.receiptNumber,
    memo: row.memo,
    createdAt: row.createdAt,
    attachments: listAttachmentsFor(db, { type: 'filing_record', id: row.id }),
  }
}

export interface CreateFilingRecordInput {
  taxKind: FilingTaxKind
  method: FilingMethod
  submittedOn: string
  receiptNumber?: string | null
  memo?: string | null
}

export function createFilingRecord(db: DataDb, fiscalYearId: number, input: CreateFilingRecordInput): FilingRecord {
  const row = db
    .insert(filingRecords)
    .values({
      fiscalYearId,
      taxKind: input.taxKind,
      method: input.method,
      submittedOn: input.submittedOn,
      receiptNumber: input.receiptNumber?.trim() || null,
      memo: input.memo?.trim() || null,
      createdAt: new Date().toISOString(),
    })
    .returning()
    .all()[0]
  return toRecord(db, row)
}

/** 完了記録の一覧（新しい順）。year（暦年）指定で当該年分に絞る。 */
export function listFilingRecords(db: DataDb, year?: number): FilingRecord[] {
  let rows = db.select().from(filingRecords).orderBy(desc(filingRecords.id)).all()
  if (year != null) {
    const fyIds = new Set(
      db
        .select({ id: fiscalYears.id })
        .from(fiscalYears)
        .where(sql`${fiscalYears.startDate} like ${`${year}-%`}`)
        .all()
        .map((r) => r.id),
    )
    rows = rows.filter((r) => fyIds.has(r.fiscalYearId))
  }
  return rows.map((r) => toRecord(db, r))
}

export function getFilingRecord(db: DataDb, id: number): FilingRecord | undefined {
  const row = db.select().from(filingRecords).where(eq(filingRecords.id, id)).all()[0]
  return row ? toRecord(db, row) : undefined
}

/** 完了記録を添付ごと削除する（誤登録の訂正用。UI からのみ・MCP には露出しない）。 */
export function deleteFilingRecord(db: DataDb, bookId: string, id: number): void {
  const row = db.select().from(filingRecords).where(eq(filingRecords.id, id)).all()[0]
  if (!row) throw new Error(`完了記録 ${id} が見つかりません`)
  const metas = db
    .select({ id: attachments.id })
    .from(attachments)
    .where(sql`${attachments.targetType} = 'filing_record' and ${attachments.targetId} = ${id}`)
    .all()
  for (const m of metas) removeAttachment(db, bookId, m.id)
  db.delete(filingRecords).where(eq(filingRecords.id, id)).run()
}

/** 完了記録に控え（受信通知・申告書控え PDF 等）を添付する。制約は attachments と同一。 */
export function addFilingAttachment(
  db: DataDb,
  bookId: string,
  recordId: number,
  input: AttachmentFileInput,
): AttachmentMeta {
  const row = db.select({ id: filingRecords.id }).from(filingRecords).where(eq(filingRecords.id, recordId)).all()[0]
  if (!row) throw new Error(`完了記録 ${recordId} が見つかりません`)
  return addAttachmentTo(db, bookId, { type: 'filing_record', id: recordId }, input)
}
