import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, openingBalances, subAccounts, taxCategories } from '../../db/data/schema.js'
import { accounts } from '../../db/data/schema.js'
import {
  trialBalance,
  profitAndLoss,
  balanceSheet,
  generalLedger,
  subLedger,
  monthlyTrend,
  taxSalesSummary,
  departmentTrialBalance,
  departmentProfitAndLoss,
  taxExcludedProfitAndLoss,
  priorFiscalYearId,
  comparativeProfitAndLoss,
  comparativeTrialBalance,
  comparativeBalanceSheet,
} from '../reports.js'
import { createManualEntry } from '../../journal/manualEntry.js'
import { createDepartment } from '../../masters/departments.js'

let tmp: string
const USER = 'u_reports'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-reports-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

interface LineSpec {
  account: string
  side: 'debit' | 'credit'
  amount: number
}

function setup() {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  const fy = db.select().from(fiscalYears).all()[0]

  const addEntry = (date: string, desc: string, status: 'draft' | 'confirmed', lines: LineSpec[]) => {
    const now = '2026-01-01T00:00:00Z'
    const entry = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: date, description: desc, source: 'manual', status, createdAt: now, updatedAt: now })
      .returning()
      .all()[0]
    lines.forEach((l, i) =>
      db.insert(journalLines).values({ entryId: entry.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), amount: l.amount }).run(),
    )
    return entry
  }

  // 売上入金 / 経費 / draft（除外されるべき）。
  addEntry('2026-06-01', '売上入金', 'confirmed', [
    { account: '普通預金', side: 'debit', amount: 330000 },
    { account: '売上高', side: 'credit', amount: 330000 },
  ])
  addEntry('2026-07-15', '電気代', 'confirmed', [
    { account: '水道光熱費', side: 'debit', amount: 11000 },
    { account: '普通預金', side: 'credit', amount: 11000 },
  ])
  addEntry('2026-08-01', '未確定', 'draft', [
    { account: '水道光熱費', side: 'debit', amount: 99999 },
    { account: '普通預金', side: 'credit', amount: 99999 },
  ])
  return { db, fy }
}

