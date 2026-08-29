import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { fiscalYears, journalEntries, journalLines, accounts, subAccounts, documents as documentsTable } from '../../db/data/schema.js'
import { createDocument, getDocument, listDocuments, updateDocument, voidDocument, createReceiptFromInvoice, recomputeTotals, type DocumentInput } from '../documents.js'
import { issueInvoice, collectPayment } from '../invoicing.js'
import { createCounterparty } from '../../masters/counterparties.js'
import { deleteEntry } from '../../journal/entries.js'
import { trialBalance } from '../../reports/reports.js'

const USER = 'u_invoicing'
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-inv-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}
function setup(year = 2024): { db: DataDb; fyId: number } {
  const db = new DbRouter().bookDb(USER)
  const fy = db.insert(fiscalYears).values({ startDate: `${year}-01-01`, endDate: `${year}-12-31`, status: 'open', createdAt: 'x' }).returning().all()[0]
  return { db, fyId: fy.id }
}
function lineByAccount(db: DataDb, entryId: number, name: string) {
  return db.select().from(journalLines).where(eq(journalLines.entryId, entryId)).all().find((l) => l.accountId === accId(db, name))
}
function invoice(over: Partial<DocumentInput> = {}): DocumentInput {
  return {
    docType: 'invoice',
    docNo: 'INV-001',
    subject: 'コンサル料',
    issueDate: '2024-03-01',
    revenueRecognitionDate: '2024-03-01',
    lines: [{ description: 'コンサル', amount: 100_000, taxRate: 10 }],
    ...over,
  }
}

describe('recomputeTotals（税込経理・税率別・源泉）', () => {
  it('単一10%: 小計100,000 / 税10,000 / 総額110,000 / 源泉0', () => {
    expect(recomputeTotals([{ amount: 100_000, taxRate: 10 }])).toEqual({ subtotal: 100_000, taxTotal: 10_000, withholdingTotal: 0, total: 110_000 })
  })
  it('複数税率(10%+8%): 税=10,000+4,000、総額164,000', () => {
    expect(recomputeTotals([{ amount: 100_000, taxRate: 10 }, { amount: 50_000, taxRate: 8 }])).toEqual({ subtotal: 150_000, taxTotal: 14_000, withholdingTotal: 0, total: 164_000 })
  })
  it('源泉あり: 対象行の本体合計に rewardWithholding を1回適用（100,000→10,210）', () => {
    expect(recomputeTotals([{ amount: 100_000, taxRate: 10, withholding: true }]).withholdingTotal).toBe(10_210)
  })
})

describe('書類 CRUD', () => {
  it('createDocument は合計をサーバ再計算する（クライアント値は無視）', () => {
    const { db } = setup()
    const id = createDocument(db, invoice())
    const row = db.select().from(documentsTable).where(eq(documentsTable.id, id)).all()[0]
    expect(row).toMatchObject({ docType: 'invoice', status: 'draft', subtotal: 100_000, taxTotal: 10_000, total: 110_000, withholdingTotal: 0 })
    expect(getDocument(db, id).lines).toHaveLength(1)
  })

  it('updateDocument は draft のみ・明細全置換で再計算', () => {
    const { db } = setup()
    const id = createDocument(db, invoice())
    updateDocument(db, id, invoice({ lines: [{ amount: 200_000, taxRate: 10 }, { amount: 100_000, taxRate: 8 }] }))
    const v = getDocument(db, id)
    expect(v.lines).toHaveLength(2)
    expect(v.total).toBe(200_000 + 20_000 + 100_000 + 8_000)
  })

  it('void は draft のみ・一覧は既定で void を除外', () => {
    const { db } = setup()
    const id = createDocument(db, invoice())
    voidDocument(db, id)
    expect(db.select().from(documentsTable).where(eq(documentsTable.id, id)).all()[0].status).toBe('void')
    expect(listDocuments(db, {}).find((d) => d.id === id)).toBeUndefined()
  })

  it('起票済みは void できない／仕訳削除で draft に戻り再起票・void が可能になる', () => {
    const { db, fyId } = setup()
    const id = createDocument(db, invoice())
    const r = issueInvoice(db, fyId, id)
    expect(() => voidDocument(db, id)).toThrow(/下書き\(draft\)の書類のみ/)
    // 起票仕訳を削除 → documents は status=draft・journalEntryId=null に戻る（整合維持）。
    deleteEntry(db, r.entryId)
    const back = getDocument(db, id)
    expect(back.status).toBe('draft')
    expect(back.journalEntryId).toBeNull()
    // draft に戻ったので再起票も void も可能（ここでは void を確認）。
    voidDocument(db, id)
    expect(getDocument(db, id).status).toBe('void')
  })
})

