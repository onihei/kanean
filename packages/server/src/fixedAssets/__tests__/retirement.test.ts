import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, fixedAssets, businessSettings } from '../../db/data/schema.js'
import { createFixedAsset } from '../register.js'
import { postDepreciation } from '../posting.js'
import { retireFixedAsset, sellFixedAsset } from '../retirement.js'
import { trialBalance } from '../../reports/reports.js'

let tmp: string
const USER = 'u_retire'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-retire-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}
function setup(year: number): { db: DataDb; fyId: number } {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const fy = db.insert(fiscalYears).values({ startDate: `${year}-01-01`, endDate: `${year}-12-31`, status: 'open', createdAt: 'x' }).returning().all()[0]
  return { db, fyId: fy.id }
}
function lineByAccount(db: DataDb, entryId: number, name: string) {
  return db.select().from(journalLines).where(eq(journalLines.entryId, entryId)).all().find((l) => l.accountId === accId(db, name))
}

describe('固定資産の除却（間接法・depreciation-spec §7）', () => {
  it('償却済み資産を除却: 借)累計額200,000+除却損800,000 / 貸)機械装置1,000,000・status=retired', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 1_000_000, acquiredDate: '2024-01-01', businessStartDate: '2024-01-01', usefulLife: 5, businessUseRatio: 100, accountId: accId(db, '機械装置') })
    postDepreciation(db, fyId) // 2024: 200,000 償却 → 累計200,000・残高800,000

    const r = retireFixedAsset(db, fyId, id, '2024-12-15')
    expect(r).toMatchObject({ accumulated: 200_000, bookValue: 800_000, lossBusiness: 800_000, lossHousehold: 0 })

    const entry = db.select().from(journalEntries).where(eq(journalEntries.source, 'retirement')).all()[0]
    expect(entry.status).toBe('confirmed')
    expect(lineByAccount(db, entry.id, '減価償却累計額')).toMatchObject({ side: 'debit', amount: 200_000 })
    expect(lineByAccount(db, entry.id, '固定資産除却損')).toMatchObject({ side: 'debit', amount: 800_000 })
    expect(lineByAccount(db, entry.id, '機械装置')).toMatchObject({ side: 'credit', amount: 1_000_000 })

    const asset = db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).all()[0]
    expect(asset.status).toBe('retired')
    expect(asset.retiredDate).toBe('2024-12-15')
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('取得年の期中除却は当年度の月割償却を計上してから除却損（§7・定額法・事業80%）', () => {
    const { db, fyId } = setup(2024)
    // 取得250,000・耐用5年(rate0.2)・6月供用・9月除却 → 6〜9月=4ヶ月の月割償却。
    const id = createFixedAsset(db, { name: '器具', acquisitionCost: 250_000, acquiredDate: '2024-06-01', businessStartDate: '2024-06-01', usefulLife: 5, businessUseRatio: 80, accountId: accId(db, '工具器具備品') })

    const r = retireFixedAsset(db, fyId, id, '2024-09-01')
    // 月割償却: ceil(50,000×4/12)=16,667。残高=250,000−16,667=233,333。
    expect(r.currentYearDepreciation).toBe(16_667)
    expect(r).toMatchObject({ accumulated: 16_667, bookValue: 233_333 })
    // 残高233,333を事業80%で按分: 家事=floor(233,333×20%)=46,666 / 事業=186,667。
    expect(r.lossHousehold).toBe(46_666)
    expect(r.lossBusiness).toBe(186_667)
    expect(r.note).toMatch(/期中除却/)
    expect(r.note).toMatch(/4ヶ月/)

    // 月割償却仕訳（source='retirement'）: 借)減価償却費13,334 借)事業主貸3,333 / 貸)累計額16,667。
    const depEntry = db.select().from(journalEntries).where(eq(journalEntries.id, r.depreciationEntryId!)).all()[0]
    expect(depEntry.description).toMatch(/減価償却（除却年度）/)
    expect(lineByAccount(db, depEntry.id, '減価償却費')).toMatchObject({ side: 'debit', amount: 13_334 })
    expect(lineByAccount(db, depEntry.id, '事業主貸')).toMatchObject({ side: 'debit', amount: 3_333 })
    expect(lineByAccount(db, depEntry.id, '減価償却累計額')).toMatchObject({ side: 'credit', amount: 16_667 })

    // 除却損仕訳: 借)累計額16,667 借)除却損186,667 借)事業主貸46,666 / 貸)工具器具備品250,000。
    const disp = db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId!)).all()[0]
    expect(lineByAccount(db, disp.id, '減価償却累計額')).toMatchObject({ side: 'debit', amount: 16_667 })
    expect(lineByAccount(db, disp.id, '固定資産除却損')).toMatchObject({ side: 'debit', amount: 186_667 })
    expect(lineByAccount(db, disp.id, '事業主貸')).toMatchObject({ side: 'debit', amount: 46_666 })
    expect(lineByAccount(db, disp.id, '工具器具備品')).toMatchObject({ side: 'credit', amount: 250_000 })

    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('翌年以降の期中除却: 前年は通常償却・除却年は月割（定額法・事業100%）', () => {
    const { db, fyId } = setup(2025)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 600_000, acquiredDate: '2024-01-01', businessStartDate: '2024-01-01', usefulLife: 5, businessUseRatio: 100, accountId: accId(db, '機械装置') })
    // 2024年度分(満額120,000)を別途起票しておく。
    const fy2024 = db.insert(fiscalYears).values({ startDate: '2024-01-01', endDate: '2024-12-31', status: 'closed', createdAt: 'x' }).returning().all()[0]
    postDepreciation(db, fy2024.id)

    const r = retireFixedAsset(db, fyId, id, '2025-06-30') // 1〜6月=6ヶ月
    expect(r.currentYearDepreciation).toBe(60_000) // ceil(120,000×6/12)
    expect(r.accumulated).toBe(180_000) // 120,000(前年) + 60,000(当年)
    expect(r.bookValue).toBe(420_000)
    const disp = db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId!)).all()[0]
    expect(lineByAccount(db, disp.id, '減価償却累計額')).toMatchObject({ side: 'debit', amount: 180_000 })
    expect(lineByAccount(db, disp.id, '固定資産除却損')).toMatchObject({ side: 'debit', amount: 420_000 })
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })
})

