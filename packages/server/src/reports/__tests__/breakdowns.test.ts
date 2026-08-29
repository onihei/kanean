import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import {
  fiscalYears,
  journalEntries,
  journalLines,
  accounts,
  subAccounts,
  counterparties,
  fixedAssets,
  depreciationEntries,
} from '../../db/data/schema.js'
import { buildBlueReturnStatement } from '../blueReturnStatement.js'
import { createFixedAsset } from '../../fixedAssets/register.js'
import { postDepreciation } from '../../fixedAssets/posting.js'
import {
  depreciationBreakdown,
  salaryBreakdown,
  rentBreakdown,
  senjuBreakdown,
  monthlySalesPurchase,
  reserveAllowanceCalc,
} from '../breakdowns.js'

let tmp: string
const USER = 'u_breakdowns'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-breakdowns-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}
function expenseBox(db: DataDb, fyId: number, code: string): number {
  const { pl } = buildBlueReturnStatement(db, fyId)
  return pl.expenses.find((b) => b.code === code)!.amount
}

function setup() {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const now = '2026-01-01T00:00:00Z'
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
  const fy = db.select().from(fiscalYears).all()[0]
  const add = (date: string, lines: { account: string; side: 'debit' | 'credit'; amount: number; sub?: number; cp?: number }[]) => {
    const e = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: date, description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now })
      .returning()
      .all()[0]
    lines.forEach((l, i) =>
      db
        .insert(journalLines)
        .values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), subAccountId: l.sub ?? null, counterpartyId: l.cp ?? null, amount: l.amount })
        .run(),
    )
  }
  const mkSub = (accountName: string, name: string): number => {
    const now2 = '2026-01-01T00:00:00Z'
    return db.insert(subAccounts).values({ accountId: accId(db, accountName), name, isActive: true, sortOrder: 0, createdAt: now2, updatedAt: now2 }).returning().all()[0].id
  }
  const mkCp = (name: string): number => {
    const now2 = '2026-01-01T00:00:00Z'
    return db.insert(counterparties).values({ name, isActive: true, createdAt: now2, updatedAt: now2 }).returning().all()[0].id
  }
  return { db, fyId: fy.id, add, mkSub, mkCp }
}