describe('帳票（試算表 / P&L / B/S / 元帳）', () => {
  it('試算表: confirmed のみ集計し貸借一致', () => {
    const { db, fy } = setup()
    const tb = trialBalance(db, fy.id)
    expect(tb.totalDebit).toBe(341000) // 330,000 + 11,000
    expect(tb.totalCredit).toBe(341000)
    expect(tb.balanced).toBe(true)

    const cash = tb.rows.find((r) => r.accountName === '普通預金')!
    expect(cash.balance).toBe(319000) // 330,000 − 11,000（draft 99,999 は除外）
    expect(tb.rows.find((r) => r.accountName === '売上高')!.balance).toBe(330000)
  })

  it('期間試算表: from あり=期間発生高（開始残高なし）、to のみ=期末時点累計', () => {
    const { db, fy } = setup()
    db.insert(openingBalances).values({ fiscalYearId: fy.id, accountId: accId(db, '普通預金'), side: 'debit', amount: 100000 }).run()
    // setup: 6/1 入金330,000 / 7/15 電気代-11,000（confirmed）。draft は常に除外。

    // 6月のみ（発生高）: 入金330,000 のみ。開始残高は含めない。
    const june = trialBalance(db, fy.id, { from: '2026-06-01', to: '2026-06-30' })
    expect(june.rows.find((r) => r.accountName === '普通預金')!.balance).toBe(330000)
    expect(june.rows.find((r) => r.accountName === '水道光熱費')).toBeUndefined() // 7月の電気代は範囲外
    expect(june.balanced).toBe(true)

    // 6/30 時点の累計（to のみ）: 開始残高100,000 + 6月入金330,000 = 430,000。
    const asOfJune = trialBalance(db, fy.id, { to: '2026-06-30' })
    expect(asOfJune.rows.find((r) => r.accountName === '普通預金')!.balance).toBe(430000)

    // 7/31 時点の累計: 100,000 + 330,000 − 11,000 = 419,000。
    const asOfJuly = trialBalance(db, fy.id, { to: '2026-07-31' })
    expect(asOfJuly.rows.find((r) => r.accountName === '普通預金')!.balance).toBe(419000)
  })

  it('不正な期間（形式不正・from>to）は拒否し、空の貸借一致を誤って返さない', () => {
    const { db, fy } = setup()
    expect(() => trialBalance(db, fy.id, { to: 'bad' })).toThrow(/YYYY-MM-DD/)
    expect(() => trialBalance(db, fy.id, { from: '2026-13-01' })).toThrow(/存在しない/) // 桁形は合うが実在しない月
    expect(() => trialBalance(db, fy.id, { from: '2026-07-01', to: '2026-06-01' })).toThrow(/from は to 以前/)
  })

  it('月次推移表: 暦年12ヶ月・科目ごとの月次発生高と合計', () => {
    const { db, fy } = setup()
    // setup: 6/1 普通預金+330,000/売上高 、7/15 水道光熱費11,000/普通預金。draft は除外。
    const trend = monthlyTrend(db, fy.id)
    expect(trend.months).toHaveLength(12)
    expect(trend.months[0]).toBe('2026-01')
    expect(trend.months[11]).toBe('2026-12')

    const sales = trend.rows.find((r) => r.accountName === '売上高')!
    expect(sales.monthly[5]).toBe(330000) // 6月（index 5）
    expect(sales.monthly[6]).toBe(0)
    expect(sales.total).toBe(330000)

    const utils = trend.rows.find((r) => r.accountName === '水道光熱費')!
    expect(utils.monthly[6]).toBe(11000) // 7月（index 6）
    expect(utils.total).toBe(11000)

    const bank = trend.rows.find((r) => r.accountName === '普通預金')!
    expect(bank.monthly[5]).toBe(330000) // 6月入金（借方=normal debit）
    expect(bank.monthly[6]).toBe(-11000) // 7月出金
    expect(bank.total).toBe(319000)
  })

  it('損益計算書: 売上 − 経費 = 当期所得', () => {
    const { db, fy } = setup()
    const pl = profitAndLoss(db, fy.id)
    expect(pl.sales.total).toBe(330000)
    expect(pl.expenses.total).toBe(11000)
    expect(pl.grossProfit).toBe(330000) // 売上原価なし
    expect(pl.netIncome).toBe(319000)
  })

  it('貸借対照表: 資本の部に当期所得を連結し借貸一致', () => {
    const { db, fy } = setup()
    const bs = balanceSheet(db, fy.id)
    expect(bs.totalAssets).toBe(319000) // 普通預金
    expect(bs.netIncome).toBe(319000)
    expect(bs.totalEquity).toBe(319000) // 資本0 + 当期所得
    expect(bs.balanced).toBe(true)
  })

  it('総勘定元帳: 時系列で累積残高（普通預金）', () => {
    const { db, fy } = setup()
    const led = generalLedger(db, fy.id, accId(db, '普通預金'))
    expect(led.openingBalance).toBe(0)
    expect(led.rows).toHaveLength(2)
    expect(led.rows[0]).toMatchObject({ counterAccount: '売上高', debit: 330000, balance: 330000 })
    expect(led.rows[1]).toMatchObject({ counterAccount: '水道光熱費', credit: 11000, balance: 319000 })
    expect(led.closingBalance).toBe(319000)
  })

  it('開始残高（前期繰越）を期首残高として反映', () => {
    const { db, fy } = setup()
    db.insert(openingBalances).values({ fiscalYearId: fy.id, accountId: accId(db, '普通預金'), side: 'debit', amount: 100000 }).run()
    const led = generalLedger(db, fy.id, accId(db, '普通預金'))
    expect(led.openingBalance).toBe(100000)
    expect(led.closingBalance).toBe(419000) // 100,000 + 319,000
    expect(trialBalance(db, fy.id).rows.find((r) => r.accountName === '普通預金')!.balance).toBe(419000)
  })

  it('総勘定元帳: 相手が複数の複合仕訳は諸口（id 一致で解決）', () => {
    const { db, fy } = setup()
    // 借)普通預金 9,800 / 借)支払手数料 200 / 貸)売上高 10,000。普通預金 から見た相手は2科目→諸口。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-09-01',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 9800 },
        { side: 'debit', accountId: accId(db, '支払手数料'), amount: 200 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 10000 },
      ],
    })
    const led = generalLedger(db, fy.id, accId(db, '普通預金'))
    expect(led.rows.find((r) => r.entryDate === '2026-09-01')!.counterAccount).toBe('諸口')
    // 単一相手は科目名そのまま（既存挙動を維持）。
    expect(led.rows.find((r) => r.entryDate === '2026-06-01')!.counterAccount).toBe('売上高')
  })
})

