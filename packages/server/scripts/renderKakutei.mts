/**
 * 確定申告書 官製様式オーバーレイ較正用: サンプルデータで /tmp/kakutei.pdf に出力。
 * 使い方: pnpm -s exec tsx scripts/renderKakutei.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../src/db/router.js'
import { seedDataPlane } from '../src/db/data/seed.js'
import { accounts, businessSettings, counterparties, fiscalYears, journalEntries, journalLines, subAccounts, taxReturnInputs } from '../src/db/data/schema.js'
import { renderKakuteiOverlay } from '../src/pdf/kakuteiOverlay.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-k-'))
process.env.DATA_DIR = tmp
const db: DataDb = new DbRouter().userDb('u_k')
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
const existing = db.select().from(subAccounts).where(eq(subAccounts.accountId, accId('事業主貸'))).all().find((s) => s.name === '源泉所得税')
const whSub = existing?.id ?? db.insert(subAccounts).values({ accountId: accId('事業主貸'), name: '源泉所得税', createdAt: now, updatedAt: now }).returning().all()[0].id

add([{ account: '普通預金', side: 'debit', amount: 5_000_000 }, { account: '売上高', side: 'credit', amount: 5_000_000 }])
add([{ account: '水道光熱費', side: 'debit', amount: 200_000 }, { account: '普通預金', side: 'credit', amount: 200_000 }])
add([{ account: '通信費', side: 'debit', amount: 150_000 }, { account: '普通預金', side: 'credit', amount: 150_000 }])
add([
  { account: '普通預金', side: 'debit', amount: 897_900 },
  { account: '事業主貸', side: 'debit', amount: 102_100, sub: whSub, cp },
  { account: '売上高', side: 'credit', amount: 1_000_000, cp },
])
db.insert(taxReturnInputs).values({ fiscalYearId: fy.id, basicDeduction: 480_000, socialInsurance: 600_000, lifeInsurance: 80_000, medical: 120_000, spouseDependents: 380_000, otherDeductions: 0, estimatedPrepaid: 0, createdAt: now, updatedAt: now }).run()

const bytes = await renderKakuteiOverlay(db, fy.id)
fs.writeFileSync('/tmp/kakutei.pdf', bytes)
console.log(`wrote /tmp/kakutei.pdf (${bytes.length} bytes)`)
