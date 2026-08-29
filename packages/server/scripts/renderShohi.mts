/**
 * 消費税申告書PDF 確認用: サンプルデータで /tmp/shohi.pdf に出力。
 * 使い方: pnpm -s exec tsx scripts/renderConsumption.mts
 */
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../src/db/router.js'
import { seedDataPlane } from '../src/db/data/seed.js'
import { accounts, businessSettings, fiscalYears, journalEntries, journalLines, taxCategories } from '../src/db/data/schema.js'
import { renderShohiOverlay } from "../src/pdf/shohiOverlay.js"

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-c-'))
process.env.DATA_DIR = tmp
const db: DataDb = new DbRouter().userDb('u_c')
seedDataPlane(db)
const now = '2026-01-01T00:00:00Z'
db.insert(businessSettings).values({ businessName: '山田デザイン事務所', ownerName: '山田太郎', taxMethod: 'simplified', taxBusinessCategory: '第5種', createdAt: now, updatedAt: now }).run()
db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
const fy = db.select().from(fiscalYears).all()[0]
const accId = (n: string) => db.select().from(accounts).where(eq(accounts.name, n)).all()[0].id
const sale10 = db.select().from(taxCategories).where(eq(taxCategories.code, 'SALE_10_C5')).all()[0].id
const add = (gross: number) => {
  const tax = Math.round((gross * 10) / 110) // 内税（10%）
  const e = db.insert(journalEntries).values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }).returning().all()[0]
  db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId('普通預金'), amount: gross }).run()
  db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId('売上高'), amount: gross, taxCategoryId: sale10, taxAmount: tax }).run()
}
add(11_000_000) // 税込課税売上（10%）→ 税抜1,000万・売上税額(国)78万・みなし50%・国39万/地方11万/計50万

const bytes = await renderShohiOverlay(db, fy.id)
fs.writeFileSync('/tmp/shohi.pdf', bytes)
console.log(`wrote /tmp/shohi.pdf (${bytes.length} bytes)`)
