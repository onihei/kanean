import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq, sql } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, subAccounts } from '../../db/data/schema.js'
import { listProrationSettings, upsertProrationSetting, deleteProrationSetting, postProration } from '../proration.js'
import { profitAndLoss, trialBalance } from '../../reports/reports.js'

let tmp: string
const USER = 'u_prorate'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-prorate-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): { db: DataDb; fyId: number } {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const fy = db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).returning().all()[0]
  return { db, fyId: fy.id }
}

/** 借)経費科目（任意で補助）/ 貸)普通預金 の confirmed 仕訳を1本。 */
function addExpense(db: DataDb, fyId: number, expenseAccount: string, amount: number, subAccountId?: number) {
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fyId, entryDate: '2026-06-01', description: '経費', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, expenseAccount), subAccountId, amount }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '普通預金'), amount }).run()
}

function addSubAccount(db: DataDb, accountName: string, name: string): number {
  return db
    .insert(subAccounts)
    .values({ accountId: accId(db, accountName), name, createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0].id
}

describe('家事按分（設定 + 期末一括起票）', () => {
  it('事業60%: 経費10万 → 家事分4万を 借)事業主貸/貸)経費 に振替', () => {
    const { db, fyId } = setup()
    addExpense(db, fyId, '水道光熱費', 100000)
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '水道光熱費'), businessRatio: 60 })

    const r = postProration(db, fyId)
    expect(r).toMatchObject({ posted: 1, totalHousehold: 40000 })

    const entry = db.select().from(journalEntries).where(eq(journalEntries.source, 'proration')).all()[0]
    expect(entry.status).toBe('confirmed')
    expect(entry.entryDate).toBe('2026-12-31')
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).all()
    expect(lines.find((l) => l.accountId === accId(db, '事業主貸'))).toMatchObject({ side: 'debit', amount: 40000 })
    expect(lines.find((l) => l.accountId === accId(db, '水道光熱費'))).toMatchObject({ side: 'credit', amount: 40000 })

    // P/L 経費は事業分6万に減る。試算表は一致。
    expect(profitAndLoss(db, fyId).expenses.rows.find((x) => x.accountName === '水道光熱費')!.balance).toBe(60000)
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('家事分は円未満切捨て: 99,999 × 40% = 39,999.6 → 39,999', () => {
    const { db, fyId } = setup()
    addExpense(db, fyId, '通信費', 99999)
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '通信費'), businessRatio: 60 })
    expect(postProration(db, fyId).totalHousehold).toBe(39999)
  })

  it('再実行で洗い替え: gross は再計算され複利化しない', () => {
    const { db, fyId } = setup()
    addExpense(db, fyId, '水道光熱費', 100000)
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '水道光熱費'), businessRatio: 60 })
    postProration(db, fyId)
    const second = postProration(db, fyId)
    expect(second.totalHousehold).toBe(40000) // 60,000×40%=24,000 にならない
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'proration')).all()).toHaveLength(1)
  })

  it('事業80%: 桁落ちで1円不足しない（50,000×20%=10,000）', () => {
    const { db, fyId } = setup()
    addExpense(db, fyId, '通信費', 50000)
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '通信費'), businessRatio: 80 })
    expect(postProration(db, fyId).totalHousehold).toBe(10000) // 1-0.8=0.199… の桁落ちなら 9,999
  })

  it('upsert: 同一年度・科目は更新（重複作成しない）', () => {
    const { db, fyId } = setup()
    const aid = accId(db, '水道光熱費')
    const id1 = upsertProrationSetting(db, { fiscalYearId: fyId, accountId: aid, businessRatio: 60 })
    const id2 = upsertProrationSetting(db, { fiscalYearId: fyId, accountId: aid, businessRatio: 50 })
    expect(id2).toBe(id1)
    const list = listProrationSettings(db, fyId)
    expect(list).toHaveLength(1)
    expect(list[0].businessRatio).toBe(50)
  })

  it('事業100%は家事分0で起票なし', () => {
    const { db, fyId } = setup()
    addExpense(db, fyId, '水道光熱費', 100000)
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '水道光熱費'), businessRatio: 100 })
    const r = postProration(db, fyId)
    expect(r.posted).toBe(0)
    expect(r.lines[0]).toMatchObject({ householdAmount: 0 })
  })

  it('delete で設定が消える', () => {
    const { db, fyId } = setup()
    const id = upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '通信費'), businessRatio: 70 })
    deleteProrationSetting(db, id)
    expect(listProrationSettings(db, fyId)).toHaveLength(0)
  })

  it('補助別設定と科目レベル設定の併存: 科目レベルは補助分を二重按分しない', () => {
    const { db, fyId } = setup()
    const aid = accId(db, '水道光熱費')
    const subId = addSubAccount(db, '水道光熱費', '店舗A')
    addExpense(db, fyId, '水道光熱費', 100000, subId) // 補助あり
    addExpense(db, fyId, '水道光熱費', 50000) // 補助なし（科目レベルが拾う）

    // 補助別: 事業60%（家事40% = 40,000）／ 科目レベル: 事業80%（家事20% = 10,000、補助分は除外）
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: aid, subAccountId: subId, businessRatio: 60 })
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: aid, businessRatio: 80 })

    const r = postProration(db, fyId)
    // 補助分を二重計上していれば科目レベルは 150,000×20%=30,000 になる。除外で 10,000。
    expect(r.totalHousehold).toBe(50000) // 40,000 + 10,000
    expect(r.posted).toBe(2)
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('比率レンジ外は拒否', () => {
    const { db, fyId } = setup()
    expect(() => upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '通信費'), businessRatio: 120 })).toThrow()
  })

  it('再起票が途中で失敗したら全体がロールバックされ、既存の起票が無傷で残る', () => {
    const { db, fyId } = setup()
    addExpense(db, fyId, '水道光熱費', 100000)
    addExpense(db, fyId, '通信費', 50000)
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '水道光熱費'), businessRatio: 60 })
    upsertProrationSetting(db, { fiscalYearId: fyId, accountId: accId(db, '通信費'), businessRatio: 60 })
    postProration(db, fyId)
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'proration')).all()).toHaveLength(2)

    // 2件目（通信費）の起票で失敗させ、「既存削除済み・新規は一部だけ」の途中失敗を再現する。
    db.run(
      sql`CREATE TRIGGER fail_mid AFTER INSERT ON journal_entries WHEN NEW.description = '家事按分 通信費' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
    )
    expect(() => postProration(db, fyId)).toThrow()
    db.run(sql`DROP TRIGGER fail_mid`)

    // 洗い替えの削除ごとロールバックされ、起票済み2件が残る。
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'proration')).all()).toHaveLength(2)
  })
})