describe('補助元帳（subLedger / F-BOK-2）', () => {
  function setupSub() {
    const db = new DbRouter().bookDb('u_subledger')
    seedDataPlane(db)
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: 'x' }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    const bank = accId(db, '普通預金')
    const subId = db
      .insert(subAccounts)
      .values({ accountId: bank, name: 'UFJ普通', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' })
      .returning()
      .all()[0].id

    const addEntry = (date: string, desc: string, lines: { account: string; sub?: number; side: 'debit' | 'credit'; amount: number }[]) => {
      const e = db
        .insert(journalEntries)
        .values({ fiscalYearId: fy.id, entryDate: date, description: desc, source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
        .returning()
        .all()[0]
      lines.forEach((l, i) =>
        db.insert(journalLines).values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), subAccountId: l.sub ?? null, amount: l.amount }).run(),
      )
    }

    // 補助あり明細（UFJ普通）と、補助なしの普通預金明細（補助元帳には出ない）。
    addEntry('2026-03-01', '売上入金', [
      { account: '普通預金', sub: subId, side: 'debit', amount: 100000 },
      { account: '売上高', side: 'credit', amount: 100000 },
    ])
    addEntry('2026-04-01', '電気代', [
      { account: '水道光熱費', side: 'debit', amount: 8000 },
      { account: '普通預金', sub: subId, side: 'credit', amount: 8000 },
    ])
    addEntry('2026-05-01', '補助なし入金', [
      { account: '普通預金', side: 'debit', amount: 5000 }, // 補助未設定 → UFJ普通の元帳には出ない
      { account: '売上高', side: 'credit', amount: 5000 },
    ])
    return { db, fy, bank, subId, addEntry }
  }

  it('補助科目別に時系列・累積残高を出し、相手科目を解決する', () => {
    const { db, fy, subId } = setupSub()
    const led = subLedger(db, fy.id, subId)
    expect(led.subAccountName).toBe('UFJ普通')
    expect(led.accountName).toBe('普通預金')
    expect(led.normalBalance).toBe('debit')
    expect(led.openingBalance).toBe(0)
    expect(led.rows).toHaveLength(2) // 補助なしの 5,000 は含まれない
    expect(led.rows[0]).toMatchObject({ counterAccount: '売上高', debit: 100000, balance: 100000 })
    expect(led.rows[1]).toMatchObject({ counterAccount: '水道光熱費', credit: 8000, balance: 92000 })
    expect(led.closingBalance).toBe(92000)
  })

  it('補助科目別の開始残高を期首繰越として反映する', () => {
    const { db, fy, bank, subId } = setupSub()
    db.insert(openingBalances).values({ fiscalYearId: fy.id, accountId: bank, subAccountId: subId, side: 'debit', amount: 30000 }).run()
    const led = subLedger(db, fy.id, subId)
    expect(led.openingBalance).toBe(30000)
    expect(led.closingBalance).toBe(122000) // 30,000 + 100,000 − 8,000
  })

  it('相手科目に自分の親勘定を出さない（同一勘定の別明細は相手から除外）', () => {
    const { db, fy, subId, addEntry } = setupSub()
    // 同一仕訳に UFJ普通(自補助) と 普通預金(補助なし・同一親) の明細 → 相手は売上高のみ。
    addEntry('2026-06-01', '入金（手数料控除）', [
      { account: '普通預金', sub: subId, side: 'debit', amount: 9800 },
      { account: '普通預金', side: 'debit', amount: 200 }, // 同一親・補助なし（自己なので相手にしない）
      { account: '売上高', side: 'credit', amount: 10000 },
    ])
    const led = subLedger(db, fy.id, subId)
    const row = led.rows.find((r) => r.entryDate === '2026-06-01')!
    expect(row.counterAccount).toBe('売上高') // 普通預金 が相手に出ない
  })

  it('存在しない補助科目は例外', () => {
    const { db, fy } = setupSub()
    expect(() => subLedger(db, fy.id, 99999)).toThrow(/補助科目/)
  })
})

