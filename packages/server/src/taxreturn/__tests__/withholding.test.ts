import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, subAccounts, counterparties } from '../../db/data/schema.js'
import { postRewardSale, withholdingDetail } from '../withholding.js'
import { buildIncomeTaxReturn } from '../incomeTax.js'

let tmp: string
const USER = 'u_withholding'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-wh-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}
function subId(db: DataDb, accountName: string, subName: string): number {
  return db
    .select({ id: subAccounts.id })
    .from(subAccounts)
    .where(and(eq(subAccounts.accountId, accId(db, accountName)), eq(subAccounts.name, subName)))
    .all()[0].id
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

function addCounterparty(db: DataDb, name: string): number {
  return db.insert(counterparties).values({ name, isActive: true, createdAt: 'x', updatedAt: 'x' }).returning().all()[0].id
}

describe('源泉徴収された報酬売上の起票（postRewardSale）', () => {
  it('税込110,000・本体100,000 → 借)普通預金99,790 借)事業主貸(源泉)10,210 貸)売上110,000', () => {
    const { db, fyId } = setup()
    const cp = addCounterparty(db, '株式会社クライアント')
    const r = postRewardSale(db, fyId, { entryDate: '2026-06-01', counterpartyId: cp, gross: 110_000, withholdingBase: 100_000 })

    expect(r.withholding).toBe(10_210)
    expect(r.deposit).toBe(99_790)

    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, r.entryId)).all()
    expect(lines.find((l) => l.accountId === accId(db, '普通預金'))).toMatchObject({ side: 'debit', amount: 99_790 })
    expect(lines.find((l) => l.subAccountId === subId(db, '事業主貸', '源泉所得税'))).toMatchObject({ side: 'debit', amount: 10_210 })
    expect(lines.find((l) => l.accountId === accId(db, '売上高'))).toMatchObject({ side: 'credit', amount: 110_000, counterpartyId: cp })
    // confirmed 仕訳。
    expect(db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId)).all()[0].status).toBe('confirmed')
  })

  it('源泉計算の基礎が税込売上を超える入力は弾く（源泉控除の過大計上防止）', () => {
    const { db, fyId } = setup()
    // gross=100,000 / base=120,000 は deposit≥0 を通過してしまうが不整合なので拒否。
    expect(() => postRewardSale(db, fyId, { entryDate: '2026-06-01', gross: 100_000, withholdingBase: 120_000 })).toThrow(/以下である/)
    // base==gross（税込基礎）は許容。
    expect(() => postRewardSale(db, fyId, { entryDate: '2026-06-01', gross: 100_000, withholdingBase: 100_000 })).not.toThrow()
  })
})

describe('第二表 所得の内訳（withholdingDetail）', () => {
  it('支払者別に 収入金額・源泉徴収税額 を集計し、第一表の源泉合計と一致', () => {
    const { db, fyId } = setup()
    const a = addCounterparty(db, 'A社')
    const b = addCounterparty(db, 'B社')
    postRewardSale(db, fyId, { entryDate: '2026-03-01', counterpartyId: a, gross: 110_000, withholdingBase: 100_000 }) // 源泉10,210
    postRewardSale(db, fyId, { entryDate: '2026-09-01', counterpartyId: a, gross: 220_000, withholdingBase: 200_000 }) // 源泉20,420
    postRewardSale(db, fyId, { entryDate: '2026-06-01', counterpartyId: b, gross: 55_000, withholdingBase: 50_000 }) // 源泉5,105

    const detail = withholdingDetail(db, fyId)
    const byPayer = (name: string) => detail.find((d) => d.payerName === name)!
    expect(byPayer('A社')).toMatchObject({ revenue: 330_000, withholding: 30_630 })
    expect(byPayer('B社')).toMatchObject({ revenue: 55_000, withholding: 5_105 })

    // 第一表の源泉徴収税額（事業主貸/源泉所得税 集計）= 内訳合計。
    const itr = buildIncomeTaxReturn(db, fyId)
    expect(itr.withholding).toBe(35_735) // 30,630 + 5,105
    expect(itr.incomeDetail.reduce((s, d) => s + d.withholding, 0)).toBe(35_735)
  })

  it('源泉が無ければ空', () => {
    const { db, fyId } = setup()
    expect(withholdingDetail(db, fyId)).toEqual([])
  })
})
