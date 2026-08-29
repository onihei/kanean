import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, openingBalances, subAccounts, importBatches, rawTransactions } from '../../db/data/schema.js'
import { balanceSheet, subLedger } from '../../reports/reports.js'
import { executeRollover, reopenFiscalYear, rolloverPrecheck } from '../rollover.js'

let tmp: string
const USER = 'u_rollover'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-rollover-'))
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

function subAcc(db: DataDb, account: string, name: string): number {
  return db
    .insert(subAccounts)
    .values({ accountId: accId(db, account), name, createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0].id
}

function opening(db: DataDb, fyId: number, account: string, side: 'debit' | 'credit', amount: number, subAccountId?: number) {
  db.insert(openingBalances).values({ fiscalYearId: fyId, accountId: accId(db, account), subAccountId: subAccountId ?? null, side, amount }).run()
}

function addEntry(db: DataDb, fyId: number, debit: string, credit: string, amount: number, subs?: { debit?: number; credit?: number }) {
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fyId, entryDate: '2026-06-01', description: 't', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, debit), subAccountId: subs?.debit ?? null, amount }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, credit), subAccountId: subs?.credit ?? null, amount }).run()
}

/** 期首 普通預金100万/元入金100万、売上80万・事業主借30万・事業主貸50万 の balanced な当期。 */
function balancedYear(): { db: DataDb; fyId: number } {
  const { db, fyId } = setup()
  opening(db, fyId, '普通預金', 'debit', 1_000_000)
  opening(db, fyId, '元入金', 'credit', 1_000_000)
  addEntry(db, fyId, '普通預金', '売上高', 800_000)
  addEntry(db, fyId, '普通預金', '事業主借', 300_000)
  addEntry(db, fyId, '事業主貸', '普通預金', 500_000)
  return { db, fyId }
}

describe('balanceSheet 事業主貸の貸借一致修正', () => {
  it('事業主貸≠0 でも balanced（事業主貸は資産の部・資本に加算しない）', () => {
    const { db, fyId } = balancedYear()
    const bs = balanceSheet(db, fyId)
    expect(bs.balanced).toBe(true)
    // 事業主貸 は資産の部のセクションに出る。
    expect(bs.assets.some((s) => s.section === '事業主貸')).toBe(true)
    // 資本の部は元入金・事業主借のみ（事業主貸を含まない）。totalEquity = 130万 + 当期所得80万。
    expect(bs.totalEquity).toBe(2_100_000)
    expect(bs.equity.flatMap((s) => s.rows).some((r) => r.accountName === '事業主貸')).toBe(false)
  })

  it('評価勘定（減価償却累計額）を資産から控除し balanced・年度繰越も成立', () => {
    const { db, fyId } = setup()
    // 期首: 機械装置 100万(借) / 減価償却累計額 10万(貸) / 元入金 90万(貸)。間接法で累計額は貸残。
    opening(db, fyId, '機械装置', 'debit', 1_000_000)
    opening(db, fyId, '減価償却累計額', 'credit', 100_000)
    opening(db, fyId, '元入金', 'credit', 900_000)

    const bs = balanceSheet(db, fyId)
    expect(bs.balanced).toBe(true)
    // 固定資産 = 機械装置100万 − 累計額10万 = 90万（控除）。
    expect(bs.assets.find((s) => s.section === '固定資産')!.total).toBe(900_000)
    expect(bs.totalAssets).toBe(900_000)
    expect(bs.totalEquity).toBe(900_000)

    // 繰越: 機械装置・累計額が翌期へ往復し翌期首も balanced。
    const r = executeRollover(db, fyId)
    expect(r.nextMotoire).toBe(900_000)
    const obs = db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, r.nextFiscalYearId)).all()
    const byAcc = (name: string) => obs.find((o) => o.accountId === accId(db, name))
    expect(byAcc('機械装置')).toMatchObject({ side: 'debit', amount: 1_000_000 })
    expect(byAcc('減価償却累計額')).toMatchObject({ side: 'credit', amount: 100_000 })
    expect(balanceSheet(db, r.nextFiscalYearId).balanced).toBe(true)
  })
})