describe('税区分別 課税売上集計（taxSalesSummary / Phase2）', () => {
  function setupTax() {
    const db = new DbRouter().bookDb('u_taxsales')
    seedDataPlane(db)
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: 'x' }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    return { db, fy }
  }
  const taxCode = (db: DataDb, code: string) => db.select().from(taxCategories).where(eq(taxCategories.code, code)).all()[0].id

  it('課税売上の税区分別に税込/税抜/税額を集計し、税率別課税標準額を出す', () => {
    const { db, fy } = setupTax()
    const sale10 = taxCode(db, 'SALE_10_C5')
    // 借)現金 11,000 / 貸)売上高 11,000（10%課売・五種）。内税 1,000、税抜 10,000。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-06-01',
      lines: [
        { side: 'debit', accountId: accId(db, '現金'), amount: 11000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 11000, taxCategoryId: sale10 },
      ],
    })
    // もう1件 22,000（税抜 20,000・税 2,000）。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-07-01',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 22000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 22000, taxCategoryId: sale10 },
      ],
    })

    const s = taxSalesSummary(db, fy.id)
    const row = s.rows.find((r) => r.code === 'SALE_10_C5')!
    expect(row.grossAmount).toBe(33000)
    expect(row.taxAmount).toBe(3000)
    expect(row.netAmount).toBe(30000)
    expect(row.count).toBe(2)

    expect(s.baseByRate).toEqual([{ rate: 10, net: 30000, tax: 3000 }])
    expect(s.totalGross).toBe(33000)
    expect(s.totalNet).toBe(30000)
    expect(s.totalTax).toBe(3000)
  })

  it('返還等（返品・値引）は合計で控除する（過大計上しない）', () => {
    const { db, fy } = setupTax()
    const sale10 = taxCode(db, 'SALE_10_C5')
    const ret10 = taxCode(db, 'SALE_10_C5_RET')
    // 通常売上 11,000（税抜10,000/税1,000）。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-06-01',
      lines: [
        { side: 'debit', accountId: accId(db, '現金'), amount: 11000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 11000, taxCategoryId: sale10 },
      ],
    })
    // 返品 1,100（税抜1,000/税100）。借)売上高(返還) / 貸)現金。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-06-05',
      lines: [
        { side: 'debit', accountId: accId(db, '売上高'), amount: 1100, taxCategoryId: ret10 },
        { side: 'credit', accountId: accId(db, '現金'), amount: 1100 },
      ],
    })

    const s = taxSalesSummary(db, fy.id)
    // 合計は正味（通常 − 返還）。
    expect(s.totalGross).toBe(9900) // 11,000 − 1,100
    expect(s.totalNet).toBe(9000) // 10,000 − 1,000
    expect(s.totalTax).toBe(900) // 1,000 − 100
    // baseByRate は通常売上のみ（返還は base に含めない）。
    expect(s.baseByRate).toEqual([{ rate: 10, net: 10000, tax: 1000 }])
    // 返還行は表示上は正の額で残る。
    expect(s.rows.find((r) => r.adjustment === 'return')!.grossAmount).toBe(1100)
  })

  it('仕入（課税仕入）や対象外は集計に含めない（売上の課税のみ）', () => {
    const { db, fy } = setupTax()
    // 経費（課仕10%）: 借)通信費 1,100 / 貸)現金 1,100 → 売上ではないので集計対象外。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-06-10',
      lines: [
        { side: 'debit', accountId: accId(db, '通信費'), amount: 1100, taxCategoryId: taxCode(db, 'PUR_10') },
        { side: 'credit', accountId: accId(db, '現金'), amount: 1100 },
      ],
    })
    const s = taxSalesSummary(db, fy.id)
    expect(s.rows).toHaveLength(0)
    expect(s.baseByRate).toHaveLength(0)
    expect(s.totalTax).toBe(0)
  })
})

