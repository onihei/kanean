import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, subAccounts, openingBalances } from '../../db/data/schema.js'
import {
  listOpeningBalances,
  listBalanceSheetAccounts,
  listBalanceSheetSubAccounts,
  openingBalanceTotals,
  upsertOpeningBalance,
  deleteOpeningBalance,
} from '../openingBalances.js'
import { previewCapitalTransfer } from '../capitalTransfer.js'

let tmp: string
const USER = 'u_closing'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-closing-'))
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

/** 借) debitAccount / 貸) creditAccount の confirmed 仕訳を1本。 */
function addEntry(db: DataDb, fyId: number, debit: string, credit: string, amount: number) {
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fyId, entryDate: '2026-06-01', description: 't', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, debit), amount }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, credit), amount }).run()
}

describe('opening_balances 書込み（list / upsert / delete）', () => {
  it('upsert は同一（年度・科目・補助=null）を更新し行を増やさない', () => {
    const { db, fyId } = setup()
    const id1 = upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: 1_000_000 })
    const id2 = upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: 1_500_000 })
    expect(id2).toBe(id1)
    const rows = db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, fyId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].amount).toBe(1_500_000)
  })

  it('科目レベル(sub=null)と補助レベルは別行として共存できる', () => {
    const { db, fyId } = setup()
    const cashId = accId(db, '普通預金')
    const subId = db
      .insert(subAccounts)
      .values({ accountId: cashId, name: 'テスト口座', createdAt: 'x', updatedAt: 'x' })
      .returning()
      .all()[0].id
    upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: cashId, side: 'debit', amount: 100 })
    upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: cashId, subAccountId: subId, side: 'debit', amount: 200 })
    const rows = db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, fyId)).all()
    expect(rows).toHaveLength(2)
  })

  it('listOpeningBalances は科目名・section を結合して返す', () => {
    const { db, fyId } = setup()
    upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: 1_000_000 })
    const list = listOpeningBalances(db, fyId)
    expect(list).toHaveLength(1)
    expect(list[0]).toMatchObject({ accountName: '元入金', section: '資本', side: 'credit', amount: 1_000_000, subAccountName: null })
  })

  it('delete は行を削除する', () => {
    const { db, fyId } = setup()
    const id = upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: 1 })
    deleteOpeningBalance(db, id)
    expect(listOpeningBalances(db, fyId)).toHaveLength(0)
  })

  it('open でない会計年度の開始残高は削除を拒否する（決算クローズ統制・upsert と対称）', () => {
    const { db, fyId } = setup()
    const id = upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: 1 })
    db.update(fiscalYears).set({ status: 'closed' }).where(eq(fiscalYears.id, fyId)).run()
    expect(() => deleteOpeningBalance(db, id)).toThrow(/open でない/)
    expect(listOpeningBalances(db, fyId)).toHaveLength(1)
  })

  it('存在しないidの削除は冪等（throwしない）', () => {
    const { db } = setup()
    expect(() => deleteOpeningBalance(db, 99999)).not.toThrow()
  })

  it('PL科目・不正なside・負の金額は弾く', () => {
    const { db, fyId } = setup()
    expect(() => upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '売上高'), side: 'credit', amount: 1 })).toThrow(/貸借対照表科目/)
    expect(() => upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'x', amount: 1 })).toThrow(/side/)
    expect(() => upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: -1 })).toThrow(/金額/)
  })

  it('listBalanceSheetAccounts は BS 科目のみ（PL・事業主貸借は含まない）＋三部 part を返す', () => {
    const { db } = setup()
    const bs = listBalanceSheetAccounts(db)
    expect(bs.some((a) => a.name === '元入金')).toBe(true)
    expect(bs.some((a) => a.name === '普通預金')).toBe(true)
    expect(bs.some((a) => a.name === '売上高')).toBe(false)
    // 事業主貸/借は毎期首ゼロ＝開始残高の対象外（グリッドに出さない）
    expect(bs.some((a) => a.name === '事業主貸')).toBe(false)
    expect(bs.some((a) => a.name === '事業主借')).toBe(false)
    // 三部（資産の部/負債の部/資本の部）が付与される
    expect(bs.find((a) => a.name === '普通預金')?.part).toBe('資産の部')
    expect(bs.find((a) => a.name === '買掛金')?.part).toBe('負債の部')
    expect(bs.find((a) => a.name === '元入金')?.part).toBe('資本の部')
    // 控除科目（評価勘定）は資産の部に並ぶが正常側は貸方
    expect(bs.find((a) => a.name === '減価償却累計額')).toMatchObject({ part: '資産の部', normalBalance: 'credit' })
  })

  it('listBalanceSheetSubAccounts は有効な BS 科目配下の補助のみ（PL配下・無効・事業主貸借配下は除外）', () => {
    const { db } = setup()
    // BS 科目（売掛金）配下の有効な補助は含まれる
    db.insert(subAccounts).values({ accountId: accId(db, '売掛金'), name: 'BS補助', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' }).run()
    // PL 科目（売上高）配下の補助は除外される
    db.insert(subAccounts).values({ accountId: accId(db, '売上高'), name: 'PL補助', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' }).run()
    // BS 科目（普通預金）配下でも無効な補助は除外される
    db.insert(subAccounts).values({ accountId: accId(db, '普通預金'), name: '無効口座', isActive: false, sortOrder: 99, createdAt: 'x', updatedAt: 'x' }).run()

    const subs = listBalanceSheetSubAccounts(db)
    // BS 科目配下の有効な補助は含まれ、accountId が紐づく
    const bs = subs.find((s) => s.name === 'BS補助')
    expect(bs?.accountId).toBe(accId(db, '売掛金'))
    expect(subs.some((s) => s.name === 'PL補助')).toBe(false)
    expect(subs.some((s) => s.name === '無効口座')).toBe(false)
    // 事業主貸配下のシード補助（源泉所得税）も親除外に伴い出さない
    expect(subs.some((s) => s.name === '源泉所得税')).toBe(false)
  })

  it('openingBalanceTotals は貸借合計と一致判定を返す（data-model §2.7）', () => {
    const { db, fyId } = setup()
    upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '普通預金'), side: 'debit', amount: 1_000_000 })
    upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: 1_000_000 })
    expect(openingBalanceTotals(listOpeningBalances(db, fyId))).toEqual({
      totalDebit: 1_000_000,
      totalCredit: 1_000_000,
      difference: 0,
      balanced: true,
    })
    upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '現金'), side: 'debit', amount: 200_000 })
    expect(openingBalanceTotals(listOpeningBalances(db, fyId))).toMatchObject({
      totalDebit: 1_200_000,
      totalCredit: 1_000_000,
      difference: 200_000,
      balanced: false,
    })
  })
})

