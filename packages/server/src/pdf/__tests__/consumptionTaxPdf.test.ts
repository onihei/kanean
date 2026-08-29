import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, businessSettings } from '../../db/data/schema.js'
import { renderConsumptionTaxReturn } from '../consumptionTaxPdf.js'

let tmp: string
const USER = 'u_consumptionpdf'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-consumptionpdf-'))
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
  db.insert(businessSettings).values({ businessName: '山田商店', ownerName: '山田太郎', taxMethod: 'simplified', taxBusinessCategory: '第5種', createdAt: now, updatedAt: now }).run()
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
  const fy = db.select().from(fiscalYears).all()[0]
  // 課税売上（税込）。tax_category は seed の課税10%を使う前提で売上計上。
  const e = db.insert(journalEntries).values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }).returning().all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '普通預金'), amount: 11_000_000 }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '売上高'), amount: 11_000_000 }).run()
  return { db, fyId: fy.id }
}

describe('renderConsumptionTaxReturn（消費税申告書 簡易課税 PDF）', () => {
  it('有効なPDFバイト列（%PDF-・EOF・非空）を生成する', async () => {
    const { db, fyId } = setup()
    const bytes = await renderConsumptionTaxReturn(db, fyId)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    expect(new TextDecoder().decode(bytes.slice(-6))).toContain('EOF')
  })

  it('再パース可能な1ページPDFで日本語フォント埋込ぶんのサイズがある', async () => {
    const { db, fyId } = setup()
    const bytes = await renderConsumptionTaxReturn(db, fyId)
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBe(1)
    expect(bytes.length).toBeGreaterThan(5000)
  })

  it('課税売上が無くても例外を投げない（最小データ）', async () => {
    const db = new DbRouter().bookDb('u_consumptionpdf_min')
    seedDataPlane(db)
    const now = '2026-01-01T00:00:00Z'
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    const bytes = await renderConsumptionTaxReturn(db, fy.id)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })
})