describe('部門別集計（部門別PL / 部門別試算表 / Phase2）', () => {
  function setupDept() {
    const db = new DbRouter().bookDb('u_dept')
    seedDataPlane(db)
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: 'x' }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    const eigyo = createDepartment(db, '営業部')
    const kanri = createDepartment(db, '管理部')

    const entry = (date: string, lines: { account: string; side: 'debit' | 'credit'; amount: number; dept?: number | null }[]) => {
      const e = db
        .insert(journalEntries)
        .values({ fiscalYearId: fy.id, entryDate: date, description: 't', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
        .returning()
        .all()[0]
      lines.forEach((l, i) =>
        db.insert(journalLines).values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), departmentId: l.dept ?? null, amount: l.amount }).run(),
      )
    }

    // 営業部: 売上 330,000 / 経費(旅費) 5,000 → 純益 325,000
    entry('2026-03-01', [
      { account: '現金', side: 'debit', amount: 330000, dept: eigyo },
      { account: '売上高', side: 'credit', amount: 330000, dept: eigyo },
    ])
    entry('2026-03-05', [
      { account: '旅費交通費', side: 'debit', amount: 5000, dept: eigyo },
      { account: '現金', side: 'credit', amount: 5000, dept: eigyo },
    ])
    // 管理部: 経費(水道光熱費) 11,000 → 純益 -11,000
    entry('2026-04-01', [
      { account: '水道光熱費', side: 'debit', amount: 11000, dept: kanri },
      { account: '現金', side: 'credit', amount: 11000, dept: kanri },
    ])
    // 未配賦（部門なし）: 経費(通信費) 3,000 → 純益 -3,000
    entry('2026-05-01', [
      { account: '通信費', side: 'debit', amount: 3000 },
      { account: '現金', side: 'credit', amount: 3000 },
    ])
    return { db, fy, eigyo, kanri }
  }

  it('部門別PL: 列=営業部・管理部・未配賦、部門別の当期所得を算出', () => {
    const { db, fy } = setupDept()
    const pl = departmentProfitAndLoss(db, fy.id)
    expect(pl.departments.map((d) => d.departmentName)).toEqual(['営業部', '管理部', '未配賦'])
    expect(pl.departments[2].departmentId).toBeNull()

    // 売上は営業部のみ。
    expect(pl.sales.totalByDept).toEqual([330000, 0, 0])
    // 経費: 営業5,000 / 管理11,000 / 未配賦3,000。
    expect(pl.expenses.totalByDept).toEqual([5000, 11000, 3000])
    expect(pl.netIncomeByDept).toEqual([325000, -11000, -3000])
    expect(pl.netIncome).toBe(311000)
  })

  it('部門別PLの全部門合算は全社PLの当期所得に一致（発生高ベースの整合）', () => {
    const { db, fy } = setupDept()
    const pl = departmentProfitAndLoss(db, fy.id)
    const global = profitAndLoss(db, fy.id)
    expect(pl.netIncomeByDept.reduce((s, v) => s + v, 0)).toBe(global.netIncome)
    expect(pl.netIncome).toBe(global.netIncome)
  })

  it('部門別試算表: 部門ごとの残高マトリクスと部門別借貸合計・全体貸借一致', () => {
    const { db, fy } = setupDept()
    const tb = departmentTrialBalance(db, fy.id)
    expect(tb.balanced).toBe(true)
    // 各仕訳が単一部門内で完結 → 部門ごとに借貸一致。
    expect(tb.totalsByDept[0]).toEqual({ totalDebit: 335000, totalCredit: 335000 }) // 営業
    expect(tb.totalsByDept[1]).toEqual({ totalDebit: 11000, totalCredit: 11000 }) // 管理
    expect(tb.totalsByDept[2]).toEqual({ totalDebit: 3000, totalCredit: 3000 }) // 未配賦
    expect(tb.totalDebit).toBe(349000)

    const cash = tb.rows.find((r) => r.accountName === '現金')!
    expect(cash.byDept).toEqual([325000, -11000, -3000]) // 営業 330,000-5,000 / 管理 -11,000 / 未配賦 -3,000
    expect(cash.total).toBe(311000)
  })

  it('部門跨ぎ仕訳でも全体は貸借一致（部門別では借貸が割れる）', () => {
    const { db, fy, eigyo, kanri } = setupDept()
    // 借)消耗品費[営業] 2,000 / 貸)現金[管理] 2,000。
    const e = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: 'x', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
      .returning()
      .all()[0]
    db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '消耗品費'), departmentId: eigyo, amount: 2000 }).run()
    db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '現金'), departmentId: kanri, amount: 2000 }).run()

    const tb = departmentTrialBalance(db, fy.id)
    expect(tb.balanced).toBe(true) // 全体は一致
    expect(tb.totalsByDept[0].totalDebit).toBe(337000) // 営業 借方 +2,000
    expect(tb.totalsByDept[1].totalCredit).toBe(13000) // 管理 貸方 +2,000
    // PL の整合は跨ぎでも保たれる。
    const pl = departmentProfitAndLoss(db, fy.id)
    expect(pl.netIncomeByDept.reduce((s, v) => s + v, 0)).toBe(profitAndLoss(db, fy.id).netIncome)
  })

  it('部門別PL: BS科目にしか現れない部門は列に出さない（試算表には出る）', () => {
    const { db, fy } = setupDept()
    // 「財務部」を BS科目（普通預金⇄現金 の振替）にのみ付与＝PL活動なし。
    const zaimu = createDepartment(db, '財務部')
    const e = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: '2026-07-01', description: 'x', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
      .returning()
      .all()[0]
    db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '普通預金'), departmentId: zaimu, amount: 1000 }).run()
    db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '現金'), departmentId: zaimu, amount: 1000 }).run()

    const pl = departmentProfitAndLoss(db, fy.id)
    expect(pl.departments.map((d) => d.departmentName)).not.toContain('財務部')
    // 数値・全社一致は不変（落とした列は全PL科目で0）。
    expect(pl.netIncome).toBe(profitAndLoss(db, fy.id).netIncome)

    // 試算表は全科目を出すので財務部は列に残る。
    const tb = departmentTrialBalance(db, fy.id)
    expect(tb.departments.map((d) => d.departmentName)).toContain('財務部')
    expect(tb.balanced).toBe(true)
  })

  it('期間指定: 当該期間に発生した部門明細のみ集計', () => {
    const { db, fy } = setupDept()
    // 3月のみ（営業の売上330,000・経費5,000）。管理(4月)・未配賦(5月)は範囲外。
    const pl = departmentProfitAndLoss(db, fy.id, { from: '2026-03-01', to: '2026-03-31' })
    expect(pl.departments.map((d) => d.departmentName)).toEqual(['営業部']) // 管理・未配賦は現れない
    expect(pl.netIncomeByDept).toEqual([325000])
  })

  it('部門を付与した明細が無いと未配賦のみ（onlyUnassigned 相当）', () => {
    const db = new DbRouter().bookDb('u_dept_none')
    seedDataPlane(db)
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: 'x' }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-03-01',
      lines: [
        { side: 'debit', accountId: accId(db, '現金'), amount: 10000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 10000 },
      ],
    })
    const tb = departmentTrialBalance(db, fy.id)
    expect(tb.departments).toHaveLength(1)
    expect(tb.departments[0].departmentId).toBeNull()
    expect(tb.balanced).toBe(true)
  })
})

