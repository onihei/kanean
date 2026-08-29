import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, subAccounts, fiscalYears, importBatches, rawTransactions } from '../../db/data/schema.js'
import { listLinkedServices } from '../ecServices.js'
import { updateBusinessSettings } from '../../masters/businessSettings.js'

let tmp: string
const USER = 'u_ecsvc'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-ecsvc-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): DataDb {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .run()
  const ts = '2026-01-01T00:00:00Z'
  db.insert(subAccounts)
    .values([
      // EC連携（scrape対象）
      { accountId: accId(db, '未払金'), name: 'Amazon', linkedAccountRef: 'amazon', importSourceType: 'amazon', isActive: true, sortOrder: 0, createdAt: ts, updatedAt: ts },
      { accountId: accId(db, '未払金'), name: '楽天', linkedAccountRef: 'rakuten', importSourceType: 'rakuten', isActive: true, sortOrder: 1, createdAt: ts, updatedAt: ts },
      // 銀行（普通預金一脚）＝bankAccounts へ
      { accountId: accId(db, '普通預金'), name: 'UFJ普通', linkedAccountRef: 'ufj-1', importSourceType: 'bank_ufj', isActive: true, sortOrder: 2, createdAt: ts, updatedAt: ts },
      // カード（未払金一脚）＝cards へ
      { accountId: accId(db, '未払金'), name: '三菱UFJ-VISA', linkedAccountRef: 'card_mufg_visa-1', importSourceType: 'card_mufg_visa', isActive: true, sortOrder: 3, createdAt: ts, updatedAt: ts },
      // 汎用フォーマット＝除外
      { accountId: accId(db, '普通預金'), name: '独自CSV', linkedAccountRef: 'x-1', importSourceType: 'format:5', isActive: true, sortOrder: 4, createdAt: ts, updatedAt: ts },
    ])
    .run()
  return db
}

describe('listLinkedServices', () => {
  it('kind で振り分け（EC→services / 銀行→bankAccounts / カード→cards・汎用フォーマットは除外）', () => {
    const db = setup()
    const r = listLinkedServices(db)
    expect(r.services.map((s) => s.source).sort()).toEqual(['amazon', 'rakuten'])
    expect(r.bankAccounts.map((s) => s.source)).toEqual(['bank_ufj'])
    expect(r.cards.map((s) => s.source)).toEqual(['card_mufg_visa'])
    expect(r.openFiscalYear?.startDate).toBe('2026-01-01')
  })

  it('カードは payableSubAccount（未払金チャネル）・fetchSince を返す', () => {
    const db = setup()
    const card = listLinkedServices(db).cards.find((c) => c.source === 'card_mufg_visa')!
    expect(card.accountRef).toBe('card_mufg_visa-1')
    expect(card.payableSubAccount).toBe('未払金 / 三菱UFJ-VISA')
    expect(card.displayName).toBe('三菱UFJ-VISA') // カタログ label
    expect(card.lastImportedAt).toBeNull()
    expect(card.fetchSince).toBe('2026-01-01') // 未取込→open開始
  })

  it('payableSubAccount・lastImportedAt・fetchSince を返す', () => {
    const db = setup()
    // amazon に1バッチ＋1明細を投入
    const batch = db
      .insert(importBatches)
      .values({ sourceType: 'amazon', accountRef: 'amazon', importedAt: '2026-05-31T10:00:00Z', rowCount: 1, status: 'done' })
      .returning()
      .all()[0]
    db.insert(rawTransactions)
      .values({ batchId: batch.id, txnDate: '2026-05-20', amount: 2980, direction: 'out', description: 'x', dedupHash: 'h1', accountRef: 'amazon', status: 'journalized' })
      .run()

    const r = listLinkedServices(db)
    const amazon = r.services.find((s) => s.source === 'amazon')!
    expect(amazon.accountRef).toBe('amazon')
    expect(amazon.payableSubAccount).toBe('未払金 / Amazon')
    expect(amazon.displayName).toBe('Amazon') // カタログ label
    expect(amazon.lastImportedAt).toBe('2026-05-31T10:00:00Z')
    expect(amazon.fetchSince).toBe('2026-05-20') // max(直近order_date, open開始)

    const rakuten = r.services.find((s) => s.source === 'rakuten')!
    expect(rakuten.lastImportedAt).toBeNull()
    expect(rakuten.fetchSince).toBe('2026-01-01') // 未取込→open開始
  })

  it('evidenceCapture を返す（既定 false・事業者設定 true で反映）', () => {
    const db = setup()
    expect(listLinkedServices(db).evidenceCapture).toBe(false) // 既定OFF
    updateBusinessSettings(db, { evidenceCapture: true })
    expect(listLinkedServices(db).evidenceCapture).toBe(true)
  })
})
