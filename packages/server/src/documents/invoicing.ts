import { and, eq } from 'drizzle-orm'
import { type Yen, yen } from '@kanean/shared'
import { exclusiveTax, rewardWithholding } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { documents, subAccounts, taxCategories } from '../db/data/schema.js'
import { requireAccountIdByName as accountIdByName } from '../db/lookups.js'
import { createManualEntry, type ManualEntryLineInput } from '../journal/manualEntry.js'
import { getOrCreateCounterpartySubAccount } from '../masters/subAccounts.js'
import { getDocument } from './documents.js'

/**
 * 請求書の売掛金複合仕訳起票・入金消込（F-INV・accounting-spec §5）。税込経理。
 *
 * 起票（源泉なし）: 借)売掛金[総額] / 貸)売上高[総額]（税率別に売上行を分割・税区分付与）
 * 起票（源泉あり）: 借)売掛金[総額−源泉] 借)事業主貸(源泉所得税)[源泉] / 貸)売上高[総額]
 * 入金消込:        借)現金預金[回収額] / 貸)売掛金[回収額]
 *
 * 仕訳は createManualEntry（source='invoice'・confirmed。postRewardSale と同方針）で起票し、
 * documents.journalEntryId/status を更新する。源泉基礎は源泉対象行の本体合計（消費税は別記＝本体に源泉）。
 * ⚠️ legalRisk:high — 売上計上時期・源泉率/基礎・消費税区分は税理士サインオフ対象（自動確定はしない方針だが
 *    確定計上自体は手入力売上と同様 confirmed。提出可否は別途専門家確認）。
 */

const AR = '売掛金'
const SALE = '売上高'
const OWNER_DRAW = '事業主貸'
const WITHHOLDING_SUB = '源泉所得税'
const DEPOSIT = '普通預金'

function withholdingSubId(db: DataDb, ownerDrawId: number): number {
  const s = db
    .select({ id: subAccounts.id })
    .from(subAccounts)
    .where(and(eq(subAccounts.accountId, ownerDrawId), eq(subAccounts.name, WITHHOLDING_SUB)))
    .all()[0]
  if (!s) throw new Error(`補助科目 "${WITHHOLDING_SUB}" が見つかりません`)
  return s.id
}

/**
 * 取引先別の売掛金補助科目を解決（取引先ありは get-or-create、無指定は親科目へ直課＝null）。
 * 売掛金は取引先ごとに補助科目で内訳管理する（補助元帳・開始残高を顧客別に表現）。
 * 起票時に遅延作成し、開始残高経路と同一(勘定, 取引先)の補助科目に収束する（masters/subAccounts が一意性を担保）。
 */
function receivableSubAccountId(db: DataDb, arId: number, counterpartyId: number | null): number | null {
  return counterpartyId == null ? null : getOrCreateCounterpartySubAccount(db, arId, counterpartyId)
}

/** 税率（8/10）→ 課税売上の税区分（SALE_{rate}_C5・direction='sale'・adjustment='none'）を解決。 */
function saleCategoryId(db: DataDb, rate: number): number {
  const row = db
    .select({ id: taxCategories.id })
    .from(taxCategories)
    .where(and(eq(taxCategories.direction, 'sale'), eq(taxCategories.adjustment, 'none'), eq(taxCategories.rate, rate)))
    .all()[0]
  if (!row) throw new Error(`税率 ${rate}% の課税売上区分が見つかりません`)
  return row.id
}

export interface IssueInvoiceResult {
  entryId: number
  /** 売上総額（税込）。 */
  grossTotal: Yen
  /** 源泉徴収額。 */
  withholding: Yen
  /** 売掛金計上額（＝総額−源泉）。 */
  receivable: Yen
}