describe('税抜損益計算書（taxExcludedProfitAndLoss / Phase2）', () => {
  const taxCode = (db: DataDb, code: string) => db.select().from(taxCategories).where(eq(taxCategories.code, code)).all()[0].id

  function setupTaxExcluded() {
    const db = new DbRouter().bookDb('u_taxexcl')
    seedDataPlane(db)
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: 'x' }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    // 売上 11,000（10%課売・内税1,000・本体10,000）。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-06-01',
      lines: [
        { side: 'debit', accountId: accId(db, '現金'), amount: 11000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 11000, taxCategoryId: taxCode(db, 'SALE_10_C5') },
      ],
    })
    // 経費 通信費 1,100（10%課仕・内税100・本体1,000）。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-07-01',
      lines: [
        { side: 'debit', accountId: accId(db, '通信費'), amount: 1100, taxCategoryId: taxCode(db, 'PUR_10') },
        { side: 'credit', accountId: accId(db, '現金'), amount: 1100 },
      ],
    })
    return { db, fy }
  }

  it('PL科目を税込・内税・税抜に分解し、税抜の売上総利益・当期所得を算出', () => {
    const { db, fy } = setupTaxExcluded()
    const pl = taxExcludedProfitAndLoss(db, fy.id)
    expect(pl.accountingMethod).toBe('tax_included')

    expect(pl.sales).toMatchObject({ gross: 11000, tax: 1000, net: 10000 })
    expect(pl.expenses).toMatchObject({ gross: 1100, tax: 100, net: 1000 })
    expect(pl.costOfSales.rows).toHaveLength(0)

    // 税抜ベース。
    expect(pl.grossProfitNet).toBe(10000)
    expect(pl.netIncomeNet).toBe(9000)
    // 税込ベース（参考）。
    expect(pl.grossProfitGross).toBe(11000)
    expect(pl.netIncomeGross).toBe(9900)

    const tsumo = pl.sales.rows.find((r) => r.accountName === '売上高')!
    expect(tsumo).toMatchObject({ gross: 11000, tax: 1000, net: 10000 })
  })

  it('税込ベースの当期所得は既存 profitAndLoss と一致（回帰固定）', () => {
    const { db, fy } = setupTaxExcluded()
    const pl = taxExcludedProfitAndLoss(db, fy.id)
    expect(pl.netIncomeGross).toBe(profitAndLoss(db, fy.id).netIncome)
  })

  it('非課税・対象外（内税なし）の科目は税込=税抜（内税0）', () => {
    const { db, fy } = setupTaxExcluded()
    // 対象外の経費（租税公課・税区分なし）: 借)租税公課 5,000 / 貸)現金 5,000。
    createManualEntry(db, {
      fiscalYearId: fy.id,
      entryDate: '2026-08-01',
      lines: [
        { side: 'debit', accountId: accId(db, '租税公課'), amount: 5000, taxCategoryId: null },
        { side: 'credit', accountId: accId(db, '現金'), amount: 5000 },
      ],
    })
    const pl = taxExcludedProfitAndLoss(db, fy.id)
    const zei = pl.expenses.rows.find((r) => r.accountName === '租税公課')!
    expect(zei).toMatchObject({ gross: 5000, tax: 0, net: 5000 })
  })
})

