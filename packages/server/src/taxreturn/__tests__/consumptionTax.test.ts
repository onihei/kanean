import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, taxCategories, businessSettings } from '../../db/data/schema.js'
import { buildConsumptionTaxReturn } from '../consumptionTax.js'

let tmp: string
const USER = 'u_shouhi'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-shouhi-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}
function taxCode(db: DataDb, code: string): number {
  return db.select().from(taxCategories).where(eq(taxCategories.code, code)).all()[0].id
}

function setup(): { db: DataDb; fyId: number } {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const fy = db
    .insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .returning()
    .all()[0]
  return { db, fyId: fy.id }
}

/** 借)普通預金 / 貸)売上高（売上行に税区分＋税額）の confirmed 売上仕訳。 */
function addSale(db: DataDb, fyId: number, gross: number, code: string, tax: number) {
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fyId, entryDate: '2026-06-01', description: '売上', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '普通預金'), amount: gross }).run()
  db.insert(journalLines)
    .values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '売上高'), amount: gross, taxCategoryId: taxCode(db, code), taxAmount: tax })
    .run()
}

describe('消費税申告書（簡易課税）組成', () => {
  it('ゴールデン: 税抜1000万@10%（第5種）→ 国390k/地方110k/合計500k（Exit基準2）', () => {
    const { db, fyId } = setup()
    // 税込 11,000,000・内税 1,000,000 → 税抜課税標準額 10,000,000。
    addSale(db, fyId, 11_000_000, 'SALE_10_C5', 1_000_000)

    const r = buildConsumptionTaxReturn(db, fyId)
    expect(r.businessCategory).toBe(5)
    expect(r.deemedRate).toBe(0.5)
    expect(r.baseRows).toEqual([{ rate: 10, taxBase: 10_000_000, salesTaxNational: 780_000 }])
    expect(r.taxBaseTotal).toBe(10_000_000)
    expect(r.salesTaxNational).toBe(780_000)
    expect(r.deemedDeduction).toBe(390_000)
    expect(r.national).toBe(390_000)
    expect(r.local).toBe(110_000)
    expect(r.payable).toBe(500_000)
    expect(r.midPaid).toBe(0)
    expect(r.applicable).toBe(true)
  })

  it('課税標準額は千円未満切捨て', () => {
    const { db, fyId } = setup()
    // 税抜 = 1,100,999 − 100,000 = 1,000,999 → 千円未満切捨て → 1,000,000。
    addSale(db, fyId, 1_100_999, 'SALE_10_C5', 100_000)
    const r = buildConsumptionTaxReturn(db, fyId)
    expect(r.baseRows[0].taxBase).toBe(1_000_000)
    expect(r.salesTaxNational).toBe(78_000) // floor(1,000,000 × 0.078)
  })

  it('事業区分は business_settings から解決（第3種＝みなし70%）', () => {
    const { db, fyId } = setup()
    db.insert(businessSettings)
      .values({ taxBusinessCategory: '第3種', createdAt: 'x', updatedAt: 'x' })
      .run()
    addSale(db, fyId, 11_000_000, 'SALE_10_C5', 1_000_000)

    const r = buildConsumptionTaxReturn(db, fyId)
    expect(r.businessCategory).toBe(3)
    expect(r.deemedRate).toBe(0.7)
    expect(r.deemedDeduction).toBe(546_000) // floor(780,000 × 0.7)
    expect(r.national).toBe(234_000) // floor100(780,000 − 546,000)
    expect(r.local).toBe(66_000) // floor100(floor(234,000 × 22/78))
    expect(r.payable).toBe(300_000)
  })

  it('10%・8%混在を税率別に集計', () => {
    const { db, fyId } = setup()
    addSale(db, fyId, 11_000_000, 'SALE_10_C5', 1_000_000) // 税抜1000万
    addSale(db, fyId, 1_080_000, 'SALE_8_C5', 80_000) // 税抜100万
    const r = buildConsumptionTaxReturn(db, fyId)
    const r10 = r.baseRows.find((b) => b.rate === 10)!
    const r8 = r.baseRows.find((b) => b.rate === 8)!
    expect(r10.taxBase).toBe(10_000_000)
    expect(r8.taxBase).toBe(1_000_000)
    expect(r10.salesTaxNational).toBe(780_000) // floor(1000万 × 0.078)
    expect(r8.salesTaxNational).toBe(62_400) // floor(100万 × 0.0624)
    expect(r.salesTaxNational).toBe(842_400)
  })

  it('課税売上が無ければ空・納付0', () => {
    const { db, fyId } = setup()
    const r = buildConsumptionTaxReturn(db, fyId)
    expect(r.baseRows).toEqual([])
    expect(r.taxBaseTotal).toBe(0)
    expect(r.payable).toBe(0)
  })
})
