import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, businessSettings } from '../../db/data/schema.js'
import { PDFDocument } from 'pdf-lib'
import { renderIncomeTaxReturn } from '../incomeTaxPdf.js'

let tmp: string
const USER = 'u_incometaxpdf'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-incometaxpdf-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup() {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const now = '2026-01-01T00:00:00Z'
  db.insert(businessSettings).values({ businessName: '山田商店', ownerName: '山田太郎', createdAt: now, updatedAt: now }).run()
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
  const fy = db.select().from(fiscalYears).all()[0]
  const add = (lines: { account: string; side: 'debit' | 'credit'; amount: number }[]) => {
    const e = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now })
      .returning()
      .all()[0]
    lines.forEach((l, i) => db.insert(journalLines).values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), amount: l.amount }).run())
  }
  add([{ account: '普通預金', side: 'debit', amount: 5_000_000 }, { account: '売上高', side: 'credit', amount: 5_000_000 }])
  add([{ account: '水道光熱費', side: 'debit', amount: 200_000 }, { account: '普通預金', side: 'credit', amount: 200_000 }])
  return { db, fyId: fy.id }
}

describe('renderIncomeTaxReturn（確定申告書 第一表・第二表 PDF）', () => {
  it('有効なPDFバイト列（%PDF-・EOF・非空）を生成する', async () => {
    const { db, fyId } = setup()
    const bytes = await renderIncomeTaxReturn(db, fyId)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    expect(new TextDecoder().decode(bytes.slice(-6))).toContain('EOF')
  })

  it('再パース可能な2ページ（第一表・第二表）で日本語フォント埋込ぶんのサイズがある', async () => {
    const { db, fyId } = setup()
    const bytes = await renderIncomeTaxReturn(db, fyId)
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBe(2)
    expect(bytes.length).toBeGreaterThan(5000)
  })

  it('事業者設定・仕訳が無くても例外を投げない（最小データ）', async () => {
    const db = new DbRouter().bookDb('u_incometaxpdf_min')
    seedDataPlane(db)
    const now = '2026-01-01T00:00:00Z'
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    const bytes = await renderIncomeTaxReturn(db, fy.id)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })
})
