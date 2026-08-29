import { describe, it, expect, beforeAll, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { sql } from 'drizzle-orm'
import { DbRouter, migrateControlDb } from '../router.js'
import { controlDbPath, bookDbPath } from '../../config.js'
import { seedDataPlane } from '../data/seed.js'
import {
  taxCategories,
  fiscalYears,
  journalEntries,
  journalLines,
  accountCategories,
  statementItems,
  accounts,
} from '../data/schema.js'
import { books } from '../control/schema.js'

let tmp: string

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-test-'))
  process.env.DATA_DIR = tmp
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('migration + DbRouter（control/data 物理分離）', () => {
  it('control plane をマイグレートし users を挿入できる', () => {
    migrateControlDb()
    expect(fs.existsSync(controlDbPath())).toBe(true)

    const router = new DbRouter()
    const now = '2026-01-01T00:00:00Z'
    router
      .controlDb()
      .insert(books)
      .values({ id: 'u_001', name: 'テスト帳簿', createdAt: now, updatedAt: now })
      .run()
    const rows = router.controlDb().select().from(books).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].id).toBe('u_001')
  })

  it('userDb 初回オープンで data plane が最新スキーマになる', () => {
    const router = new DbRouter()
    const db = router.bookDb('u_001')
    expect(fs.existsSync(bookDbPath('u_001'))).toBe(true)
    // テーブルが存在し空である
    const [{ count }] = db.select({ count: sql<number>`count(*)` }).from(fiscalYears).all()
    expect(count).toBe(0)
  })

  it('seed で税区分マスタ14件が入る（冪等）', () => {
    const db = new DbRouter().bookDb('u_001')
    seedDataPlane(db)
    seedDataPlane(db) // 2回目は何もしない
    const cats = db.select().from(taxCategories).all()
    expect(cats).toHaveLength(14)
    expect(cats.find((c) => c.code === 'SALE_10_C5')?.simplifiedCategory).toBe('第5種')
  })

  it('貸借一致の複合仕訳を登録できる', () => {
    const db = new DbRouter().bookDb('u_001')
    const now = '2026-03-01T00:00:00Z'
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
    const fy = db.select().from(fiscalYears).all()[0]

    // 5階層の最小チェーンを作る（分類→決算書科目→勘定科目）。FK整合の確認も兼ねる。
    const cat = db.insert(accountCategories).values({ reportType: 'BS', section: '流動資産', name: '現金及び預金' }).returning().all()[0]
    const item = db.insert(statementItems).values({ categoryId: cat.id, name: '普通預金' }).returning().all()[0]
    const acc = (name: string, nb: string) =>
      db.insert(accounts).values({ statementItemId: item.id, name, normalBalance: nb, createdAt: now, updatedAt: now }).returning().all()[0]
    const bank = acc('普通預金', 'debit')
    const owner = acc('事業主貸', 'debit')
    const sales = acc('売上高', 'credit')

    const entry = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: '2026-03-01', description: '売上(源泉あり)', source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now })
      .returning()
      .all()[0]

    // 借)普通預金99,790 借)事業主貸10,210 / 貸)売上110,000
    db.insert(journalLines).values([
      { entryId: entry.id, lineNo: 1, side: 'debit', accountId: bank.id, amount: 99_790, prorationApplied: false },
      { entryId: entry.id, lineNo: 2, side: 'debit', accountId: owner.id, amount: 10_210, prorationApplied: false },
      { entryId: entry.id, lineNo: 3, side: 'credit', accountId: sales.id, amount: 110_000, prorationApplied: false },
    ]).run()

    const [{ debit }] = db.select({ debit: sql<number>`coalesce(sum(amount),0)` }).from(journalLines).where(sql`side = 'debit'`).all()
    const [{ credit }] = db.select({ credit: sql<number>`coalesce(sum(amount),0)` }).from(journalLines).where(sql`side = 'credit'`).all()
    expect(debit).toBe(110_000)
    expect(credit).toBe(110_000)
  })
})
