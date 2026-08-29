import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, businessSettings } from '../../db/data/schema.js'
import { buildBlueReturnSummary, setBlueDeductionETax } from '../blueReturn.js'

let tmp: string
const USER = 'u_aoiro'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-aoiro-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
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

/** 借)普通預金 / 貸)売上高 の confirmed 売上（控除前所得を作る）。 */
function addSale(db: DataDb, fyId: number, amount: number) {
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fyId, entryDate: '2026-06-01', description: '売上', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '普通預金'), amount }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '売上高'), amount }).run()
}

describe('青色申告特別控除㊹・所得金額㊺ 組成', () => {
  it('既定（business_settings 行なし）＝青色・複式・電子要件なし → 55万円', () => {
    const { db, fyId } = setup()
    addSale(db, fyId, 3_000_000) // 控除前所得 300万
    const r = buildBlueReturnSummary(db, fyId)
    expect(r.incomeBeforeDeduction).toBe(3_000_000)
    expect(r.filingType).toBe('blue')
    expect(r.qualifiesFor65).toBe(false)
    expect(r.deductionLimit).toBe(550_000)
    expect(r.deduction).toBe(550_000)
    expect(r.income).toBe(2_450_000)
  })

  it('setBlueDeductionETax(true) で65万円控除（行が無ければ作成）', () => {
    const { db, fyId } = setup()
    addSale(db, fyId, 3_000_000)
    setBlueDeductionETax(db, true)
    const r = buildBlueReturnSummary(db, fyId)
    expect(r.qualifiesFor65).toBe(true)
    expect(r.deduction).toBe(650_000)
    expect(r.income).toBe(2_350_000)
    // business_settings 行が1件だけ作られている（重複しない）。
    setBlueDeductionETax(db, false)
    expect(db.select().from(businessSettings).all()).toHaveLength(1)
    expect(buildBlueReturnSummary(db, fyId).deduction).toBe(550_000)
  })

  it('控除前所得が控除限度未満なら控除は所得まで（㊺=0）', () => {
    const { db, fyId } = setup()
    addSale(db, fyId, 300_000)
    const r = buildBlueReturnSummary(db, fyId)
    expect(r.deduction).toBe(300_000)
    expect(r.income).toBe(0)
  })

  it('白色設定 → 控除0', () => {
    const { db, fyId } = setup()
    addSale(db, fyId, 3_000_000)
    db.insert(businessSettings).values({ filingType: 'white', createdAt: 'x', updatedAt: 'x' }).run()
    const r = buildBlueReturnSummary(db, fyId)
    expect(r.filingType).toBe('white')
    expect(r.deduction).toBe(0)
    expect(r.income).toBe(3_000_000)
  })
})
