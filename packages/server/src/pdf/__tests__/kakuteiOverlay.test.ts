import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, businessSettings, subAccounts, counterparties, taxReturnInputs } from '../../db/data/schema.js'
import { renderKakuteiOverlay } from '../kakuteiOverlay.js'

let tmp: string
const USER = 'u_kakutei_overlay'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-kakutei-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup() {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const now = '2026-01-01T00:00:00Z'
  db.insert(businessSettings).values({ businessName: '山田商店', ownerName: '山田太郎', createdAt: now, updatedAt: now }).run()
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
  const fy = db.select().from(fiscalYears).all()[0]
  const add = (lines: { account: string; side: 'debit' | 'credit'; amount: number; sub?: number; cp?: number }[]) => {
    const e = db.insert(journalEntries).values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }).returning().all()[0]
    lines.forEach((l, i) => db.insert(journalLines).values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), subAccountId: l.sub ?? null, counterpartyId: l.cp ?? null, amount: l.amount }).run())
  }
  add([{ account: '普通預金', side: 'debit', amount: 5_000_000 }, { account: '売上高', side: 'credit', amount: 5_000_000 }])
  add([{ account: '水道光熱費', side: 'debit', amount: 200_000 }, { account: '普通預金', side: 'credit', amount: 200_000 }])
  // 源泉あり売上（第二表 所得の内訳を描画させる）
  const cp = db.insert(counterparties).values({ name: '株式会社クライアントA', createdAt: now, updatedAt: now }).returning().all()[0].id
  const existing = db.select().from(subAccounts).where(eq(subAccounts.accountId, accId(db, '事業主貸'))).all().find((s) => s.name === '源泉所得税')
  const whSub = existing?.id ?? db.insert(subAccounts).values({ accountId: accId(db, '事業主貸'), name: '源泉所得税', createdAt: now, updatedAt: now }).returning().all()[0].id
  add([
    { account: '普通預金', side: 'debit', amount: 897_900 },
    { account: '事業主貸', side: 'debit', amount: 102_100, sub: whSub, cp },
    { account: '売上高', side: 'credit', amount: 1_000_000, cp },
  ])
  db.insert(taxReturnInputs).values({ fiscalYearId: fy.id, basicDeduction: 480_000, socialInsurance: 600_000, lifeInsurance: 80_000, medical: 0, spouseDependents: 380_000, otherDeductions: 0, estimatedPrepaid: 0, createdAt: now, updatedAt: now }).run()
  return { db, fyId: fy.id }
}

describe('renderKakuteiOverlay（確定申告書 官製様式オーバーレイ）', () => {
  it('テンプレ2ページ（第一表・第二表）を保ち、有効なPDFを生成する', async () => {
    const { db, fyId } = setup()
    const bytes = await renderKakuteiOverlay(db, fyId)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBe(2)
    expect(bytes.length).toBeGreaterThan(10_000)
  })

  it('事業者設定・仕訳が無くても例外を投げない（白紙オーバーレイ）', async () => {
    const db = new DbRouter().bookDb('u_kakutei_empty')
    seedDataPlane(db)
    const now = '2026-01-01T00:00:00Z'
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    const bytes = await renderKakuteiOverlay(db, fy.id)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })
})
