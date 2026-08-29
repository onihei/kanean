import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, businessSettings, fixedAssets, depreciationEntries, openingBalances, subAccounts, counterparties } from '../../db/data/schema.js'
import { renderAoiroOverlay } from '../aoiroOverlay.js'

let tmp: string
const USER = 'u_aoiro_overlay'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-overlay-'))
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
  const add = (lines: { account: string; side: 'debit' | 'credit'; amount: number }[]) => {
    const e = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now })
      .returning()
      .all()[0]
    lines.forEach((l, i) => db.insert(journalLines).values({ entryId: e.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), amount: l.amount }).run())
  }
  add([{ account: '普通預金', side: 'debit', amount: 5_000_000 }, { account: '売上高', side: 'credit', amount: 5_000_000 }])
  add([{ account: '減価償却費', side: 'debit', amount: 439_919 }, { account: '減価償却累計額', side: 'credit', amount: 439_919 }])
  add([{ account: '地代家賃', side: 'debit', amount: 720_000 }, { account: '普通預金', side: 'credit', amount: 720_000 }])
  // ページ2（給料賃金・専従者給与の内訳）を補助科目別に描画させる
  const sub = (account: string, name: string) =>
    db.insert(subAccounts).values({ accountId: accId(db, account), name, createdAt: now, updatedAt: now }).returning().all()[0].id
  const cp = (name: string) => db.insert(counterparties).values({ name, createdAt: now, updatedAt: now }).returning().all()[0].id
  const addSub = (account: string, subId: number | null, cpId: number | null, amount: number) => {
    const e = db.insert(journalEntries).values({ fiscalYearId: fy.id, entryDate: '2026-07-25', description: null, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now }).returning().all()[0]
    db.insert(journalLines).values({ entryId: e.id, lineNo: 1, side: 'debit', accountId: accId(db, account), subAccountId: subId, counterpartyId: cpId, amount }).run()
    db.insert(journalLines).values({ entryId: e.id, lineNo: 2, side: 'credit', accountId: accId(db, '普通預金'), amount }).run()
  }
  addSub('給料賃金', sub('給料賃金', '従業員A'), null, 1_800_000)
  addSub('給料賃金', sub('給料賃金', '従業員B'), null, 1_200_000)
  addSub('専従者給与', sub('専従者給与', '林花子'), null, 960_000)
  addSub('地代家賃', null, cp('甲不動産'), 120_000) // 取引先別 地代（内訳行を増やす）
  // ページ2（貸倒引当金繰入額の計算）を描画させる: 売掛金（②）＋貸倒引当金繰入（⑤）
  add([{ account: '売掛金', side: 'debit', amount: 800_000 }, { account: '売上高', side: 'credit', amount: 800_000 }])
  add([{ account: '貸倒引当金繰入', side: 'debit', amount: 44_000 }, { account: '貸倒引当金', side: 'credit', amount: 44_000 }])
  // ページ3（減価償却費の計算）を実データで描画させる
  const fa = db.insert(fixedAssets).values({ managementNo: '001', name: 'マツダ2', acquisitionCost: 2_000_000, quantityOrArea: 1, acquiredDate: '2023-04-01', depreciationMethod: 'declining_balance', usefulLife: 6, depreciationRate: 0.333, businessUseRatio: 50, createdAt: now, updatedAt: now }).returning().all()[0]
  db.insert(depreciationEntries).values({ fixedAssetId: fa.id, fiscalYearId: fy.id, openingBookValue: 1_320_000, depreciationAmount: 439_919, businessAmount: 219_960, closingBookValue: 880_081 }).run()
  // ページ4（貸借対照表）を期首・期末ありで描画させる
  const accountId = (name: string) => db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
  db.insert(openingBalances).values({ fiscalYearId: fy.id, accountId: accountId('普通預金'), side: 'debit', amount: 1_000_000 }).run()
  db.insert(openingBalances).values({ fiscalYearId: fy.id, accountId: accountId('元入金'), side: 'credit', amount: 1_000_000 }).run()
  return { db, fyId: fy.id }
}

describe('renderAoiroOverlay（官製様式PDFへの座標オーバーレイ）', () => {
  it('テンプレ4ページを保ち、有効なPDF（%PDF-・EOF）を生成する', async () => {
    const { db, fyId } = setup()
    const bytes = await renderAoiroOverlay(db, fyId)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBe(4) // 提出用4ページ
    // 日本語フォント埋込ぶんでテンプレ単体より十分大きい。
    expect(bytes.length).toBeGreaterThan(10_000)
  })

  it('事業者設定・仕訳が無くても例外を投げない（白紙オーバーレイ）', async () => {
    const db = new DbRouter().bookDb('u_overlay_empty')
    seedDataPlane(db)
    const now = '2026-01-01T00:00:00Z'
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    const bytes = await renderAoiroOverlay(db, fy.id)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })
})
