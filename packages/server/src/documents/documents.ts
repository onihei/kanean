import type { DocumentInput, DocumentLineInput, DocumentLineView, DocumentView } from '@kanean/shared'
export type { DocumentInput, DocumentLineInput, DocumentView }

/** 書類詳細（lines 必須）。一覧応答は lines を持たない（shared DocumentView では optional）。 */
export type DocumentDetail = DocumentView & { lines: DocumentLineView[] }
import { and, asc, eq, ne } from 'drizzle-orm'
import { yen } from '@kanean/shared'
import { exclusiveTax, rewardWithholding } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { documents, documentLines } from '../db/data/schema.js'

/**
 * 書類（請求書・見積・納品・領収）の CRUD（F-INV・data-model §2.13）。
 * 税込経理前提。明細（document_lines）から合計（小計・消費税・源泉・総額）を**サーバ側で再計算**し、
 * クライアント送信値は信用しない。売掛金の複合仕訳起票・入金消込は invoicing.ts。
 *
 * 本スライス（slice9）の対応 docType: invoice（起票トリガ）/ receipt（領収＝監査証跡クローン）。
 * quote/delivery も CRUD で作成可だが仕訳は生成しない準備書類。
 * ⚠️ legalRisk:medium/high — 売上計上時期・源泉・消費税区分は税理士サインオフ対象。
 */

export type DocumentRow = typeof documents.$inferSelect
export type DocumentLineRow = typeof documentLines.$inferSelect

export interface DocumentTotals {
  subtotal: number
  taxTotal: number
  withholdingTotal: number
  total: number
}

