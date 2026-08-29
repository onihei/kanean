import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalLines, accounts, taxCategories } from '../../db/data/schema.js'
import { resolveLineTax } from '../lineTax.js'
import { createManualEntry } from '../manualEntry.js'

let tmp: string
const USER = 'u_linetax'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-linetax-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}
function taxCode(db: DataDb, id: number | null): string | null {
  if (id == null) return null
  return db.select().from(taxCategories).where(eq(taxCategories.id, id)).all()[0]?.code ?? null
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

describe('resolveLineTax — 税区分自動付与と税額（税込経理・既定）', () => {
  it('売上高（既定=課売10%五種）: 税込110,000 → 内税10,000', () => {
    const { db } = setup()
    const r = resolveLineTax(db, { accountId: accId(db, '売上高'), amount: 110_000 })
    expect(taxCode(db, r.taxCategoryId)).toBe('SALE_10_C5')
    expect(r.taxAmount).toBe(10_000)
  })

  it('普通預金（既定=対象外）: 税額 null', () => {
    const { db } = setup()
    const r = resolveLineTax(db, { accountId: accId(db, '普通預金'), amount: 110_000 })
    expect(taxCode(db, r.taxCategoryId)).toBe('OUT')
    expect(r.taxAmount).toBeNull()
  })

  it('通信費（既定=課仕10%）: 税込11,000 → 内税1,000', () => {
    const { db } = setup()
    const r = resolveLineTax(db, { accountId: accId(db, '通信費'), amount: 11_000 })
    expect(taxCode(db, r.taxCategoryId)).toBe('PUR_10')
    expect(r.taxAmount).toBe(1_000)
  })

  it('明示指定は既定より優先', () => {
    const { db } = setup()
    const nontax = db.select().from(taxCategories).where(eq(taxCategories.code, 'NONTAX_SALE')).all()[0].id
    const r = resolveLineTax(db, { accountId: accId(db, '売上高'), taxCategoryId: nontax, amount: 110_000 })
    expect(taxCode(db, r.taxCategoryId)).toBe('NONTAX_SALE')
    expect(r.taxAmount).toBeNull() // 非課税は税額なし
  })
})

describe('createManualEntry — 明細に税区分・税額を自動付与', () => {
  it('貸)売上高110,000 の相手行に SALE_10_C5・内税10,000 が付く', () => {
    const { db, fyId } = setup()
    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-05-01',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 110_000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 110_000 },
      ],
    })
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, id)).all()
    const sales = lines.find((l) => l.accountId === accId(db, '売上高'))!
    expect(taxCode(db, sales.taxCategoryId)).toBe('SALE_10_C5')
    expect(sales.taxAmount).toBe(10_000)
    const cash = lines.find((l) => l.accountId === accId(db, '普通預金'))!
    expect(taxCode(db, cash.taxCategoryId)).toBe('OUT')
    expect(cash.taxAmount).toBeNull()
  })

  it('対象外の行に渡した明示 taxAmount は無効化される（矛盾明細の防止）', () => {
    const { db, fyId } = setup()
    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-05-01',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), taxAmount: 500, amount: 110_000 }, // 普通預金=対象外
        { side: 'credit', accountId: accId(db, '売上高'), amount: 110_000 },
      ],
    })
    const cash = db.select().from(journalLines).where(eq(journalLines.entryId, id)).all().find((l) => l.accountId === accId(db, '普通預金'))!
    expect(cash.taxAmount).toBeNull()
  })

  it('明示 taxAmount は尊重される', () => {
    const { db, fyId } = setup()
    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-05-01',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 110_000 },
        { side: 'credit', accountId: accId(db, '売上高'), taxAmount: 9_999, amount: 110_000 },
      ],
    })
    const sales = db.select().from(journalLines).where(eq(journalLines.entryId, id)).all().find((l) => l.accountId === accId(db, '売上高'))!
    expect(sales.taxAmount).toBe(9_999)
  })
})
