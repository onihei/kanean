import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, fiscalYears, taxCategories } from '../../db/data/schema.js'
import { createManualEntry } from '../../journal/manualEntry.js'
import { createDepartment } from '../../masters/departments.js'
import { listEntries } from '../../journal/entries.js'
import {
  trialBalance,
  generalLedger,
  taxSalesSummary,
  departmentProfitAndLoss,
  taxExcludedProfitAndLoss,
  comparativeProfitAndLoss,
  comparativeTrialBalance,
  comparativeBalanceSheet,
} from '../reports.js'
import {
  trialBalanceCsv,
  journalCsv,
  generalLedgerCsv,
  taxSalesCsv,
  departmentProfitAndLossCsv,
  taxExcludedProfitAndLossCsv,
  comparativeProfitAndLossCsv,
  comparativeTrialBalanceCsv,
  comparativeBalanceSheetCsv,
} from '../csv.js'

let tmp: string
const USER = 'u_csv'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-csv-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): { db: DataDb; fyId: number } {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const fy = db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: 'x' }).returning().all()[0]
  // 摘要にカンマを含めて RFC4180 の引用を検証する。
  createManualEntry(db, {
    fiscalYearId: fy.id,
    entryDate: '2026-03-01',
    description: '売上, 3月分',
    lines: [
      { side: 'debit', accountId: accId(db, '普通預金'), amount: 100000 },
      { side: 'credit', accountId: accId(db, '売上高'), amount: 100000 },
    ],
  })
  return { db, fyId: fy.id }
}

describe('帳票 CSV（F-BOK-4）', () => {
  it('試算表 CSV: ヘッダ・科目行・合計行', () => {
    const { db, fyId } = setup()
    const csv = trialBalanceCsv(trialBalance(db, fyId))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('区分,勘定科目,借方合計,貸方合計,残高')
    expect(lines.some((l) => l.includes('普通預金') && l.includes('100000'))).toBe(true)
    expect(lines[lines.length - 1]).toBe('合計,,100000,100000,')
  })

  it('仕訳帳 CSV: ヘッダ＋明細、カンマ入り摘要は引用される（RFC4180）', () => {
    const { db, fyId } = setup()
    const csv = journalCsv(listEntries(db, fyId))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('仕訳No,日付,摘要,借/貸,勘定科目,補助科目,取引先,部門,借方,貸方,税額')
    expect(csv).toContain('"売上, 3月分"') // カンマ含む → ダブルクォート
    expect(lines).toHaveLength(3) // ヘッダ + 借方 + 貸方
  })

  it('総勘定元帳 CSV: 期首繰越→明細→期末残高', () => {
    const { db, fyId } = setup()
    const csv = generalLedgerCsv(generalLedger(db, fyId, accId(db, '普通預金')))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('日付,摘要,相手科目,借方,貸方,残高')
    expect(lines[1]).toBe(',期首繰越,,,,0')
    expect(lines[lines.length - 1]).toBe(',期末残高,,,,100000')
  })

  it('税区分別課税売上集計 CSV: 明細・合計・税率別課税標準額の各セクション', () => {
    const { db, fyId } = setup()
    // setup の売上（11,000）には 売上高 の既定税区分が付く。明示で 10% 五種を付与した売上を追加。
    const sale10 = db.select().from(taxCategories).where(eq(taxCategories.code, 'SALE_10_C5')).all()[0].id
    createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-04-01',
      lines: [
        { side: 'debit', accountId: accId(db, '現金'), amount: 22000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 22000, taxCategoryId: sale10 },
      ],
    })
    const csv = taxSalesCsv(taxSalesSummary(db, fyId))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('税区分,税率,区分,件数,税込,税抜,税額')
    expect(lines.some((l) => l.startsWith('合計,'))).toBe(true)
    expect(csv).toContain('税率別 課税標準額（税抜・通常売上）')
    expect(lines.some((l) => l.startsWith('10%,'))).toBe(true)
  })

  it('部門別損益計算書 CSV: 部門列ヘッダ・科目行・当期所得行', () => {
    const { db, fyId } = setup()
    const eigyo = createDepartment(db, '営業部')
    createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-04-01',
      lines: [
        { side: 'debit', accountId: accId(db, '旅費交通費'), amount: 5000, departmentId: eigyo },
        { side: 'credit', accountId: accId(db, '現金'), amount: 5000, departmentId: eigyo },
      ],
    })
    const csv = departmentProfitAndLossCsv(departmentProfitAndLoss(db, fyId))
    const lines = csv.split('\r\n')
    // setup の売上は部門なし→未配賦列、追加した旅費は営業部列。
    expect(lines[0]).toBe('区分,科目,営業部,未配賦,合計')
    expect(lines.some((l) => l.startsWith('当期所得（控除前所得金額）,'))).toBe(true)
    expect(lines.some((l) => l.includes('旅費交通費'))).toBe(true)
  })

  it('税抜損益計算書 CSV: 税込・内税・税抜の列ヘッダと当期所得行', () => {
    const { db, fyId } = setup()
    const sale10 = db.select().from(taxCategories).where(eq(taxCategories.code, 'SALE_10_C5')).all()[0].id
    createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-04-01',
      lines: [
        { side: 'debit', accountId: accId(db, '現金'), amount: 22000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 22000, taxCategoryId: sale10 },
      ],
    })
    const csv = taxExcludedProfitAndLossCsv(taxExcludedProfitAndLoss(db, fyId))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('区分,科目,税込,内税,税抜')
    expect(lines.some((l) => l.startsWith('売上（収入）金額,'))).toBe(true)
    expect(lines.some((l) => l.startsWith('当期所得（控除前所得金額）,'))).toBe(true)
  })

  it('比較損益計算書 CSV: 当期/前期/増減/増減率 列ヘッダと当期所得行', () => {
    const { db, fyId } = setup()
    const csv = comparativeProfitAndLossCsv(comparativeProfitAndLoss(db, fyId, null))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('区分,科目,当期,前期,増減,増減率(%)')
    expect(lines.some((l) => l.startsWith('売上（収入）金額,'))).toBe(true)
    expect(lines.some((l) => l.startsWith('当期所得（控除前所得金額）,'))).toBe(true)
  })

  it('比較試算表 CSV: 列ヘッダと借貸合計行', () => {
    const { db, fyId } = setup()
    const csv = comparativeTrialBalanceCsv(comparativeTrialBalance(db, fyId, null))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('区分,勘定科目,当期,前期,増減,増減率(%)')
    expect(lines.some((l) => l.startsWith('借方合計,'))).toBe(true)
    expect(lines.some((l) => l.startsWith('貸方合計,'))).toBe(true)
  })

  it('比較貸借対照表 CSV: 列ヘッダと負債・資本合計行', () => {
    const { db, fyId } = setup()
    const csv = comparativeBalanceSheetCsv(comparativeBalanceSheet(db, fyId, null))
    const lines = csv.split('\r\n')
    expect(lines[0]).toBe('部,区分/科目,当期,前期,増減,増減率(%)')
    expect(lines.some((l) => l.startsWith('負債・資本の部 合計,'))).toBe(true)
  })
})