describe('年度繰越（executeRollover）', () => {
  it('当期を closed・翌期を作成し、翌期首BSが balanced・元入金=160万', () => {
    const { db, fyId } = balancedYear()
    const r = executeRollover(db, fyId)

    expect(r.nextMotoire).toBe(1_600_000) // 100万 + 80万 + 30万 − 50万
    // 当期 closed・翌期 open。
    expect(db.select().from(fiscalYears).where(eq(fiscalYears.id, fyId)).all()[0].status).toBe('closed')
    const nextFy = db.select().from(fiscalYears).where(eq(fiscalYears.id, r.nextFiscalYearId)).all()[0]
    expect(nextFy.status).toBe('open')
    expect(nextFy.startDate).toBe('2027-01-01')
    expect(nextFy.endDate).toBe('2027-12-31')

    // 翌期 opening_balances: 普通預金160万(借)・元入金160万(貸)。事業主貸/借は無い。
    const obs = db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, nextFy.id)).all()
    const byAcc = (name: string) => obs.find((o) => o.accountId === accId(db, name))
    expect(byAcc('普通預金')).toMatchObject({ side: 'debit', amount: 1_600_000 })
    expect(byAcc('元入金')).toMatchObject({ side: 'credit', amount: 1_600_000 })
    expect(byAcc('事業主貸')).toBeUndefined()
    expect(byAcc('事業主借')).toBeUndefined()

    // 翌期首BSは balanced（資産160万 = 資本160万）。
    const nextBs = balanceSheet(db, nextFy.id)
    expect(nextBs.balanced).toBe(true)
    expect(nextBs.totalAssets).toBe(1_600_000)
    expect(nextBs.totalEquity).toBe(1_600_000)
  })

  it('当期の貸借不一致なら繰越を拒否', () => {
    const { db, fyId } = setup()
    opening(db, fyId, '元入金', 'credit', 1_000_000) // 相手資産なし＝不一致
    expect(() => executeRollover(db, fyId)).toThrow(/貸借が一致/)
  })

  it('closed の年度は再繰越できない', () => {
    const { db, fyId } = balancedYear()
    executeRollover(db, fyId)
    expect(() => executeRollover(db, fyId)).toThrow(/open ではありません/)
  })
})

describe('年度繰越 — 補助科目レベルの開始残高', () => {
  it('売掛金の取引先別残高を補助科目別に繰越す（補助なし分は null 行・科目合計/BSは不変）', () => {
    const { db, fyId } = setup()
    const subA = subAcc(db, '売掛金', '取引先A')
    const subB = subAcc(db, '売掛金', '取引先B')
    // 期首: 売掛金(取引先A)10万・普通預金90万 / 元入金100万。
    opening(db, fyId, '売掛金', 'debit', 100_000, subA)
    opening(db, fyId, '普通預金', 'debit', 900_000)
    opening(db, fyId, '元入金', 'credit', 1_000_000)
    // 当期: 取引先Bへ売上20万、取引先Aから4万回収、補助なしの売掛売上3万。
    addEntry(db, fyId, '売掛金', '売上高', 200_000, { debit: subB })
    addEntry(db, fyId, '普通預金', '売掛金', 40_000, { credit: subA })
    addEntry(db, fyId, '売掛金', '売上高', 30_000)

    const r = executeRollover(db, fyId)
    const obs = db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, r.nextFiscalYearId)).all()
    const uriId = accId(db, '売掛金')
    const bySub = (sub: number | null) => obs.find((o) => o.accountId === uriId && o.subAccountId === sub)
    expect(bySub(subA)).toMatchObject({ side: 'debit', amount: 60_000 })
    expect(bySub(subB)).toMatchObject({ side: 'debit', amount: 200_000 })
    expect(bySub(null)).toMatchObject({ side: 'debit', amount: 30_000 })

    // 補助元帳の期首繰越へそのまま引き継がれる。
    expect(subLedger(db, r.nextFiscalYearId, subA).openingBalance).toBe(60_000)
    expect(subLedger(db, r.nextFiscalYearId, subB).openingBalance).toBe(200_000)

    // 科目合計（29万）・翌期首BSの貸借一致は科目レベル繰越と不変。
    const nextBs = balanceSheet(db, r.nextFiscalYearId)
    expect(nextBs.balanced).toBe(true)
    expect(nextBs.totalAssets).toBe(1_230_000) // 売掛金29万 + 普通預金94万
    expect(r.nextMotoire).toBe(1_230_000) // 元入金100万 + 当期所得23万（回収4万は資産内移動）
  })

  it('補助別残高が相殺して科目残高0でも補助行は繰越す（過入金の貸残を保持）', () => {
    const { db, fyId } = setup()
    const subA = subAcc(db, '売掛金', '取引先A')
    const subB = subAcc(db, '売掛金', '取引先B')
    opening(db, fyId, '普通預金', 'debit', 1_000_000)
    opening(db, fyId, '元入金', 'credit', 1_000_000)
    // 取引先Aへ売掛10万、取引先Bから過入金10万（売掛B は貸残=マイナス売掛）。
    addEntry(db, fyId, '売掛金', '売上高', 100_000, { debit: subA })
    addEntry(db, fyId, '普通預金', '売掛金', 100_000, { credit: subB })

    const r = executeRollover(db, fyId)
    const obs = db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, r.nextFiscalYearId)).all()
    const uriId = accId(db, '売掛金')
    const bySub = (sub: number | null) => obs.find((o) => o.accountId === uriId && o.subAccountId === sub)
    expect(bySub(subA)).toMatchObject({ side: 'debit', amount: 100_000 })
    expect(bySub(subB)).toMatchObject({ side: 'credit', amount: 100_000 })
    expect(subLedger(db, r.nextFiscalYearId, subB).openingBalance).toBe(-100_000)
    expect(balanceSheet(db, r.nextFiscalYearId).balanced).toBe(true)
  })
})

