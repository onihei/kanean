/**
 * オーバーレイ較正用: サンプルデータで官製様式PDFを生成して /tmp/sample.pdf に出力する。
 * 使い方: pnpm --filter @kanean/server exec tsx scripts/renderSample.mts
 * 確認:   gs -q -sDEVICE=png16m -r150 -dFirstPage=3 -dLastPage=3 -o /tmp/sample3.png /tmp/sample.pdf
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../src/db/router.js'
import { seedDataPlane } from '../src/db/data/seed.js'
import {
  accounts,
  businessSettings,
  counterparties,
  fiscalYears,
  fixedAssets,
  depreciationEntries,
  journalEntries,
  journalLines,
  openingBalances,
  subAccounts,
} from '../src/db/data/schema.js'
import { renderAoiroOverlay } from '../src/pdf/aoiroOverlay.js'

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-sample-'))
process.env.DATA_DIR = tmp

const db: DataDb = new DbRouter().userDb('u_sample')
seedDataPlane(db)
const now = '2026-01-01T00:00:00Z'
db.insert(businessSettings).values({ businessName: '山田商店', ownerName: '山田太郎', createdAt: now, updatedAt: now }).run()
db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
const fy = db.select().from(fiscalYears).all()[0]

const accId = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
const addOn = (date: string, lines: { account: string; side: 'debit' | 'credit'; amount: number }[]) => {
  const e = db.insert(journalEntries).values({ fiscalYearId: fy.id, entryDate: date, description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }).returning().all()[0]
  lines.forEach((l, i) => db.insert(journalLines).values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(l.account), amount: l.amount }).run())
}
const add = (lines: { account: string; side: 'debit' | 'credit'; amount: number }[]) => addOn('2026-06-01', lines)
// 期首残高（貸借一致）: 普通預金150万+車両200万 = 借入金50万+元入金300万
const ob = (account: string, side: 'debit' | 'credit', amount: number) =>
  db.insert(openingBalances).values({ fiscalYearId: fy.id, accountId: accId(account), side, amount }).run()
ob('普通預金', 'debit', 1_500_000)
ob('車両運搬具', 'debit', 2_000_000)
ob('借入金', 'credit', 500_000)
ob('元入金', 'credit', 3_000_000)

add([{ account: '普通預金', side: 'debit', amount: 5_000_000 }, { account: '売上高', side: 'credit', amount: 5_000_000 }])
add([{ account: '減価償却費', side: 'debit', amount: 514_919 }, { account: '減価償却累計額', side: 'credit', amount: 514_919 }])
add([{ account: '仕入高', side: 'debit', amount: 300_000 }, { account: '買掛金', side: 'credit', amount: 300_000 }])
// 月別検証用（1月・12月の売上）
addOn('2026-01-15', [{ account: '普通預金', side: 'debit', amount: 1_000_000 }, { account: '売上高', side: 'credit', amount: 1_000_000 }])
addOn('2026-12-20', [{ account: '普通預金', side: 'debit', amount: 2_000_000 }, { account: '売上高', side: 'credit', amount: 2_000_000 }])

// 内訳検証用: 補助科目（従業員・専従者）/取引先（地代の支払先）付き仕訳。
const subId = (accountName: string, name: string): number =>
  db.insert(subAccounts).values({ accountId: accId(accountName), name, createdAt: now, updatedAt: now }).returning().all()[0].id
const cpId = (name: string): number =>
  db.insert(counterparties).values({ name, createdAt: now, updatedAt: now }).returning().all()[0].id
const addRich = (date: string, debit: { account: string; subAccountId?: number; counterpartyId?: number; amount: number }, creditAccount = '普通預金') => {
  const e = db.insert(journalEntries).values({ fiscalYearId: fy.id, entryDate: date, description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }).returning().all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(debit.account), subAccountId: debit.subAccountId ?? null, counterpartyId: debit.counterpartyId ?? null, amount: debit.amount }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(creditAccount), amount: debit.amount }).run()
}
// 給料賃金: 従業員2名（合計300万＝損益⑳）
const empA = subId('給料賃金', '従業員A')
const empB = subId('給料賃金', '従業員B')
addRich('2026-07-25', { account: '給料賃金', subAccountId: empA, amount: 1_800_000 })
addRich('2026-07-25', { account: '給料賃金', subAccountId: empB, amount: 1_200_000 })
// 専従者給与: 配偶者（96万）
const senjuA = subId('専従者給与', '林花子')
addRich('2026-07-25', { account: '専従者給与', subAccountId: senjuA, amount: 960_000 })
// 地代家賃: 支払先2件（合計72万＝損益㉓）
const land1 = cpId('甲不動産株式会社')
const land2 = cpId('乙商事')
addRich('2026-08-31', { account: '地代家賃', counterpartyId: land1, amount: 480_000 })
addRich('2026-08-31', { account: '地代家賃', counterpartyId: land2, amount: 240_000 })

// 貸倒引当金繰入額の計算: 期末 売掛金100万＋受取手形50万＝②150万 / ③＝82,500（150万×5.5%）/ ⑤繰入82,500
addOn('2026-11-30', [{ account: '売掛金', side: 'debit', amount: 1_000_000 }, { account: '売上高', side: 'credit', amount: 1_000_000 }])
addOn('2026-11-30', [{ account: '受取手形', side: 'debit', amount: 500_000 }, { account: '売上高', side: 'credit', amount: 500_000 }])
add([{ account: '貸倒引当金繰入', side: 'debit', amount: 82_500 }, { account: '貸倒引当金', side: 'credit', amount: 82_500 }])

// 固定資産 2件（複数行・列フォーマット検証用）
const fa1 = db.insert(fixedAssets).values({
  managementNo: '001', name: 'マツダ2', accountId: accId('車両運搬具'), acquisitionCost: 2_000_000,
  quantityOrArea: 1, acquiredDate: '2023-04-01', depreciationMethod: 'declining_balance', usefulLife: 6,
  depreciationRate: 0.333, businessUseRatio: 50, createdAt: now, updatedAt: now,
}).returning().all()[0]
const fa2 = db.insert(fixedAssets).values({
  managementNo: '002', name: 'ノートPC', accountId: accId('工具器具備品'), acquisitionCost: 300_000,
  quantityOrArea: 1, acquiredDate: '2026-02-01', depreciationMethod: 'straight_line', usefulLife: 4,
  depreciationRate: 0.25, businessUseRatio: 100, createdAt: now, updatedAt: now,
}).returning().all()[0]
db.insert(depreciationEntries).values({ fixedAssetId: fa1.id, fiscalYearId: fy.id, openingBookValue: 1_320_000, depreciationAmount: 439_919, businessAmount: 219_960, closingBookValue: 880_081 }).run()
db.insert(depreciationEntries).values({ fixedAssetId: fa2.id, fiscalYearId: fy.id, openingBookValue: 300_000, depreciationAmount: 68_750, businessAmount: 68_750, closingBookValue: 231_250 }).run()

const bytes = await renderAoiroOverlay(db, fy.id)
fs.writeFileSync('/tmp/sample.pdf', bytes)
console.log(`wrote /tmp/sample.pdf (${bytes.length} bytes), DATA_DIR=${tmp}`)
