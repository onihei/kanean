import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, openingBalances } from '../../db/data/schema.js'
import { profitAndLoss } from '../reports.js'
import { buildBlueBalanceSheet, type BsFormRow } from '../blueBalanceSheet.js'

let tmp: string
const USER = 'u_blue_bs'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-bluebs-'))
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
  const now = '2026-01-01T00:00:00Z'
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
  const fy = db.select().from(fiscalYears).all()[0]
  const ob = (account: string, side: 'debit' | 'credit', amount: number) =>
    db.insert(openingBalances).values({ fiscalYearId: fy.id, accountId: accId(db, account), side, amount }).run()
  const addEntry = (lines: LineSpec[]) => {
    const entry = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now })
      .returning()
      .all()[0]
    lines.forEach((l, i) =>
      db.insert(journalLines).values({ entryId: entry.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), amount: l.amount }).run(),
    )
  }
  return { db, fyId: fy.id, ob, addEntry }
}

const findRow = (rows: BsFormRow[], row: number): BsFormRow | undefined => rows.find((r) => r.row === row)

describe('buildBlueBalanceSheet（貸借対照表 様式組成）', () => {
  it('期首=opening_balances / 期末=残高 を様式行へ寄せ、貸借一致する', () => {
    const { db, fyId, ob, addEntry } = setup()
    // 期首: 普通預金150万 + 車両200万 = 借入金50万 + 元入金300万（貸借一致）
    ob('普通預金', 'debit', 1_500_000)
    ob('車両運搬具', 'debit', 2_000_000)
    ob('借入金', 'credit', 500_000)
    ob('元入金', 'credit', 3_000_000)
    // 当期: 売上500万・減価償却514,919（間接法）・仕入30万→買掛金
    addEntry([{ account: '普通預金', side: 'debit', amount: 5_000_000 }, { account: '売上高', side: 'credit', amount: 5_000_000 }])
    addEntry([{ account: '減価償却費', side: 'debit', amount: 514_919 }, { account: '減価償却累計額', side: 'credit', amount: 514_919 }])
    addEntry([{ account: '仕入高', side: 'debit', amount: 300_000 }, { account: '買掛金', side: 'credit', amount: 300_000 }])

    const bs = buildBlueBalanceSheet(db, fyId)
    const netIncome = profitAndLoss(db, fyId).netIncome

    // 普通預金 → その他の預金(行4): 期首150万 / 期末650万
    const otherDeposit = findRow(bs.assets, 4)
    expect(otherDeposit?.opening).toBe(1_500_000)
    expect(otherDeposit?.closing).toBe(6_500_000)
    expect(otherDeposit?.label).toBeUndefined() // 固定行（印字済）

    // 車両運搬具(行14): 期首=期末=200万
    expect(findRow(bs.assets, 14)?.closing).toBe(2_000_000)

    // 減価償却累計額（評価勘定）は資産の空欄行に負値で計上（間接法控除）
    const contra = bs.assets.find((r) => r.label === '減価償却累計額')
    expect(contra?.closing).toBe(-514_919)

    // 借入金(行3): 期首=期末=50万、元入金(行23): 300万
    expect(findRow(bs.liabilities, 3)?.closing).toBe(500_000)
    expect(findRow(bs.liabilities, 23)?.closing).toBe(3_000_000)
    // 買掛金(行2): 期末30万（期首なし）
    expect(findRow(bs.liabilities, 2)?.closing).toBe(300_000)

    // 青色申告特別控除前の所得金額(行24) = netIncome（期末のみ）
    expect(bs.incomeBeforeDeduction).toBe(netIncome)
    expect(findRow(bs.liabilities, 24)?.closing).toBe(netIncome)
    expect(findRow(bs.liabilities, 24)?.opening).toBe(0)

    // 合計: 期首=350万、期末は資産=負債資本で一致（貸借一致）
    expect(bs.assetTotal.opening).toBe(3_500_000)
    expect(bs.liabTotal.opening).toBe(3_500_000)
    expect(bs.assetTotal.closing).toBe(bs.liabTotal.closing)
    expect(bs.balanced).toBe(true)
    // 期末資産 = 普通650万 + 車両200万 − 累計514,919 = 7,985,081
    expect(bs.assetTotal.closing).toBe(7_985_081)
  })

  it('期首・期末ともゼロの勘定は行に出さない', () => {
    const { db, fyId, ob, addEntry } = setup()
    ob('普通預金', 'debit', 1_000_000)
    ob('元入金', 'credit', 1_000_000)
    addEntry([{ account: '普通預金', side: 'debit', amount: 100_000 }, { account: '売上高', side: 'credit', amount: 100_000 }])
    const bs = buildBlueBalanceSheet(db, fyId)
    // 現金(行1)などは未使用なので資産行に存在しない
    expect(findRow(bs.assets, 1)).toBeUndefined()
    expect(bs.balanced).toBe(true)
  })
})