describe('内訳ページ（breakdowns / form-mapping §1.3〜§1.7）', () => {
  it('給料賃金内訳: 補助科目別に集計し、合計が損益⑳に一致', () => {
    const { db, fyId, add, mkSub } = setup()
    const taro = mkSub('給料賃金', '田中太郎')
    const hanako = mkSub('給料賃金', '佐藤花子')
    add('2026-06-25', [{ account: '給料賃金', side: 'debit', amount: 300_000, sub: taro }, { account: '普通預金', side: 'credit', amount: 300_000 }])
    add('2026-07-25', [{ account: '給料賃金', side: 'debit', amount: 200_000, sub: hanako }, { account: '普通預金', side: 'credit', amount: 200_000 }])
    add('2026-08-25', [{ account: '給料賃金', side: 'debit', amount: 50_000 }, { account: '普通預金', side: 'credit', amount: 50_000 }]) // 補助科目なし

    const bd = salaryBreakdown(db, fyId)
    expect(bd.rows.find((r) => r.key === taro)?.amount).toBe(300_000)
    expect(bd.rows.find((r) => r.key === hanako)?.amount).toBe(200_000)
    expect(bd.rows.find((r) => r.key === null)?.name).toBe('（補助科目なし）')
    expect(bd.rows.find((r) => r.key === null)?.amount).toBe(50_000)
    expect(bd.total).toBe(550_000)
    expect(bd.total).toBe(expenseBox(db, fyId, 'AOIRO.PL.EXP_SALARY')) // ⑳連動
  })

  it('地代家賃内訳: 取引先別に集計し、合計が損益㉓に一致', () => {
    const { db, fyId, add, mkCp } = setup()
    const owner = mkCp('オーナー不動産')
    add('2026-01-10', [{ account: '地代家賃', side: 'debit', amount: 120_000, cp: owner }, { account: '普通預金', side: 'credit', amount: 120_000 }])
    add('2026-02-10', [{ account: '地代家賃', side: 'debit', amount: 120_000, cp: owner }, { account: '普通預金', side: 'credit', amount: 120_000 }])

    const bd = rentBreakdown(db, fyId)
    expect(bd.rows.find((r) => r.key === owner)?.name).toBe('オーナー不動産')
    expect(bd.rows.find((r) => r.key === owner)?.amount).toBe(240_000)
    expect(bd.total).toBe(240_000)
    expect(bd.total).toBe(expenseBox(db, fyId, 'AOIRO.PL.EXP_RENT')) // ㉓連動
  })

  it('専従者給与内訳: 合計が損益の専従者に一致', () => {
    const { db, fyId, add, mkSub } = setup()
    const senjuPerson = mkSub('専従者給与', '配偶者')
    add('2026-06-25', [{ account: '専従者給与', side: 'debit', amount: 960_000, sub: senjuPerson }, { account: '普通預金', side: 'credit', amount: 960_000 }])

    const bd = senjuBreakdown(db, fyId)
    expect(bd.total).toBe(960_000)
    const { pl } = buildBlueReturnStatement(db, fyId)
    expect(bd.total).toBe(pl.senju.amount)
  })

  it('貸倒引当金繰入額の計算: ②=売掛金+受取手形・③=floor(②×5.5%)・⑤=RESERVE_IN（§1.8）', () => {
    const { db, fyId, add } = setup()
    add('2026-11-30', [{ account: '売掛金', side: 'debit', amount: 1_000_000 }, { account: '売上高', side: 'credit', amount: 1_000_000 }])
    add('2026-11-30', [{ account: '受取手形', side: 'debit', amount: 100_001 }, { account: '売上高', side: 'credit', amount: 100_001 }])
    add('2026-12-31', [{ account: '貸倒引当金繰入', side: 'debit', amount: 60_000 }, { account: '貸倒引当金', side: 'credit', amount: 60_000 }])

    const rc = reserveAllowanceCalc(db, fyId)
    expect(rc.individual).toBe(0) // ① 未モデル化
    expect(rc.grossReceivables).toBe(1_100_001) // ② 売掛金+受取手形 期末
    expect(rc.limit).toBe(60_500) // ③ floor(1,100,001 × 5.5% = 60,500.055)
    expect(rc.lumpReserve).toBe(60_000) // ④ = ⑤ − ①
    expect(rc.total).toBe(60_000) // ⑤ = RESERVE_IN 実績
    const { pl } = buildBlueReturnStatement(db, fyId)
    expect(rc.total).toBe(pl.reserveIn.amount) // ⑤ == 損益 貸倒引当金繰入
  })

  it('貸倒引当金繰入額の計算: 繰入なし（⑤=0）でも例外なく 0 を返す', () => {
    const { db, fyId, add } = setup()
    add('2026-11-30', [{ account: '売掛金', side: 'debit', amount: 500_000 }, { account: '売上高', side: 'credit', amount: 500_000 }])
    const rc = reserveAllowanceCalc(db, fyId)
    expect(rc.total).toBe(0) // ⑤ 繰入なし
    expect(rc.grossReceivables).toBe(500_000) // ② は債権があれば算出される
    expect(rc.limit).toBe(27_500) // ③ = 500,000 × 5.5%
  })

  it('減価償却内訳: 必要経費算入額合計が損益⑱に一致（depreciation_entries 基準）', () => {
    const { db, fyId, add } = setup()
    const now = '2026-01-01T00:00:00Z'
    // 固定資産2件 + 当年度の depreciation_entries（businessAmount は事業分）。
    const a1 = db.insert(fixedAssets).values({ name: 'PC', acquisitionCost: 300_000, depreciationMethod: 'straight_line', usefulLife: 4, depreciationRate: 0.25, businessUseRatio: 100, includeInBlueReturn: true, status: 'active', createdAt: now, updatedAt: now }).returning().all()[0]
    const a2 = db.insert(fixedAssets).values({ name: '車両', acquisitionCost: 2_000_000, depreciationMethod: 'straight_line', usefulLife: 6, depreciationRate: 0.167, businessUseRatio: 80, includeInBlueReturn: true, status: 'active', createdAt: now, updatedAt: now }).returning().all()[0]
    db.insert(depreciationEntries).values({ fixedAssetId: a1.id, fiscalYearId: fyId, openingBookValue: 300_000, depreciationAmount: 75_000, businessAmount: 75_000, closingBookValue: 225_000 }).run()
    db.insert(depreciationEntries).values({ fixedAssetId: a2.id, fiscalYearId: fyId, openingBookValue: 2_000_000, depreciationAmount: 334_000, businessAmount: 267_200, closingBookValue: 1_666_000 }).run()
    // 損益⑱に反映される 減価償却費（事業分のみ。実際の postDepreciation と同じ）。
    add('2026-12-31', [
      { account: '減価償却費', side: 'debit', amount: 75_000 + 267_200 },
      { account: '事業主貸', side: 'debit', amount: 334_000 - 267_200 },
      { account: '減価償却累計額', side: 'credit', amount: 75_000 + 334_000 },
    ])

    const bd = depreciationBreakdown(db, fyId)
    expect(bd.rows).toHaveLength(2)
    expect(bd.depreciationTotal).toBe(409_000) // 75,000 + 334,000（普通償却費の全額）
    expect(bd.businessAmountTotal).toBe(342_200) // 75,000 + 267,200（必要経費算入額）
    expect(bd.businessAmountTotal).toBe(expenseBox(db, fyId, 'AOIRO.PL.EXP_DEP')) // ⑱連動
  })

  it('減価償却内訳: 実 postDepreciation 起票後も businessAmountTotal == ⑱（実カップリング回帰）', () => {
    const { db, fyId } = setup()
    // 事業利用80%の straight_line 資産を登録し、当年度の償却仕訳を実際に起票する。
    createFixedAsset(db, { name: '撮影機材', acquisitionCost: 1_200_000, depreciationMethod: 'straight_line', usefulLife: 5, depreciationRate: 0.2, businessUseRatio: 80, acquiredDate: '2026-01-10', businessStartDate: '2026-01-10' })
    const posted = postDepreciation(db, fyId)
    expect(posted.posted).toBeGreaterThan(0)

    const bd = depreciationBreakdown(db, fyId)
    expect(bd.rows.length).toBeGreaterThan(0)
    // posting.ts が business_amount を減価償却費へ計上する実経路を通しても⑱と一致する。
    expect(bd.businessAmountTotal).toBe(expenseBox(db, fyId, 'AOIRO.PL.EXP_DEP'))
    expect(bd.businessAmountTotal).toBe(posted.totalBusinessAmount)
  })

  it('月別売上仕入: 月別集計し、年計が ①売上・③仕入 に一致（値引も符号反映）', () => {
    const { db, fyId, add } = setup()
    add('2026-03-15', [{ account: '普通預金', side: 'debit', amount: 500_000 }, { account: '売上高', side: 'credit', amount: 500_000 }])
    add('2026-03-20', [{ account: '売上値引・返品', side: 'debit', amount: 20_000 }, { account: '普通預金', side: 'credit', amount: 20_000 }]) // 3月の値引
    add('2026-09-15', [{ account: '普通預金', side: 'debit', amount: 800_000 }, { account: '売上高', side: 'credit', amount: 800_000 }])
    add('2026-04-10', [{ account: '仕入高', side: 'debit', amount: 300_000 }, { account: '普通預金', side: 'credit', amount: 300_000 }])

    const m = monthlySalesPurchase(db, fyId)
    expect(m.rows).toHaveLength(12)
    expect(m.rows[2].sales).toBe(480_000) // 3月 = 500,000 − 値引20,000
    expect(m.rows[8].sales).toBe(800_000) // 9月
    expect(m.rows[3].purchases).toBe(300_000) // 4月
    expect(m.salesTotal).toBe(1_280_000)
    expect(m.purchasesTotal).toBe(300_000)
    // 年計連動。
    const { pl } = buildBlueReturnStatement(db, fyId)
    expect(m.salesTotal).toBe(pl.sales.amount) // ①
    expect(m.purchasesTotal).toBe(pl.purchase.amount) // ③
  })

  it('空データ: 全内訳が空配列・合計0で例外を投げない', () => {
    const { db, fyId } = setup()
    expect(depreciationBreakdown(db, fyId).businessAmountTotal).toBe(0)
    expect(salaryBreakdown(db, fyId).total).toBe(0)
    expect(rentBreakdown(db, fyId).total).toBe(0)
    expect(senjuBreakdown(db, fyId).total).toBe(0)
    expect(monthlySalesPurchase(db, fyId).salesTotal).toBe(0)
  })
})
