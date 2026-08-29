import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { Hono } from 'hono'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, taxCategories } from '../../db/data/schema.js'
import { forecastRoutes } from '../forecast.js'
import type { BookVariables } from '../../books/middleware.js'
import type { TaxForecast } from '../../taxreturn/forecast.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-forecastroute-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

/** withBook 相当のスタブ（bookId を固定注入）で forecastRoutes をマウントしたテストアプリ。 */
function setup(withYear = true): { app: Hono<{ Variables: BookVariables }>; db: DataDb } {
  const router = new DbRouter()
  const db = router.bookDb('u1')
  seedDataPlane(db)
  if (withYear) {
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  }
  const app = new Hono<{ Variables: BookVariables }>()
  app.use('*', (c, next) => {
    c.set('bookId', 'u1')
    return next()
  })
  app.route('/api', forecastRoutes(router))
  return { app, db }
}

/** 借)普通預金 / 貸)売上高（10%課税・内税付き）の confirmed 売上仕訳。 */
function addSale(db: DataDb, gross: number, tax: number) {
  const fy = db.select().from(fiscalYears).all()[0]
  const e = db
    .insert(journalEntries)
    .values({ fiscalYearId: fy.id, entryDate: '2026-02-01', description: '売上', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  const saleTaxId = db.select().from(taxCategories).where(eq(taxCategories.code, 'SALE_10_C5')).all()[0].id
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, '普通預金'), amount: gross }).run()
  db.insert(journalLines)
    .values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '売上高'), amount: gross, taxCategoryId: saleTaxId, taxAmount: tax })
    .run()
}

describe('GET /api/tax-forecast', () => {
  it('open 年度が無ければ 200 + forecast: null（他の参照系 withOpenYear と同じ契約）', async () => {
    const { app } = setup(false)
    const res = await app.request('/api/tax-forecast')
    expect(res.status).toBe(200)
    expect(((await res.json()) as { forecast: unknown }).forecast).toBeNull()
  })

  it('予測を返す（免責付き・what-if なし）', async () => {
    const { app, db } = setup()
    addSale(db, 1_100_000, 100_000)
    const res = await app.request('/api/tax-forecast')
    expect(res.status).toBe(200)
    const { forecast } = (await res.json()) as { forecast: TaxForecast }
    expect(forecast.actual.sales).toBe(1_100_000)
    expect(forecast.elapsedMonths).toBeGreaterThanOrEqual(1)
    expect(forecast.elapsedMonths).toBeLessThanOrEqual(12)
    expect(forecast.projected.totalTax).toBeGreaterThanOrEqual(0)
    expect(forecast.disclaimer).toContain('参考値')
    expect(forecast.whatIf).toBeUndefined()
  })

  it('extraExpense / extraDeduction 指定で whatIf が付く（空文字は未指定扱い）', async () => {
    const { app, db } = setup()
    addSale(db, 11_000_000, 1_000_000)
    const res = await app.request('/api/tax-forecast?extraExpense=1000000&extraDeduction=')
    expect(res.status).toBe(200)
    const { forecast } = (await res.json()) as { forecast: TaxForecast }
    expect(forecast.whatIf).toBeDefined()
    expect(forecast.whatIf!.extraExpense).toBe(1_000_000)
    expect(forecast.whatIf!.extraDeduction).toBe(0)
    expect(forecast.whatIf!.delta).toBeLessThan(0) // 経費追加で税負担は下がる
  })

  it('不正なクエリ（非整数・負・小数・指数表記）は 400', async () => {
    const { app } = setup()
    for (const q of ['extraExpense=abc', 'extraExpense=-1', 'extraExpense=1.5', 'extraDeduction=1e3']) {
      const res = await app.request(`/api/tax-forecast?${q}`)
      expect(res.status).toBe(400)
      expect(((await res.json()) as { error: string }).error).toContain('整数')
    }
  })
})