describe('年度繰越の取消（reopenFiscalYear）', () => {
  it('翌期が仕訳ゼロなら取消できる（翌期FY・opening_balances 削除→当期 open）', () => {
    const { db, fyId } = balancedYear()
    const r = executeRollover(db, fyId)
    reopenFiscalYear(db, fyId)

    expect(db.select().from(fiscalYears).where(eq(fiscalYears.id, fyId)).all()[0].status).toBe('open')
    expect(db.select().from(fiscalYears).where(eq(fiscalYears.id, r.nextFiscalYearId)).all()).toHaveLength(0)
    expect(db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, r.nextFiscalYearId)).all()).toHaveLength(0)
  })

  it('翌期に仕訳があれば取消を拒否', () => {
    const { db, fyId } = balancedYear()
    const r = executeRollover(db, fyId)
    // 翌期に confirmed 仕訳を1件。
    addEntry(db, r.nextFiscalYearId, '普通預金', '売上高', 10_000)
    expect(() => reopenFiscalYear(db, fyId)).toThrow(/翌期に仕訳/)
  })
})

describe('繰越前の警告（rolloverPrecheck）', () => {
  /** 当期(2026)に取込明細を1件足す。日付を変えれば過年度・翌期も作れる。 */
  function addRaw(db: DataDb, status: string, txnDate = '2026-06-01', hash = `h-${status}-${txnDate}`) {
    const batchId = db
      .insert(importBatches)
      .values({ sourceType: 'bank_ufj', accountRef: 'ufj-1', status: 'done', importedAt: '2026-06-01T00:00:00Z' })
      .returning()
      .all()[0].id
    db.insert(rawTransactions)
      .values({ batchId, txnDate, amount: 1000, direction: 'out', description: 'x', dedupHash: hash, accountRef: 'ufj-1', status })
      .run()
  }

  it('当期の未処理を pending / ignored の内訳で返す', () => {
    const { db, fyId } = balancedYear()
    addRaw(db, 'pending')
    addRaw(db, 'pending', '2026-07-01')
    addRaw(db, 'ignored')
    addRaw(db, 'journalized') // 処理済みは数えない
    addRaw(db, 'pending', '2025-06-01') // 当期の外は数えない

    expect(rolloverPrecheck(db, fyId).unprocessedRaw).toEqual({ pending: 2, ignored: 1 })
  })

  it('未処理が残っていても繰越はブロックしない（警告のみ）', () => {
    const { db, fyId } = balancedYear()
    addRaw(db, 'pending')
    expect(() => executeRollover(db, fyId)).not.toThrow()
    expect(db.select().from(fiscalYears).where(eq(fiscalYears.id, fyId)).all()[0].status).toBe('closed')
  })
})