describe('元入金振替プレビュー（accounting-spec §1.3）', () => {
  it('翌期首元入金 = 前期末元入金 + 当期所得 + 事業主借 − 事業主貸（起票しない）', () => {
    const { db, fyId } = setup()
    // 前期末元入金 1,000,000（期首 opening_balances）。
    upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: 1_000_000 })
    // 当期所得 800,000（売上のみ）。
    addEntry(db, fyId, '普通預金', '売上高', 800_000)
    // 事業主借 期末残高 300,000。
    addEntry(db, fyId, '普通預金', '事業主借', 300_000)
    // 事業主貸 期末残高 500,000。
    addEntry(db, fyId, '事業主貸', '普通預金', 500_000)

    const before = db.select().from(journalEntries).all().length
    const p = previewCapitalTransfer(db, fyId)
    const after = db.select().from(journalEntries).all().length

    expect(p.priorMotoire).toBe(1_000_000)
    expect(p.incomeBeforeDeduction).toBe(800_000)
    expect(p.ownerLoan).toBe(300_000)
    expect(p.ownerDraw).toBe(500_000)
    expect(p.netChange).toBe(600_000)
    expect(p.nextMotoire).toBe(1_600_000)
    // 計算のみ＝仕訳は1本も増えていない（legal gate）。
    expect(after).toBe(before)
    expect(db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, fyId)).all()).toHaveLength(1)
  })

  it('事業主貸借・所得ゼロなら翌期首元入金は期首と同額', () => {
    const { db, fyId } = setup()
    upsertOpeningBalance(db, { fiscalYearId: fyId, accountId: accId(db, '元入金'), side: 'credit', amount: 2_000_000 })
    const p = previewCapitalTransfer(db, fyId)
    expect(p.nextMotoire).toBe(2_000_000)
    expect(p.netChange).toBe(0)
  })
})