describe('請求書の起票（売掛金複合仕訳・税込経理）', () => {
  it('源泉なし: 借)売掛金110,000 / 貸)売上110,000（売上行に税額10,000・税区分）', () => {
    const { db, fyId } = setup()
    const id = createDocument(db, invoice())
    const r = issueInvoice(db, fyId, id)
    expect(r).toMatchObject({ grossTotal: 110_000, withholding: 0, receivable: 110_000 })

    const entry = db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId)).all()[0]
    expect(entry.source).toBe('invoice')
    expect(entry.status).toBe('confirmed')
    expect(entry.entryDate).toBe('2024-03-01')
    expect(lineByAccount(db, r.entryId, '売掛金')).toMatchObject({ side: 'debit', amount: 110_000 })
    const sale = lineByAccount(db, r.entryId, '売上高')!
    expect(sale).toMatchObject({ side: 'credit', amount: 110_000, taxAmount: 10_000 })
    expect(sale.taxCategoryId).not.toBeNull()

    const doc = getDocument(db, id)
    expect(doc.journalEntryId).toBe(r.entryId)
    expect(doc.status).toBe('issued')
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('源泉あり: 借)売掛金99,790 借)事業主貸10,210 / 貸)売上110,000', () => {
    const { db, fyId } = setup()
    const id = createDocument(db, invoice({ lines: [{ amount: 100_000, taxRate: 10, withholding: true }] }))
    const r = issueInvoice(db, fyId, id)
    expect(r).toMatchObject({ grossTotal: 110_000, withholding: 10_210, receivable: 99_790 })
    expect(lineByAccount(db, r.entryId, '売掛金')).toMatchObject({ side: 'debit', amount: 99_790 })
    expect(lineByAccount(db, r.entryId, '事業主貸')).toMatchObject({ side: 'debit', amount: 10_210 })
    expect(lineByAccount(db, r.entryId, '売上高')).toMatchObject({ side: 'credit', amount: 110_000 })
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('複数税率: 売上行を税率別に分割（110,000@10% + 54,000@8%）・売掛金は合算164,000', () => {
    const { db, fyId } = setup()
    const id = createDocument(db, invoice({ lines: [{ amount: 100_000, taxRate: 10 }, { amount: 50_000, taxRate: 8 }] }))
    const r = issueInvoice(db, fyId, id)
    expect(r.grossTotal).toBe(164_000)
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, r.entryId)).all()
    const saleLines = lines.filter((l) => l.accountId === accId(db, '売上高'))
    expect(saleLines).toHaveLength(2)
    expect(saleLines.map((l) => l.amount).sort((a, b) => a - b)).toEqual([54_000, 110_000])
    expect(lineByAccount(db, r.entryId, '売掛金')!.amount).toBe(164_000)
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('起票ガード: 請求書以外・二重起票・税率不正を弾く', () => {
    const { db, fyId } = setup()
    const quoteId = createDocument(db, invoice({ docType: 'quote' }))
    expect(() => issueInvoice(db, fyId, quoteId)).toThrow(/請求書\(invoice\)のみ/)
    const id = createDocument(db, invoice())
    issueInvoice(db, fyId, id)
    expect(() => issueInvoice(db, fyId, id)).toThrow(/既に起票済み/)
    // taxRate 5 は createDocument の検証（0/8/10 のみ）で弾かれる。
    expect(() => createDocument(db, invoice({ lines: [{ amount: 1000, taxRate: 5 }] }))).toThrow(/税率/)
  })
})

describe('入金消込', () => {
  it('源泉あり請求の消込: 借)普通預金99,790 / 貸)売掛金99,790・status=collected・二重消込拒否', () => {
    const { db, fyId } = setup()
    const id = createDocument(db, invoice({ lines: [{ amount: 100_000, taxRate: 10, withholding: true }] }))
    issueInvoice(db, fyId, id)
    const r = collectPayment(db, fyId, { documentId: id, paymentDate: '2024-04-30' })
    expect(r.amount).toBe(99_790)
    expect(lineByAccount(db, r.entryId, '普通預金')).toMatchObject({ side: 'debit', amount: 99_790 })
    expect(lineByAccount(db, r.entryId, '売掛金')).toMatchObject({ side: 'credit', amount: 99_790 })
    expect(getDocument(db, id).status).toBe('collected')
    expect(() => collectPayment(db, fyId, { documentId: id, paymentDate: '2024-05-01' })).toThrow(/起票済み\(issued\)/)
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('未起票の請求は消込できない', () => {
    const { db, fyId } = setup()
    const id = createDocument(db, invoice())
    expect(() => collectPayment(db, fyId, { documentId: id, paymentDate: '2024-04-30' })).toThrow(/起票済み\(issued\)/)
  })
})

describe('取引先別の売掛金補助科目（起票時に遅延作成）', () => {
  const arSubs = (db: DataDb) => db.select().from(subAccounts).where(eq(subAccounts.accountId, accId(db, '売掛金'))).all()

  it('起票時に取引先名の売掛金補助科目を作成し、売掛金行に紐づける', () => {
    const { db, fyId } = setup()
    const cpId = createCounterparty(db, { name: 'トイウェア株式会社' })
    const id = createDocument(db, invoice({ counterpartyId: cpId }))
    const r = issueInvoice(db, fyId, id)
    const subs = arSubs(db)
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ name: 'トイウェア株式会社', counterpartyId: cpId })
    expect(lineByAccount(db, r.entryId, '売掛金')).toMatchObject({ side: 'debit', subAccountId: subs[0].id })
  })

  it('入金消込は起票と同じ補助科目で消し込み、補助科目は重複作成しない', () => {
    const { db, fyId } = setup()
    const cpId = createCounterparty(db, { name: 'トイウェア株式会社' })
    const id = createDocument(db, invoice({ counterpartyId: cpId }))
    issueInvoice(db, fyId, id)
    const subId = arSubs(db)[0].id
    const r = collectPayment(db, fyId, { documentId: id, paymentDate: '2024-04-30' })
    expect(arSubs(db)).toHaveLength(1) // 重複作成なし
    expect(lineByAccount(db, r.entryId, '売掛金')).toMatchObject({ side: 'credit', subAccountId: subId })
  })

  it('取引先未指定の請求は補助科目を作らず売掛金へ直課', () => {
    const { db, fyId } = setup()
    const id = createDocument(db, invoice())
    const r = issueInvoice(db, fyId, id)
    expect(arSubs(db)).toHaveLength(0)
    expect(lineByAccount(db, r.entryId, '売掛金')).toMatchObject({ side: 'debit', subAccountId: null })
  })
})

describe('領収書の複製', () => {
  it('請求書から領収書を複製（convertedFromId・journalEntryId 参照・新規仕訳なし）', () => {
    const { db, fyId } = setup()
    const id = createDocument(db, invoice())
    const r = issueInvoice(db, fyId, id)
    const before = db.select().from(journalEntries).all().length
    const receiptId = createReceiptFromInvoice(db, id)
    const receipt = getDocument(db, receiptId)
    expect(receipt.docType).toBe('receipt')
    expect(receipt.convertedFromId).toBe(id)
    expect(receipt.journalEntryId).toBe(r.entryId)
    expect(receipt.lines).toHaveLength(1)
    expect(db.select().from(journalEntries).all().length).toBe(before) // 新規仕訳は増えない
  })
})
