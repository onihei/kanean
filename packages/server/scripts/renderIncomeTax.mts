/**
 * 確定申告書PDF 較正用: サンプルデータで第一表・第二表を /tmp/incometax.pdf に出力。
 * 使い方: pnpm -s exec tsx scripts/renderIncomeTax.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../src/db/router.js'
import { seedDataPlane } from '../src/db/data/seed.js'
import { accounts, businessSettings, counterparties, fiscalYears, journalEntries, journalLines, subAccounts, taxReturnInputs } from '../src/db/data/schema.js'
import { renderIncomeTaxReturn } from '../src/pdf/incomeTaxPdf.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-it-'))
process.env.DATA_DIR = tmp
const db: DataDb = new DbRouter().userDb('u_it')
seedDataPlane(db)
const now = '2026-01-01T00:00:00Z'
db.insert(businessSettings).values({ businessName: '山田デザイン事務所', ownerName: '山田太郎', createdAt: now, updatedAt: now }).run()
db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
const fy = db.select().from(fiscalYears).all()[0]
const accId = (n: string) => db.select().from(accounts).where(eq(accounts.name, n)).all()[0].id
const add = (lines: { account: string; side: 'debit' | 'credit'; amount: number; sub?: number; cp?: number }[]) => {
  const e = db.insert(journalEntries).values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }).returning().all()[0]
  lines.forEach((l, i) => db.insert(journalLines).values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(l.account), subAccountId: l.sub ?? null, counterpartyId: l.cp ?? null, amount: l.amount }).run())
}
const cp = db.insert(counterparties).values({ name: '株式会社クライアントA', createdAt: now, updatedAt: now }).returning().all()[0].id
// 源泉所得税 補助科目は seed 済みなら再利用（集計は事業主貸/源泉所得税 を name で参照）。
const existing = db.select().from(subAccounts).where(eq(subAccounts.accountId, accId('事業主貸'))).all().find((s) => s.name === '源泉所得税')
const whSub = existing?.id ?? db.insert(subAccounts).values({ accountId: accId('事業主貸'), name: '源泉所得税', createdAt: now, updatedAt: now }).returning().all()[0].id

// 通常売上 + 経費
add([{ account: '普通預金', side: 'debit', amount: 5_000_000 }, { account: '売上高', side: 'credit', amount: 5_000_000 }])
add([{ account: '水道光熱費', side: 'debit', amount: 200_000 }, { account: '普通預金', side: 'credit', amount: 200_000 }])
add([{ account: '通信費', side: 'debit', amount: 150_000 }, { account: '普通預金', side: 'credit', amount: 150_000 }])
// 源泉あり売上（第二表 所得の内訳に出る）: 100万・源泉102,100
add([
  { account: '普通預金', side: 'debit', amount: 897_900 },
  { account: '事業主貸', side: 'debit', amount: 102_100, sub: whSub, cp },
  { account: '売上高', side: 'credit', amount: 1_000_000, cp },
])
// 所得控除入力
db.insert(taxReturnInputs).values({ fiscalYearId: fy.id, basicDeduction: 480_000, socialInsurance: 600_000, lifeInsurance: 80_000, medical: 0, spouseDependents: 380_000, otherDeductions: 0, estimatedPrepaid: 0, createdAt: now, updatedAt: now }).run()

const bytes = await renderIncomeTaxReturn(db, fy.id)
fs.writeFileSync('/tmp/incometax.pdf', bytes)
console.log(`wrote /tmp/incometax.pdf (${bytes.length} bytes)`)