/** 請求書を起票し、売掛金の複合仕訳を作成する（confirmed・source='invoice'）。 */
export function issueInvoice(db: DataDb, fiscalYearId: number, documentId: number): IssueInvoiceResult {
  const doc = getDocument(db, documentId)
  if (doc.docType !== 'invoice') throw new Error('請求書(invoice)のみ起票できます')
  if (doc.journalEntryId != null) throw new Error('既に起票済みの請求書です')
  if (doc.status === 'void') throw new Error('無効化された書類は起票できません')
  if (doc.lines.length === 0) throw new Error('明細がありません')
  // 売上計上日＝仕訳日付（請求日と区別。spec §5）。未設定なら請求日にフォールバック。
  const entryDate = doc.revenueRecognitionDate ?? doc.issueDate
  if (!entryDate) throw new Error('売上計上日（または請求日）が必要です')

  // 税率別に本体を集計。源泉対象行の本体も合算。
  const netByRate = new Map<number, number>()
  let whBase = 0
  for (const l of doc.lines) {
    const rate = l.taxRate ?? 0
    if (rate !== 8 && rate !== 10) throw new Error(`明細の税率は 8 または 10 で指定してください（got ${l.taxRate ?? 'なし'}）`)
    const amt = l.amount ?? 0
    netByRate.set(rate, (netByRate.get(rate) ?? 0) + amt)
    if (l.withholding) whBase += amt
  }

  const arId = accountIdByName(db, AR)
  const saleId = accountIdByName(db, SALE)
  const cp = doc.counterpartyId ?? null
  const arSubId = receivableSubAccountId(db, arId, cp)

  // 貸)売上高（税率別・税込総額・税区分と内税額を明示）。
  const saleLines: ManualEntryLineInput[] = []
  let grossTotal = 0
  for (const rate of [...netByRate.keys()].sort((a, b) => a - b)) {
    const net = netByRate.get(rate)!
    if (net <= 0) continue
    const tax = exclusiveTax(yen(net), rate)
    const gross = net + tax
    grossTotal += gross
    saleLines.push({ side: 'credit', accountId: saleId, amount: gross, counterpartyId: cp, taxCategoryId: saleCategoryId(db, rate), taxAmount: tax })
  }
  if (grossTotal <= 0) throw new Error('起票対象の金額がありません')

  const withholding = whBase > 0 ? rewardWithholding(yen(whBase)) : 0
  const receivable = grossTotal - withholding

  const debitLines: ManualEntryLineInput[] = [{ side: 'debit', accountId: arId, subAccountId: arSubId, amount: receivable, counterpartyId: cp }]
  if (withholding > 0) {
    const ownerDrawId = accountIdByName(db, OWNER_DRAW)
    debitLines.push({ side: 'debit', accountId: ownerDrawId, subAccountId: withholdingSubId(db, ownerDrawId), amount: withholding, counterpartyId: cp })
  }

  const lines = [...debitLines, ...saleLines].filter((l) => l.amount > 0)
  const desc = `請求 ${(doc.docNo ?? doc.subject ?? '').toString()}`.trim()
  const entryId = createManualEntry(db, { fiscalYearId, entryDate, description: desc, source: 'invoice', status: 'confirmed', lines })
  db.update(documents).set({ journalEntryId: entryId, status: 'issued', updatedAt: new Date().toISOString() }).where(eq(documents.id, documentId)).run()

  return { entryId, grossTotal: yen(grossTotal), withholding: yen(withholding), receivable: yen(receivable) }
}

export interface CollectPaymentInput {
  documentId: number
  paymentDate: string
  /** 入金先（既定 普通預金）。 */
  depositAccountId?: number | null
}

export interface CollectPaymentResult {
  entryId: number
  amount: Yen
}

/** 請求書の入金消込（借)現金預金 / 貸)売掛金）。全額消込のみ（部分入金は本スライス外）。 */
export function collectPayment(db: DataDb, fiscalYearId: number, input: CollectPaymentInput): CollectPaymentResult {
  const doc = getDocument(db, input.documentId)
  if (doc.journalEntryId == null || doc.status !== 'issued') throw new Error('起票済み(issued)の請求書のみ入金消込できます')
  // 売掛金計上額＝総額−源泉（起票時の借方売掛金と一致）。total/withholdingTotal は nullable ゆえ 0 既定。
  const receivable = (doc.total ?? 0) - (doc.withholdingTotal ?? 0)
  if (receivable <= 0) throw new Error('消込対象の売掛金がありません')

  const arId = accountIdByName(db, AR)
  const depId = input.depositAccountId ?? accountIdByName(db, DEPOSIT)
  const cp = doc.counterpartyId ?? null
  // 起票時と同じ取引先別売掛金補助科目で消し込む（無ければ作成。通常は起票時に作成済み）。
  const arSubId = receivableSubAccountId(db, arId, cp)
  const desc = `入金消込 ${(doc.docNo ?? doc.subject ?? '').toString()}`.trim()
  const entryId = createManualEntry(db, {
    fiscalYearId,
    entryDate: input.paymentDate,
    description: desc,
    source: 'invoice',
    status: 'confirmed',
    lines: [
      { side: 'debit', accountId: depId, amount: receivable, counterpartyId: cp },
      { side: 'credit', accountId: arId, subAccountId: arSubId, amount: receivable, counterpartyId: cp },
    ],
  })
  db.update(documents).set({ status: 'collected', updatedAt: new Date().toISOString() }).where(eq(documents.id, input.documentId)).run()
  return { entryId, amount: yen(receivable) }
}