describe('固定資産の除却（直接法）', () => {
  it('貸方は未償却残高（取得価額でなく簿価）・累計額行なし', () => {
    const { db, fyId } = setup(2024)
    db.insert(businessSettings).values({ depreciationRecordMethod: 'direct', createdAt: 'x', updatedAt: 'x' }).run()
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 1_000_000, acquiredDate: '2024-01-01', businessStartDate: '2024-01-01', usefulLife: 5, businessUseRatio: 100, accountId: accId(db, '機械装置') })
    postDepreciation(db, fyId) // 直接法: 貸)機械装置 200,000 → 簿価800,000

    const r = retireFixedAsset(db, fyId, id, '2024-12-15')
    expect(r.bookValue).toBe(800_000)
    const entry = db.select().from(journalEntries).where(eq(journalEntries.source, 'retirement')).all()[0]
    expect(lineByAccount(db, entry.id, '固定資産除却損')).toMatchObject({ side: 'debit', amount: 800_000 })
    expect(lineByAccount(db, entry.id, '機械装置')).toMatchObject({ side: 'credit', amount: 800_000 })
    expect(lineByAccount(db, entry.id, '減価償却累計額')).toBeUndefined()
  })
})

describe('一括償却資産の除却（§5・3年継続・除却損なし）', () => {
  it('期中除却でも除却損を起票せず status=retired のみ記録（仕訳なし・残高情報のみ返す）', () => {
    const { db, fyId } = setup(2024)
    // 180,000 を一括償却（3年均等＝各60,000）。2024年度分を起票してから期中除却。
    const id = createFixedAsset(db, { name: '一括備品', acquisitionCost: 180_000, acquiredDate: '2024-01-01', businessStartDate: '2024-01-01', depreciationMethod: 'lump_sum', businessUseRatio: 100, accountId: accId(db, '工具器具備品') })
    postDepreciation(db, fyId) // 2024: 60,000 償却（累計60,000）

    const r = retireFixedAsset(db, fyId, id, '2024-06-30')
    expect(r.entryId).toBeNull()
    expect(r.depreciationEntryId).toBeNull()
    expect(r).toMatchObject({ currentYearDepreciation: 0, lossBusiness: 0, lossHousehold: 0, accumulated: 60_000, bookValue: 120_000 })
    expect(r.note).toMatch(/3年/)
    expect(r.note).toMatch(/除却損/)

    // 除却仕訳（source='retirement'）は一切作られない（除却損なし）。当年度の償却仕訳のみが残る。
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'retirement')).all()).toHaveLength(0)

    const asset = db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).all()[0]
    expect(asset.status).toBe('retired')
    expect(asset.retiredDate).toBe('2024-06-30')
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('償却起票前に除却しても簿価＝取得価額・累計0で除却損なし', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '一括', acquisitionCost: 150_000, acquiredDate: '2024-03-01', businessStartDate: '2024-03-01', depreciationMethod: 'lump_sum', businessUseRatio: 100, accountId: accId(db, '工具器具備品') })
    const r = retireFixedAsset(db, fyId, id, '2024-05-31')
    expect(r).toMatchObject({ entryId: null, accumulated: 0, bookValue: 150_000, lossBusiness: 0, lossHousehold: 0 })
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'retirement')).all()).toHaveLength(0)
  })

  it('科目未設定の一括償却資産も除却できる（除却仕訳を起票しないため）', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '一括科目なし', acquisitionCost: 120_000, businessStartDate: '2024-01-01', depreciationMethod: 'lump_sum', businessUseRatio: 100 })
    const r = retireFixedAsset(db, fyId, id, '2024-12-01')
    expect(r.entryId).toBeNull()
    expect(db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).all()[0].status).toBe('retired')
  })

  it('除却済みの一括償却資産は再除却できない', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '一括', acquisitionCost: 180_000, businessStartDate: '2024-01-01', depreciationMethod: 'lump_sum', businessUseRatio: 100, accountId: accId(db, '工具器具備品') })
    retireFixedAsset(db, fyId, id, '2024-06-30')
    expect(() => retireFixedAsset(db, fyId, id, '2024-07-01')).toThrow(/既に除却済み/)
  })
})