// --- 前期比較（複数年度比較） -----------------------------------------------

/** 前期(2025・closed)と当期(2026・open)の2年度を作り confirmed 仕訳を入れる。 */
function setupTwoYears() {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const now = '2026-01-01T00:00:00Z'
  const y2025 = db.insert(fiscalYears).values({ startDate: '2025-01-01', endDate: '2025-12-31', status: 'closed', createdAt: now }).returning().all()[0]
  const y2026 = db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).returning().all()[0]

  const addEntry = (fiscalYearId: number, date: string, lines: LineSpec[]) => {
    const entry = db
      .insert(journalEntries)
      .values({ fiscalYearId, entryDate: date, description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now })
      .returning()
      .all()[0]
    lines.forEach((l, i) =>
      db.insert(journalLines).values({ entryId: entry.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), amount: l.amount }).run(),
    )
  }

  // 2025: 売上200,000 / 水道光熱費10,000 / 接待交際費8,000（2025のみ）。netIncome=182,000
  addEntry(y2025.id, '2025-06-01', [
    { account: '普通預金', side: 'debit', amount: 200000 },
    { account: '売上高', side: 'credit', amount: 200000 },
  ])
  addEntry(y2025.id, '2025-07-01', [
    { account: '水道光熱費', side: 'debit', amount: 10000 },
    { account: '普通預金', side: 'credit', amount: 10000 },
  ])
  addEntry(y2025.id, '2025-08-01', [
    { account: '接待交際費', side: 'debit', amount: 8000 },
    { account: '現金', side: 'credit', amount: 8000 },
  ])
  // 2026: 売上330,000 / 水道光熱費11,000 / 通信費5,000（2026のみ）。netIncome=314,000
  addEntry(y2026.id, '2026-06-01', [
    { account: '普通預金', side: 'debit', amount: 330000 },
    { account: '売上高', side: 'credit', amount: 330000 },
  ])
  addEntry(y2026.id, '2026-07-01', [
    { account: '水道光熱費', side: 'debit', amount: 11000 },
    { account: '普通預金', side: 'credit', amount: 11000 },
  ])
  addEntry(y2026.id, '2026-08-01', [
    { account: '通信費', side: 'debit', amount: 5000 },
    { account: '現金', side: 'credit', amount: 5000 },
  ])
  return { db, y2025, y2026 }
}

