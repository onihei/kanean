import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { yen } from '@kanean/shared'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, taxCategories } from '../../db/data/schema.js'
import { buildTaxForecast, TAX_FORECAST_DISCLAIMER } from '../forecast.js'

let tmp: string
const USER = 'u_forecast'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-forecast-'))
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

/** 借)普通預金 / 貸)売上高（税区分＋内税付き）の confirmed 売上仕訳。 */
function addSale(db: DataDb, fyId: number, gross: number, tax: number) {
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fyId, entryDate: '2026-03-01', description: '売上', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '普通預金'), amount: gross }).run()
  db.insert(journalLines)
    .values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '売上高'), amount: gross, taxCategoryId: taxCode(db, 'SALE_10_C5'), taxAmount: tax })
    .run()
}

/** 借)消耗品費 / 貸)普通預金 の confirmed 経費仕訳。 */
function addExpense(db: DataDb, fyId: number, amount: number) {
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fyId, entryDate: '2026-03-15', description: '経費', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '消耗品費'), amount }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '普通預金'), amount }).run()
}

/** 共通 fixture: 上半期に 税込売上330万（内税30万）・経費30万 → ㊸＝300万。 */
function setupHalfYear(): { db: DataDb; fyId: number } {
  const { db, fyId } = setup()
  addSale(db, fyId, 3_300_000, 300_000)
  addExpense(db, fyId, 300_000)
  return { db, fyId }
}

// 「今日」= 2026-06-15（ローカル暦月＝6月 → 経過6ヶ月）。TZ 非依存にするため成分指定で構築。
const JUNE_15 = new Date(2026, 5, 15)

describe('buildTaxForecast — 納税予測（年換算）', () => {
  it('(a) 6ヶ月経過: ㊸300万が600万に年換算され、税額チェーンが年額で再計算される', () => {
    const { db, fyId } = setupHalfYear()
    const r = buildTaxForecast(db, fyId, { now: JUNE_15 })

    expect(r.fiscalYearId).toBe(fyId)
    expect(r.elapsedMonths).toBe(6)
    // 実績: ㊸ 300万 − 青色控除55万 = ㊺ 245万。売上（収入金額）は税込330万。
    expect(r.actual.businessIncome).toBe(2_450_000)
    expect(r.actual.sales).toBe(3_300_000)

    // 年換算: ㊸ 600万 → 青色控除55万（定額のまま）→ ㊺ 545万。
    expect(r.projected.businessIncome).toBe(5_450_000)
    // 課税所得 = floor1000(5,450,000 − 基礎控除480,000) = 4,970,000。
    expect(r.projected.taxableIncome).toBe(4_970_000)
    // 所得税 566,500（20%区分）＋復興税 floor(566,500×0.021)=11,896 = 578,396。
    expect(r.projected.incomeTax).toBe(578_396)
    // 住民税概算 = 4,970,000×10% + 5,000 = 502,000。
    expect(r.projected.residentTax).toBe(502_000)
    // 個人事業税概算 = (6,000,000 − 2,900,000)×5% = 155,000（課税標準は青色控除前㊸）。
    expect(r.projected.businessTax).toBe(155_000)
    // 消費税: 税抜300万を年換算600万 → 第5種 簡易課税で 国税234,000＋地方66,000 = 300,000。
    expect(r.projected.consumptionTax).toBe(300_000)
    expect(r.projected.totalTax).toBe(578_396 + 502_000 + 155_000 + 300_000) // 1,535,396

    expect(r.whatIf).toBeUndefined()
    expect(r.disclaimer).toBe(TAX_FORECAST_DISCLAIMER)
    expect(r.disclaimer).toContain('参考値')
  })

  it('(a) 12ヶ月経過（年度末以降）は年換算が恒等＝実績と一致する', () => {
    const { db, fyId } = setupHalfYear()
    const r = buildTaxForecast(db, fyId, { now: new Date(2027, 1, 1) }) // 年度超過 → 12 にクランプ
    expect(r.elapsedMonths).toBe(12)
    expect(r.projected.businessIncome).toBe(r.actual.businessIncome)
  })

  it('(b) extraExpense で所得系の税額が下がり delta が負になる（消費税は不変）', () => {
    const { db, fyId } = setupHalfYear()
    const r = buildTaxForecast(db, fyId, { now: JUNE_15, extraExpense: yen(1_000_000) })

    // 基準（projected）は what-if の影響を受けない。
    expect(r.projected.totalTax).toBe(1_535_396)

    const w = r.whatIf!
    expect(w.extraExpense).toBe(1_000_000)
    expect(w.extraDeduction).toBe(0)
    // ㊸ 600万 − 100万 = 500万 → ㊺ 445万 → 課税所得 397万。
    expect(w.businessIncome).toBe(4_450_000)
    expect(w.taxableIncome).toBe(3_970_000)
    // 所得税 366,500 ＋ 復興税 7,696 = 374,196。
    expect(w.incomeTax).toBe(374_196)
    expect(w.residentTax).toBe(402_000) // 3,970,000×10% + 5,000
    expect(w.businessTax).toBe(105_000) // (5,000,000 − 2,900,000)×5%
    expect(w.consumptionTax).toBe(300_000) // 簡易課税は売上のみ依存＝経費追加で不変
    expect(w.totalTax).toBe(374_196 + 402_000 + 105_000 + 300_000) // 1,181,196
    expect(w.delta).toBe(1_181_196 - 1_535_396) // −354,200
    expect(w.delta).toBeLessThan(0)
  })

  it('(b) extraDeduction は所得控除にのみ効く（事業税・消費税は不変）', () => {
    const { db, fyId } = setupHalfYear()
    const r = buildTaxForecast(db, fyId, { now: JUNE_15, extraDeduction: yen(500_000) })

    const w = r.whatIf!
    expect(w.extraExpense).toBe(0)
    expect(w.extraDeduction).toBe(500_000)
    expect(w.businessIncome).toBe(5_450_000) // ㊺ は変わらない
    expect(w.taxableIncome).toBe(4_470_000) // floor1000(5,450,000 − 980,000)
    expect(w.incomeTax).toBe(476_296) // 466,500 + floor(466,500×0.021)=9,796
    expect(w.residentTax).toBe(452_000) // 4,470,000×10% + 5,000
    expect(w.businessTax).toBe(155_000) // 所得控除は事業税の課税標準に影響しない
    expect(w.consumptionTax).toBe(300_000)
    expect(w.delta).toBe(476_296 + 452_000 + 155_000 + 300_000 - 1_535_396) // −152,100
    expect(w.delta).toBeLessThan(0)
  })

  it('(c) 存在しない会計年度は throw（HTTP 層が 400 に変換する契約）', () => {
    const db = new DbRouter().bookDb(USER)
    seedDataPlane(db)
    expect(() => buildTaxForecast(db, 999)).toThrow(/会計年度/)
  })

  it('仕訳が無い年度は全額0の予測（免責は付く）', () => {
    const { db, fyId } = setup()
    const r = buildTaxForecast(db, fyId, { now: JUNE_15 })
    expect(r.actual.businessIncome).toBe(0)
    expect(r.projected.totalTax).toBe(0)
    expect(r.disclaimer).toContain('税理士')
  })
})