const DOC_TYPES = new Set(['quote', 'delivery', 'invoice', 'receipt'])
const t = (v?: string | null): string | null => {
  const s = (v ?? '').trim()
  return s === '' ? null : s
}

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} は安全な整数で指定してください（got ${value}）`)
}

/** 明細を検証する（金額は0以上の整数、税率は許容値）。 */
function validateLines(lines: DocumentLineInput[]): void {
  if (!Array.isArray(lines) || lines.length === 0) throw new Error('明細が1件以上必要です')
  for (const [i, l] of lines.entries()) {
    assertInteger(l.amount, `明細${i + 1} の金額`)
    if (l.amount < 0) throw new Error(`明細${i + 1}: 金額は0以上で指定してください`)
    if (l.taxRate != null && ![0, 8, 10].includes(l.taxRate)) {
      throw new Error(`明細${i + 1}: 税率は 0 / 8 / 10 で指定してください`)
    }
  }
}

/** 明細から合計を再計算する（税込経理・税率別に税を加算、源泉は対象行の本体合計に1回適用）。 */
export function recomputeTotals(lines: DocumentLineInput[]): DocumentTotals {
  let subtotal = 0
  let whBase = 0
  const netByRate = new Map<number, number>()
  for (const l of lines) {
    subtotal += l.amount
    const rate = l.taxRate ?? 0
    netByRate.set(rate, (netByRate.get(rate) ?? 0) + l.amount)
    if (l.withholding) whBase += l.amount
  }
  let taxTotal = 0
  for (const [rate, net] of netByRate) {
    if (rate > 0) taxTotal += exclusiveTax(yen(net), rate)
  }
  // 源泉は対象行の本体合計に対し1回（段階税率の二重適用を避ける）。
  const withholdingTotal = whBase > 0 ? rewardWithholding(yen(whBase)) : 0
  return { subtotal, taxTotal, withholdingTotal, total: subtotal + taxTotal }
}

function buildHeader(input: DocumentInput, totals: DocumentTotals) {
  const docType = (input.docType ?? '').trim()
  if (!DOC_TYPES.has(docType)) throw new Error(`docType は ${[...DOC_TYPES].join('/')} のいずれかで指定してください`)
  return {
    docType,
    docNo: t(input.docNo),
    counterpartyId: input.counterpartyId ?? null,
    honorific: t(input.honorific),
    subject: t(input.subject),
    issueDate: t(input.issueDate),
    dueDate: t(input.dueDate),
    revenueRecognitionDate: t(input.revenueRecognitionDate),
    paymentInfo: t(input.paymentInfo),
    remarks: t(input.remarks),
    memo: t(input.memo),
    subtotal: totals.subtotal,
    taxTotal: totals.taxTotal,
    withholdingTotal: totals.withholdingTotal,
    total: totals.total,
  }
}

function insertLines(db: DataDb, documentId: number, lines: DocumentLineInput[]): void {
  db.insert(documentLines)
    .values(
      lines.map((l, i) => ({
        documentId,
        lineNo: i + 1,
        itemId: l.itemId ?? null,
        description: t(l.description),
        deliveryDate: t(l.deliveryDate),
        unitPrice: l.unitPrice ?? null,
        quantity: l.quantity ?? null,
        amount: l.amount,
        taxRate: l.taxRate ?? null,
        withholding: l.withholding ?? false,
        deliveryDocNo: t(l.deliveryDocNo),
      })),
    )
    .run()
}


/** 書類1件（ヘッダ＋明細を同梱）。 */
export function getDocument(db: DataDb, id: number): DocumentDetail {
  const doc = db.select().from(documents).where(eq(documents.id, id)).all()[0]
  if (!doc) throw new Error(`書類 ${id} が見つかりません`)
  const lines = db.select().from(documentLines).where(eq(documentLines.documentId, id)).orderBy(asc(documentLines.lineNo)).all()
  return { ...doc, lines }
}

export interface ListDocumentsFilter {
  docType?: string
  status?: string
  counterpartyId?: number
  includeVoid?: boolean
}

/** 書類一覧（ヘッダのみ・発行日降順）。既定で void を除外。 */
export function listDocuments(db: DataDb, filter: ListDocumentsFilter = {}): DocumentRow[] {
  const conds = []
  if (filter.docType) conds.push(eq(documents.docType, filter.docType))
  if (filter.status) conds.push(eq(documents.status, filter.status))
  if (filter.counterpartyId != null) conds.push(eq(documents.counterpartyId, filter.counterpartyId))
  if (!filter.includeVoid && !filter.status) conds.push(ne(documents.status, 'void'))
  const where = conds.length === 0 ? undefined : conds.length === 1 ? conds[0] : and(...conds)
  const q = db.select().from(documents)
  return (where ? q.where(where) : q).orderBy(asc(documents.issueDate), asc(documents.id)).all()
}

/** 書類を作成する（status='draft'・合計はサーバ再計算）。 */
export function createDocument(db: DataDb, input: DocumentInput): number {
  validateLines(input.lines)
  const totals = recomputeTotals(input.lines)
  const header = buildHeader(input, totals)
  const now = new Date().toISOString()
  return db.transaction((tx) => {
    const doc = tx.insert(documents).values({ ...header, status: 'draft', createdAt: now, updatedAt: now }).returning().all()[0]
    insertLines(tx as unknown as DataDb, doc.id, input.lines)
    return doc.id
  })
}

/** 書類を更新する（draft のみ。明細は全置換し合計を再計算）。 */
export function updateDocument(db: DataDb, id: number, input: DocumentInput): void {
  const existing = db.select().from(documents).where(eq(documents.id, id)).all()[0]
  if (!existing) throw new Error(`書類 ${id} が見つかりません`)
  if (existing.status !== 'draft') throw new Error('起票・確定済みの書類は編集できません（draft のみ編集可）')
  validateLines(input.lines)
  const totals = recomputeTotals(input.lines)
  const header = buildHeader(input, totals)
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.update(documents).set({ ...header, updatedAt: now }).where(eq(documents.id, id)).run()
    tx.delete(documentLines).where(eq(documentLines.documentId, id)).run()
    insertLines(tx as unknown as DataDb, id, input.lines)
  })
}

/**
 * 論理削除（status='void'）。draft のみ可。起票済み(issued)/入金済(collected)は仕訳を先に削除して
 * draft へ戻す必要がある（deleteEntry が journalEntryId を null 化＋status='draft' に戻す）。
 * status を条件にすることで「仕訳削除で孤立した issued（journalEntryId=null）」も誤って void できない。
 */
export function voidDocument(db: DataDb, id: number): void {
  const doc = db.select().from(documents).where(eq(documents.id, id)).all()[0]
  if (!doc) throw new Error(`書類 ${id} が見つかりません`)
  if (doc.status !== 'draft') throw new Error('下書き(draft)の書類のみ無効化できます（起票済みは先に仕訳を削除してください）')
  db.update(documents).set({ status: 'void', updatedAt: new Date().toISOString() }).where(eq(documents.id, id)).run()
}

/** 請求書から領収書を複製する（新規仕訳なし・元 invoice の journalEntryId を参照）。 */
export function createReceiptFromInvoice(db: DataDb, invoiceId: number): number {
  const inv = getDocument(db, invoiceId)
  if (inv.docType !== 'invoice') throw new Error('領収書は請求書(invoice)からのみ作成できます')
  const now = new Date().toISOString()
  return db.transaction((tx) => {
    const receipt = tx
      .insert(documents)
      .values({
        docType: 'receipt',
        docNo: inv.docNo,
        counterpartyId: inv.counterpartyId,
        honorific: inv.honorific,
        subject: inv.subject,
        issueDate: now.slice(0, 10),
        dueDate: inv.dueDate,
        revenueRecognitionDate: inv.revenueRecognitionDate,
        paymentInfo: inv.paymentInfo,
        remarks: inv.remarks,
        memo: inv.memo,
        subtotal: inv.subtotal,
        taxTotal: inv.taxTotal,
        withholdingTotal: inv.withholdingTotal,
        total: inv.total,
        status: 'issued',
        convertedFromId: inv.id,
        journalEntryId: inv.journalEntryId, // 元invoiceの仕訳を参照（新規起票しない）。
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0]
    insertLines(
      tx as unknown as DataDb,
      receipt.id,
      inv.lines.map((l) => ({
        itemId: l.itemId,
        description: l.description,
        deliveryDate: l.deliveryDate,
        unitPrice: l.unitPrice,
        quantity: l.quantity,
        amount: l.amount ?? 0,
        taxRate: l.taxRate,
        withholding: l.withholding,
        deliveryDocNo: l.deliveryDocNo,
      })),
    )
    return receipt.id
  })
}
