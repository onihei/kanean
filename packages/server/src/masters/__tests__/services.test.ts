import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, accounts, subAccounts } from '../../db/data/schema.js'
import { importRows } from '../../import/importer.js'
import { parseBankUfj } from '../../import/parsers/bankUfj.js'
import { journalizeBatch } from '../../journal/journalize.js'
import { listDrafts } from '../../journal/confirm.js'
import { registerService, listServices } from '../services.js'
import { createImportFormat } from '../importFormats.js'
import { createImportAccount } from '../subAccounts.js'

let tmp: string
const USER = 'u_services'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-services-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup() {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  const fy = db.select().from(fiscalYears).all()[0]
  return { router, db, fy }
}

describe('連携サービス登録（registerService）', () => {
  it('銀行サービス登録で普通預金配下に補助科目を自動作成し source_type/account_ref を紐付ける', () => {
    const { db } = setup()
    const svc = registerService(db, { serviceKey: 'bank_ufj', name: 'UFJ 五反田' })

    expect(svc.serviceKey).toBe('bank_ufj')
    expect(svc.accountRef).toBe('bank_ufj-1')
    expect(svc.accountName).toBe('普通預金')
    expect(svc.csv).toBe(true)

    const sub = db.select().from(subAccounts).where(eq(subAccounts.id, svc.subAccountId)).all()[0]
    expect(sub.name).toBe('UFJ 五反田')
    expect(sub.accountId).toBe(accId(db, '普通預金'))
    expect(sub.linkedAccountRef).toBe('bank_ufj-1')
    expect(sub.importSourceType).toBe('bank_ufj')
    expect(sub.isActive).toBe(true)
  })

  it('カードサービスは未払金配下・名称未指定はカタログ表示名を既定にする', () => {
    const { db } = setup()
    const svc = registerService(db, { serviceKey: 'card_mufg_visa' })
    expect(svc.accountName).toBe('未払金')
    expect(svc.name).toBe('三菱UFJ-VISA')
  })

  it('EC（amazon）は登録可だが csv=false（取込手段は別途）', () => {
    const { db } = setup()
    const svc = registerService(db, { serviceKey: 'amazon', name: 'Amazon' })
    expect(svc.kind).toBe('ec')
    expect(svc.csv).toBe(false)
    expect(svc.accountName).toBe('未払金')
  })

  it('同一サービスを複数登録でき account_ref は一意に採番される', () => {
    const { db } = setup()
    const a = registerService(db, { serviceKey: 'bank_ufj', name: 'UFJ 本店' })
    const b = registerService(db, { serviceKey: 'bank_ufj', name: 'UFJ 五反田' })
    expect(a.accountRef).toBe('bank_ufj-1')
    expect(b.accountRef).toBe('bank_ufj-2')
    expect(a.subAccountId).not.toBe(b.subAccountId)
  })

  it('未対応のサービスキーは拒否する', () => {
    const { db } = setup()
    expect(() => registerService(db, { serviceKey: 'unknown_bank' })).toThrow(/未対応の連携サービス/)
  })
})

describe('連携サービス一覧（listServices）と draft 件数', () => {
  it('登録済みサービスを列挙し、取込で生成された draft をサービス毎に数える', () => {
    const { router, db } = setup()
    const ufj = registerService(db, { serviceKey: 'bank_ufj', name: 'UFJ 普通' })
    registerService(db, { serviceKey: 'card_mufg_visa', name: 'UFJ-VISA' })

    // UFJ 口座に2明細を取込→draft化。
    const csv = [
      '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
      '"2026/6/1","ﾃｽﾄ入金","","","100,000","100,000"',
      '"2026/6/2","ﾃｽﾄ出金","","30,000","","70,000"',
    ].join('\r\n')
    const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: ufj.accountRef, rows: parseBankUfj(csv).rows })
    journalizeBatch(db, batch.batchId)

    const services = listServices(db)
    expect(services.map((s) => s.serviceKey).sort()).toEqual(['bank_ufj', 'card_mufg_visa'])
    const ufjView = services.find((s) => s.subAccountId === ufj.subAccountId)!
    expect(ufjView.draftCount).toBe(2)
    const cardView = services.find((s) => s.serviceKey === 'card_mufg_visa')!
    expect(cardView.draftCount).toBe(0)
  })

  it('既存のユーザー定義フォーマット(format:{id})口座は取込可(csv=true)・フォーマット名で表示する', () => {
    const { db } = setup()
    const fid = createImportFormat(db, {
      name: '住信SBI 普通',
      config: { encoding: 'utf8', headerRows: 1, dateCol: 0, descCols: [1], amount: { mode: 'signed', amountCol: 2 } },
    })
    createImportAccount(db, { sourceType: `format:${fid}`, accountRef: 'sbi-1', accountId: accId(db, '普通預金'), name: '住信SBI' })

    const svc = listServices(db).find((s) => s.serviceKey === `format:${fid}`)!
    expect(svc).toBeTruthy()
    expect(svc.csv).toBe(true) // 取込フォーム抑止＝既存データの取込を黙って塞がない
    expect(svc.label).toBe('住信SBI 普通') // フォーマット名で表示
    expect(svc.kind).toBeNull()
  })
})

describe('listDrafts の subAccountId フィルタ（サービス毎の確認）', () => {
  it('指定サービスの取込元行(line_no=1)に紐づく draft のみ返す', () => {
    const { router, db, fy } = setup()
    const ufj = registerService(db, { serviceKey: 'bank_ufj', name: 'UFJ-A' })
    const ufj2 = registerService(db, { serviceKey: 'bank_ufj', name: 'UFJ-B' })

    const mk = (ref: string, amount: string) =>
      importRows(router, USER, {
        sourceType: 'bank_ufj',
        accountRef: ref,
        rows: parseBankUfj(['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', `"2026/6/1","入金","","","${amount}","0"`].join('\r\n')).rows,
      })
    journalizeBatch(db, mk(ufj.accountRef, '100,000').batchId)
    journalizeBatch(db, mk(ufj2.accountRef, '200,000').batchId)

    expect(listDrafts(db, fy.id)).toHaveLength(2)
    const onlyA = listDrafts(db, fy.id, { subAccountId: ufj.subAccountId })
    expect(onlyA).toHaveLength(1)
    expect(onlyA[0].lines.find((l) => l.lineNo === 1)!.subAccountId).toBe(ufj.subAccountId)
    expect(listDrafts(db, fy.id, { subAccountId: ufj2.subAccountId })).toHaveLength(1)
  })
})
