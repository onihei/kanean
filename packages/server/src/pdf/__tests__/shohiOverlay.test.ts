import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, businessSettings, taxCategories } from '../../db/data/schema.js'
import { renderShohiOverlay } from '../shohiOverlay.js'

let tmp: string
const USER = 'u_shohi_overlay'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-shohi-'))
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
  const sale10 = db.select().from(taxCategories).where(eq(taxCategories.code, 'SALE_10_C5')).all()[0].id
  const e = db.insert(journalEntries).values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }).returning().all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '普通預金'), amount: 11_000_000 }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '売上高'), amount: 11_000_000, taxCategoryId: sale10, taxAmount: 1_000_000 }).run()
  return { db, fyId: fy.id }
}

describe('renderShohiOverlay（消費税申告書 簡易課税 官製様式オーバーレイ）', () => {
  it('テンプレ1ページを保ち、有効なPDFを生成する', async () => {
    const { db, fyId } = setup()
    const bytes = await renderShohiOverlay(db, fyId)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBe(1)
    expect(bytes.length).toBeGreaterThan(10_000)
  })

  it('課税売上が無くても例外を投げない（白紙オーバーレイ）', async () => {
    const db = new DbRouter().bookDb('u_shohi_empty')
    seedDataPlane(db)
    const now = '2026-01-01T00:00:00Z'
    db.insert(businessSettings).values({ businessName: 'x', ownerName: 'y', taxMethod: 'simplified', taxBusinessCategory: '第5種', createdAt: now, updatedAt: now }).run()
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    const bytes = await renderShohiOverlay(db, fy.id)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })
})
