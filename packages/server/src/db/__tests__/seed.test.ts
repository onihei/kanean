import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter } from '../router.js'
import { seedDataPlane } from '../data/seed.js'
import { accountCategories, statementItems, accounts, subAccounts, taxCategories } from '../data/schema.js'

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-seed-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function seeded() {
  const db = new DbRouter().bookDb('u_seed')
  seedDataPlane(db)
  return db
}

describe('seedAccountChart（標準勘定科目）', () => {
  it('5階層を構築（分類23件・冪等）', () => {
    const db = seeded()
    seedDataPlane(db) // 2回目は何もしない
    expect(db.select().from(accountCategories).all()).toHaveLength(23)
    expect(db.select().from(accounts).all().length).toBeGreaterThan(50)
  })

  it('普通預金は初期補助科目なし（連携サービス登録時に作成）', () => {
    const db = seeded()
    const acc = db.select().from(accounts).where(eq(accounts.name, '普通預金')).all()[0]
    const subs = db.select().from(subAccounts).where(eq(subAccounts.accountId, acc.id)).all()
    expect(subs).toHaveLength(0)
  })

  it('未払金は初期補助科目なし（連携サービス登録時にチャネル別を作成）', () => {
    const db = seeded()
    const acc = db.select().from(accounts).where(eq(accounts.name, '未払金')).all()[0]
    const subs = db.select().from(subAccounts).where(eq(subAccounts.accountId, acc.id)).all()
    expect(subs).toHaveLength(0)
  })

  it('normal_balance: 評価勘定・事業主貸・消費税の向き', () => {
    const db = seeded()
    const nb = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).all()[0]?.normalBalance
    expect(nb('普通預金')).toBe('debit')
    expect(nb('売上高')).toBe('credit')
    expect(nb('減価償却累計額')).toBe('credit') // 資産の評価勘定
    expect(nb('事業主貸')).toBe('debit')
    expect(nb('事業主借')).toBe('credit')
    expect(nb('仮受消費税')).toBe('credit')
    expect(nb('仮払消費税')).toBe('debit')
    expect(nb('売上値引・返品')).toBe('debit') // 売上の控除
    expect(nb('貸倒引当金戻入')).toBe('credit')
  })

  it('既定税区分は現行標準10%に寄せる: 売上高=SALE_10_C5 / 水道光熱費=PUR_10', () => {
    const db = seeded()
    const code = (accName: string) => {
      const a = db.select().from(accounts).where(eq(accounts.name, accName)).all()[0]
      if (!a?.defaultTaxCategoryId) return null
      return db.select().from(taxCategories).where(eq(taxCategories.id, a.defaultTaxCategoryId)).all()[0]?.code
    }
    expect(code('売上高')).toBe('SALE_10_C5')
    expect(code('水道光熱費')).toBe('PUR_10')
  })

  it('福利厚生費の決算書科目に2勘定科目（福利厚生費/法定福利費）', () => {
    const db = seeded()
    const item = db.select().from(statementItems).where(eq(statementItems.name, '福利厚生費')).all()[0]
    const accs = db.select().from(accounts).where(eq(accounts.statementItemId, item.id)).all()
    expect(accs.map((a) => a.name).sort()).toEqual(['法定福利費', '福利厚生費'].sort())
  })

  it('statement_line_code: 主要決算書科目に AOIRO.PL.* を付与（3段集計の宛先）', () => {
    const db = seeded()
    const lc = (name: string) => db.select().from(statementItems).where(eq(statementItems.name, name)).all()[0]?.statementLineCode
    expect(lc('売上（収入）金額')).toBe('AOIRO.PL.SALES')
    expect(lc('仕入金額')).toBe('AOIRO.PL.PURCHASE')
    expect(lc('期末商品（製品）棚卸高')).toBe('AOIRO.PL.CLOSE_STOCK')
    expect(lc('減価償却費')).toBe('AOIRO.PL.EXP_DEP')
    expect(lc('地代家賃')).toBe('AOIRO.PL.EXP_RENT')
    expect(lc('給料賃金')).toBe('AOIRO.PL.EXP_SALARY')
    expect(lc('雑費')).toBe('AOIRO.PL.EXP_MISC')
    expect(lc('専従者給与')).toBe('AOIRO.PL.SENJU')
    expect(lc('貸倒引当金戻入')).toBe('AOIRO.PL.RESERVE_BACK')
  })

  it('statement_line_code: 空欄行候補（車両費・繰延資産償却 等）は NULL のまま（集計側で動的割当）', () => {
    const db = seeded()
    const lc = (name: string) => db.select().from(statementItems).where(eq(statementItems.name, name)).all()[0]?.statementLineCode
    expect(lc('車両費')).toBeNull()
    expect(lc('繰延資産償却')).toBeNull()
    expect(lc('固定資産除却損')).toBeNull()
  })
})