describe('除却のガード', () => {
  it('除却済み資産の再除却・年度外日付・科目未設定を弾く', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 500_000, acquiredDate: '2024-01-01', businessStartDate: '2024-01-01', usefulLife: 5, accountId: accId(db, '機械装置') })
    expect(() => retireFixedAsset(db, fyId, id, '2025-01-01')).toThrow(/会計年度の範囲/)
    retireFixedAsset(db, fyId, id, '2024-12-01')
    expect(() => retireFixedAsset(db, fyId, id, '2024-12-02')).toThrow(/既に除却済み/)

    const id2 = createFixedAsset(db, { name: '科目なし', acquisitionCost: 100_000, businessStartDate: '2024-01-01', usefulLife: 5 })
    expect(() => retireFixedAsset(db, fyId, id2, '2024-12-01')).toThrow(/勘定科目が未設定/)
  })

  it('実在しない日付（2024-02-30）を弾く', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 500_000, businessStartDate: '2024-01-01', usefulLife: 5, accountId: accId(db, '機械装置') })
    expect(() => retireFixedAsset(db, fyId, id, '2024-02-30')).toThrow(/存在しない日付/)
  })

  it('全額償却済み（直接法・少額特例）の除却は空仕訳を作らず弾く', () => {
    const { db, fyId } = setup(2024)
    db.insert(businessSettings).values({ depreciationRecordMethod: 'direct', createdAt: 'x', updatedAt: 'x' }).run()
    // 少額特例は取得年に全額即時償却 → 簿価0。
    const id = createFixedAsset(db, { name: '少額', acquisitionCost: 200_000, acquiredDate: '2024-03-01', businessStartDate: '2024-03-01', depreciationMethod: 'minor_special', businessUseRatio: 100, accountId: accId(db, '工具器具備品') })
    postDepreciation(db, fyId) // 全額償却 → 簿価0
    expect(() => retireFixedAsset(db, fyId, id, '2024-12-01')).toThrow(/未償却残高がありません/)
  })

  it('期中除却は注記を返し、年度末除却は注記なし', () => {
    const { db, fyId } = setup(2024)
    const mid = createFixedAsset(db, { name: 'A', acquisitionCost: 100_000, businessStartDate: '2024-01-01', usefulLife: 5, accountId: accId(db, '機械装置') })
    expect(retireFixedAsset(db, fyId, mid, '2024-06-30').note).toMatch(/期中除却/)
    const end = createFixedAsset(db, { name: 'B', acquisitionCost: 100_000, businessStartDate: '2024-01-01', usefulLife: 5, accountId: accId(db, '機械装置') })
    expect(retireFixedAsset(db, fyId, end, '2024-12-31').note).toBeNull()
  })
})