describe('前期比較（複数年度比較）', () => {
  it('priorFiscalYearId: 当期の直前年度を解決し、初年度は null', () => {
    const { db, y2025, y2026 } = setupTwoYears()
    expect(priorFiscalYearId(db, y2026.id)).toBe(y2025.id)
    expect(priorFiscalYearId(db, y2025.id)).toBeNull() // 前がない初年度
  })

  it('比較PL: 当期=単年PL・前期=単年PL に一致し、増減/増減率が正しい', () => {
    const { db, y2025, y2026 } = setupTwoYears()
    const comp = comparativeProfitAndLoss(db, y2026.id, y2025.id)
    const cur = profitAndLoss(db, y2026.id)
    const pri = profitAndLoss(db, y2025.id)

    expect(comp.hasPrior).toBe(true)
    // 単年PLに一致（回帰固定）。
    expect(comp.sales.total.current).toBe(cur.sales.total) // 330,000
    expect(comp.sales.total.prior).toBe(pri.sales.total) // 200,000
    expect(comp.netIncome.current).toBe(cur.netIncome) // 314,000
    expect(comp.netIncome.prior).toBe(pri.netIncome) // 182,000
    // 増減・増減率。
    expect(comp.sales.total.delta).toBe(130000)
    expect(comp.sales.total.deltaPct).toBe(65) // 130,000 / 200,000
    expect(comp.netIncome.delta).toBe(132000)
    expect(comp.netIncome.deltaPct).toBe(72.5) // 132,000 / 182,000 = 72.527 → 72.5
  })

  it('比較PL: 片側のみの科目は欠けた側が0、前期0の増減率は null', () => {
    const { db, y2025, y2026 } = setupTwoYears()
    const comp = comparativeProfitAndLoss(db, y2026.id, y2025.id)
    const tsushin = comp.expenses.rows.find((r) => r.accountName === '通信費')! // 2026のみ
    expect(tsushin).toMatchObject({ current: 5000, prior: 0, delta: 5000, deltaPct: null })
    const settai = comp.expenses.rows.find((r) => r.accountName === '接待交際費')! // 2025のみ
    expect(settai).toMatchObject({ current: 0, prior: 8000, delta: -8000, deltaPct: -100 })
  })

  it('比較PL: 前期なし（priorFyId=null）は hasPrior=false・前期0・増減率 null', () => {
    const { db, y2026 } = setupTwoYears()
    const comp = comparativeProfitAndLoss(db, y2026.id, null)
    expect(comp.hasPrior).toBe(false)
    expect(comp.sales.total.prior).toBe(0)
    expect(comp.sales.total.delta).toBe(comp.sales.total.current)
    expect(comp.sales.total.deltaPct).toBeNull()
  })

  it('比較PL: その他（繰戻額等＝貸倒引当金戻入）が otherIncome に反映され netIncome に加算される', () => {
    const db = new DbRouter().bookDb(USER)
    seedDataPlane(db)
    const now = '2026-01-01T00:00:00Z'
    const y = db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).returning().all()[0]
    const add = (lines: LineSpec[]) => {
      const e = db
        .insert(journalEntries)
        .values({ fiscalYearId: y.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now })
        .returning()
        .all()[0]
      lines.forEach((l, i) => db.insert(journalLines).values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), amount: l.amount }).run())
    }
    add([{ account: '普通預金', side: 'debit', amount: 100000 }, { account: '売上高', side: 'credit', amount: 100000 }])
    add([{ account: '貸倒引当金', side: 'debit', amount: 7000 }, { account: '貸倒引当金戻入', side: 'credit', amount: 7000 }])
    const comp = comparativeProfitAndLoss(db, y.id, null)
    expect(comp.otherIncome.total.current).toBe(7000) // 戻入が比較PLに表示される（旧実装では欠落）
    expect(comp.netIncome.current).toBe(107000) // 売上100,000 + 戻入7,000
  })

  it('比較試算表: 科目別残高の当期/前期、合計セル', () => {
    const { db, y2025, y2026 } = setupTwoYears()
    const comp = comparativeTrialBalance(db, y2026.id, y2025.id)
    expect(comp.hasPrior).toBe(true)
    const cash = comp.rows.find((r) => r.accountName === '普通預金')!
    // 2026: +330,000 −11,000 = 319,000 / 2025: +200,000 −10,000 = 190,000
    expect(cash.current).toBe(319000)
    expect(cash.prior).toBe(190000)
    expect(cash.delta).toBe(129000)
    expect(comp.totalDebit.current).toBe(trialBalance(db, y2026.id).totalDebit)
    expect(comp.totalDebit.prior).toBe(trialBalance(db, y2025.id).totalDebit)
  })

  it('比較BS: 当期所得・各合計の当期/前期が単年BSに一致', () => {
    const { db, y2025, y2026 } = setupTwoYears()
    const comp = comparativeBalanceSheet(db, y2026.id, y2025.id)
    const cur = balanceSheet(db, y2026.id)
    const pri = balanceSheet(db, y2025.id)
    expect(comp.hasPrior).toBe(true)
    expect(comp.totalAssets.current).toBe(cur.totalAssets)
    expect(comp.totalAssets.prior).toBe(pri.totalAssets)
    expect(comp.netIncome.current).toBe(cur.netIncome) // 314,000
    expect(comp.netIncome.prior).toBe(pri.netIncome) // 182,000
    expect(comp.totalAssets.delta).toBe(cur.totalAssets - pri.totalAssets)
  })
})
