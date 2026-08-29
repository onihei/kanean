import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, businessSettings } from '../../db/data/schema.js'
import { PDFDocument } from 'pdf-lib'
import { renderAoiroPage1 } from '../aoiroPdf.js'

let tmp: string
const USER = 'u_aoiropdf'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-aoiropdf-'))
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
  add([{ account: '普通預金', side: 'debit', amount: 3_000_000 }, { account: '売上高', side: 'credit', amount: 3_000_000 }])
  add([{ account: '水道光熱費', side: 'debit', amount: 120_000 }, { account: '普通預金', side: 'credit', amount: 120_000 }])
  add([{ account: '車両費', side: 'debit', amount: 80_000 }, { account: '普通預金', side: 'credit', amount: 80_000 }])
  return { db, fyId: fy.id }
}

describe('renderAoiroPage1（青色決算書 損益 PDF）', () => {
  it('有効なPDFバイト列を生成する（%PDF- マジック・非空・例外なし）', async () => {
    const { db, fyId } = setup()
    const bytes = await renderAoiroPage1(db, fyId)
    expect(bytes).toBeInstanceOf(Uint8Array)
    expect(bytes.length).toBeGreaterThan(1000)
    const head = new TextDecoder().decode(bytes.slice(0, 5))
    expect(head).toBe('%PDF-')
    // 末尾 EOF マーカ。
    const tail = new TextDecoder().decode(bytes.slice(-6))
    expect(tail).toContain('EOF')
  })

  it('再パース可能な1ページPDFで、日本語フォント埋込ぶんのサイズがある', async () => {
    const { db, fyId } = setup()
    const bytes = await renderAoiroPage1(db, fyId)
    // 生成物を再ロードできる＝構造的に妥当なPDF。
    const reloaded = await PDFDocument.load(bytes)
    expect(reloaded.getPageCount()).toBe(1)
    // CJKサブセット埋込（registerFontkit 必須）が成功していれば数KB以上に膨らむ。
    // 埋込失敗（フォントなし）なら 2KB 未満になるため、5KB 超を埋込の代理指標とする。
    expect(bytes.length).toBeGreaterThan(5000)
  })

  it('事業者設定・会計年度が無くても例外を投げない（最小データ）', async () => {
    const db = new DbRouter().bookDb('u_aoiropdf_min')
    seedDataPlane(db)
    const now = '2026-01-01T00:00:00Z'
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: now }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    const bytes = await renderAoiroPage1(db, fy.id)
    expect(new TextDecoder().decode(bytes.slice(0, 5))).toBe('%PDF-')
  })
})