describe('固定資産の売却（譲渡＝事業主貸へ振替・depreciation-spec §7・slice7）', () => {
  it('期中売却（間接法・事業80%）: 月割償却後の未償却残高を全額 事業主貸へ振替（除却損なし）', () => {
    const { db, fyId } = setup(2024)
    // 取得250,000・耐用5年(rate0.2)・6月供用・9月売却 → 6〜9月=4ヶ月の月割償却。
    const id = createFixedAsset(db, { name: '器具', acquisitionCost: 250_000, acquiredDate: '2024-06-01', businessStartDate: '2024-06-01', usefulLife: 5, businessUseRatio: 80, accountId: accId(db, '工具器具備品') })

    const r = sellFixedAsset(db, fyId, id, '2024-09-01')
    expect(r.disposalType).toBe('sale')
    // 月割償却: ceil(50,000×4/12)=16,667。残高=250,000−16,667=233,333。
    expect(r.currentYearDepreciation).toBe(16_667)
    expect(r).toMatchObject({ accumulated: 16_667, bookValue: 233_333, lossBusiness: 0, lossHousehold: 0, ownerTransfer: 233_333 })
    expect(r.note).toMatch(/売却/)
    expect(r.note).toMatch(/譲渡所得/)

    // 売却年度の月割償却仕訳（source='sale'）: 借)減価償却費13,334 借)事業主貸3,333 / 貸)累計額16,667。
    const depEntry = db.select().from(journalEntries).where(eq(journalEntries.id, r.depreciationEntryId!)).all()[0]
    expect(depEntry.source).toBe('sale')
    expect(depEntry.description).toMatch(/減価償却（売却年度）/)
    expect(lineByAccount(db, depEntry.id, '減価償却費')).toMatchObject({ side: 'debit', amount: 13_334 })
    expect(lineByAccount(db, depEntry.id, '事業主貸')).toMatchObject({ side: 'debit', amount: 3_333 })

    // 売却（譲渡）仕訳: 借)累計額16,667 借)事業主貸233,333 / 貸)工具器具備品250,000。除却損は無し。
    const disp = db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId!)).all()[0]
    expect(disp.source).toBe('sale')
    expect(disp.description).toMatch(/固定資産売却（譲渡）/)
    expect(lineByAccount(db, disp.id, '減価償却累計額')).toMatchObject({ side: 'debit', amount: 16_667 })
    expect(lineByAccount(db, disp.id, '事業主貸')).toMatchObject({ side: 'debit', amount: 233_333 })
    expect(lineByAccount(db, disp.id, '工具器具備品')).toMatchObject({ side: 'credit', amount: 250_000 })
    expect(lineByAccount(db, disp.id, '固定資産除却損')).toBeUndefined()

    const asset = db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).all()[0]
    expect(asset.status).toBe('sold')
    expect(asset.retiredDate).toBe('2024-09-01')
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('年度末売却（間接法・事業100%・当年度償却済）: 累計額取崩＋簿価を事業主貸へ・除却損なし', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 1_000_000, acquiredDate: '2024-01-01', businessStartDate: '2024-01-01', usefulLife: 5, businessUseRatio: 100, accountId: accId(db, '機械装置') })
    postDepreciation(db, fyId) // 2024: 200,000 → 累計200,000・残高800,000

    const r = sellFixedAsset(db, fyId, id, '2024-12-31')
    expect(r).toMatchObject({ currentYearDepreciation: 0, accumulated: 200_000, bookValue: 800_000, ownerTransfer: 800_000, lossBusiness: 0 })
    const disp = db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId!)).all()[0]
    expect(lineByAccount(db, disp.id, '減価償却累計額')).toMatchObject({ side: 'debit', amount: 200_000 })
    expect(lineByAccount(db, disp.id, '事業主貸')).toMatchObject({ side: 'debit', amount: 800_000 })
    expect(lineByAccount(db, disp.id, '機械装置')).toMatchObject({ side: 'credit', amount: 1_000_000 })
    expect(lineByAccount(db, disp.id, '固定資産除却損')).toBeUndefined()
    expect(db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).all()[0].status).toBe('sold')
    expect(trialBalance(db, fyId).balanced).toBe(true)
  })

  it('直接法の売却: 貸方は簿価・借方は事業主貸・累計額行なし', () => {
    const { db, fyId } = setup(2024)
    db.insert(businessSettings).values({ depreciationRecordMethod: 'direct', createdAt: 'x', updatedAt: 'x' }).run()
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 1_000_000, acquiredDate: '2024-01-01', businessStartDate: '2024-01-01', usefulLife: 5, businessUseRatio: 100, accountId: accId(db, '機械装置') })
    postDepreciation(db, fyId) // 直接法: 貸)機械装置 200,000 → 簿価800,000

    const r = sellFixedAsset(db, fyId, id, '2024-12-15')
    expect(r).toMatchObject({ bookValue: 800_000, ownerTransfer: 800_000 })
    const disp = db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId!)).all()[0]
    expect(lineByAccount(db, disp.id, '事業主貸')).toMatchObject({ side: 'debit', amount: 800_000 })
    expect(lineByAccount(db, disp.id, '機械装置')).toMatchObject({ side: 'credit', amount: 800_000 })
    expect(lineByAccount(db, disp.id, '減価償却累計額')).toBeUndefined()
  })

  it('一括償却資産の売却: 仕訳を起票せず status=sold のみ・3年継続（所令§139）', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '一括', acquisitionCost: 180_000, businessStartDate: '2024-01-01', depreciationMethod: 'lump_sum', businessUseRatio: 100, accountId: accId(db, '工具器具備品') })
    const r = sellFixedAsset(db, fyId, id, '2024-06-30')
    expect(r.entryId).toBeNull()
    expect(r).toMatchObject({ disposalType: 'sale', lossBusiness: 0, ownerTransfer: 0 })
    expect(r.note).toMatch(/3年/)
    expect(r.note).toMatch(/譲渡/)
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'sale')).all()).toHaveLength(0)
    expect(db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).all()[0].status).toBe('sold')
  })

  it('売却済み資産は再処分（除却・売却）できない', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 500_000, businessStartDate: '2024-01-01', usefulLife: 5, accountId: accId(db, '機械装置') })
    sellFixedAsset(db, fyId, id, '2024-06-01')
    expect(() => sellFixedAsset(db, fyId, id, '2024-07-01')).toThrow(/既に売却済み/)
    expect(() => retireFixedAsset(db, fyId, id, '2024-07-01')).toThrow(/既に売却済み/)
  })
})
