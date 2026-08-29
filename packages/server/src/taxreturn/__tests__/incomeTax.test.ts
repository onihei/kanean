import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, subAccounts } from '../../db/data/schema.js'
import { buildIncomeTaxReturn, upsertTaxReturnInputs } from '../incomeTax.js'

let tmp: string
const USER = 'u_incometax'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-incometax-'))
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

function addEntry(db: DataDb, fyId: number, lines: { side: 'debit' | 'credit'; account: string; sub?: string; amount: number }[]) {
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fyId, entryDate: '2026-06-01', description: 't', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  let n = 1
  for (const l of lines) {
    db.insert(journalLines)
      .values({ entryId: e.id, lineNo: n++, side: l.side, accountId: accId(db, l.account), subAccountId: l.sub ? subId(db, l.account, l.sub) : null, amount: l.amount })
      .run()
  }
}

describe('確定申告書 第一表・第二表（所得税）組成', () => {
  it('ゴールデン: 売上500万・経費0 → 事業所得445万（55万控除）→ 申告納税額 374,100', () => {
    const { db, fyId } = setup()
    addEntry(db, fyId, [
      { side: 'debit', account: '普通預金', amount: 5_000_000 },
      { side: 'credit', account: '売上高', amount: 5_000_000 },
    ])

    const r = buildIncomeTaxReturn(db, fyId)
    expect(r.businessRevenue).toBe(5_000_000)
    expect(r.businessIncome).toBe(4_450_000) // 500万 − 青色控除55万
    expect(r.totalDeductions).toBe(480_000) // 基礎控除のみ
    expect(r.taxableIncome).toBe(3_970_000) // floor1000(4,450,000 − 480,000)
    expect(r.baseTax).toBe(366_500) // 3,970,000×0.20 − 427,500
    expect(r.surtax).toBe(7_696) // floor(366,500 × 0.021)
    expect(r.taxWithSurtax).toBe(374_196)
    expect(r.withholding).toBe(0)
    expect(r.payable).toBe(374_100) // 百円未満切捨て
    expect(r.refund).toBe(0)
  })

  it('所得控除の入力が課税所得に反映される', () => {
    const { db, fyId } = setup()
    addEntry(db, fyId, [
      { side: 'debit', account: '普通預金', amount: 5_000_000 },
      { side: 'credit', account: '売上高', amount: 5_000_000 },
    ])
    upsertTaxReturnInputs(db, fyId, { socialInsurance: 600_000 }) // 基礎48万 + 社保60万 = 108万

    const r = buildIncomeTaxReturn(db, fyId)
    expect(r.totalDeductions).toBe(1_080_000)
    expect(r.taxableIncome).toBe(3_370_000) // floor1000(4,450,000 − 1,080,000)
    expect(r.baseTax).toBe(246_500) // 3,370,000×0.20 − 427,500
    expect(r.payable).toBe(251_600) // floor100(246,500 + floor(246,500×0.021)=5,176 = 251,676)
  })

  it('源泉徴収税額を 事業主貸/源泉所得税 から自動集計し申告納税額から控除', () => {
    const { db, fyId } = setup()
    addEntry(db, fyId, [
      { side: 'debit', account: '普通預金', amount: 5_000_000 },
      { side: 'credit', account: '売上高', amount: 5_000_000 },
    ])
    // 源泉徴収 50,000（借)事業主貸/源泉所得税 50,000 / 貸)普通預金 50,000）。
    addEntry(db, fyId, [
      { side: 'debit', account: '事業主貸', sub: '源泉所得税', amount: 50_000 },
      { side: 'credit', account: '普通預金', amount: 50_000 },
    ])

    const r = buildIncomeTaxReturn(db, fyId)
    expect(r.withholding).toBe(50_000)
    // payableRaw = 374,196 − 50,000 = 324,196 → floor100 = 324,100
    expect(r.payable).toBe(324_100)
  })

  it('源泉徴収が税額を上回れば還付（payable=0, refund>0）', () => {
    const { db, fyId } = setup()
    addEntry(db, fyId, [
      { side: 'debit', account: '普通預金', amount: 5_000_000 },
      { side: 'credit', account: '売上高', amount: 5_000_000 },
    ])
    addEntry(db, fyId, [
      { side: 'debit', account: '事業主貸', sub: '源泉所得税', amount: 500_000 },
      { side: 'credit', account: '普通預金', amount: 500_000 },
    ])

    const r = buildIncomeTaxReturn(db, fyId)
    expect(r.withholding).toBe(500_000)
    expect(r.payable).toBe(0)
    expect(r.refund).toBe(125_804) // 500,000 − 374,196
  })

  it('upsertTaxReturnInputs は負値を弾く・部分更新できる', () => {
    const { db, fyId } = setup()
    upsertTaxReturnInputs(db, fyId, { socialInsurance: 300_000 })
    expect(() => upsertTaxReturnInputs(db, fyId, { medical: -1 })).toThrow(/医療費|medical|0以上/)
    // 部分更新: medical を弾いた後も socialInsurance は保持。
    upsertTaxReturnInputs(db, fyId, { lifeInsurance: 40_000 })
    addEntry(db, fyId, [
      { side: 'debit', account: '普通預金', amount: 5_000_000 },
      { side: 'credit', account: '売上高', amount: 5_000_000 },
    ])
    const r = buildIncomeTaxReturn(db, fyId)
    expect(r.inputs.socialInsurance).toBe(300_000)
    expect(r.inputs.lifeInsurance).toBe(40_000)
    expect(r.totalDeductions).toBe(820_000) // 基礎48万 + 社保30万 + 生保4万
  })
})
