import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq, sql } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, depreciationEntries, accounts, businessSettings, fixedAssets } from '../../db/data/schema.js'
import { createFixedAsset } from '../register.js'
import { postDepreciation } from '../posting.js'
import { retireFixedAsset, sellFixedAsset } from '../retirement.js'
import { deleteEntry } from '../../journal/entries.js'
import { trialBalance, profitAndLoss } from '../../reports/reports.js'

let tmp: string
const USER = 'u_dep_post'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-deppost-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(year: number): { db: DataDb; fyId: number } {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const fy = db
    .insert(fiscalYears)
    .values({ startDate: `${year}-01-01`, endDate: `${year}-12-31`, status: 'open', createdAt: '2021-01-01T00:00:00Z' })
    .returning()
    .all()[0]
  return { db, fyId: fy.id }
}

// マツダ2 最終年(2023): 償却439,919 / 経費219,960 / 家事219,959 / 残高1
function mazda(db: DataDb): number {
  return createFixedAsset(db, {
    name: 'マツダ2',
    acquisitionCost: 1_508_300,
    businessStartDate: '2021-08-10',
    usefulLife: 2,
    businessUseRatio: 50,
  })
}

describe('減価償却の仕訳起票（間接法・按分・洗い替え）', () => {
  it('間接法: 借)減価償却費219,960 + 借)事業主貸219,959 / 貸)累計額439,919', () => {
    const { db, fyId } = setup(2023)
    const assetId = mazda(db)
    const r = postDepreciation(db, fyId)
    expect(r).toMatchObject({ recordMethod: 'indirect', posted: 1, totalDepreciation: 439919, totalBusinessAmount: 219960 })

    const entry = db.select().from(journalEntries).where(eq(journalEntries.source, 'depreciation')).all()[0]
    expect(entry.status).toBe('confirmed')
    expect(entry.entryDate).toBe('2023-12-31')

    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).all()
    const byAcc = (name: string) => lines.find((l) => l.accountId === accId(db, name))
    expect(byAcc('減価償却費')).toMatchObject({ side: 'debit', amount: 219960 })
    expect(byAcc('事業主貸')).toMatchObject({ side: 'debit', amount: 219959 })
    expect(byAcc('減価償却累計額')).toMatchObject({ side: 'credit', amount: 439919 })

    // depreciation_entries 永続化。
    const de = db.select().from(depreciationEntries).where(eq(depreciationEntries.fixedAssetId, assetId)).all()[0]
    expect(de).toMatchObject({ depreciationAmount: 439919, businessAmount: 219960, closingBookValue: 1, journalEntryId: entry.id })
  })

  it('仕訳は貸借一致し、P/L 経費に必要経費分だけ載る', () => {
    const { db, fyId } = setup(2023)
    mazda(db)
    postDepreciation(db, fyId)
    const tb = trialBalance(db, fyId)
    expect(tb.balanced).toBe(true)
    const pl = profitAndLoss(db, fyId)
    expect(pl.expenses.rows.find((r) => r.accountName === '減価償却費')!.balance).toBe(219960)
  })

  it('再実行で洗い替え（重複しない）', () => {
    const { db, fyId } = setup(2023)
    mazda(db)
    postDepreciation(db, fyId)
    postDepreciation(db, fyId)
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'depreciation')).all()).toHaveLength(1)
    expect(db.select().from(depreciationEntries).all()).toHaveLength(1)
  })

  it('事業100%なら事業主貸の行は無く減価償却費=全額', () => {
    const { db, fyId } = setup(2023)
    createFixedAsset(db, { name: '備品', acquisitionCost: 1_508_300, businessStartDate: '2021-08-10', usefulLife: 2, businessUseRatio: 100 })
    postDepreciation(db, fyId)
    const entry = db.select().from(journalEntries).where(eq(journalEntries.source, 'depreciation')).all()[0]
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).all()
    expect(lines).toHaveLength(2)
    expect(lines.find((l) => l.accountId === accId(db, '事業主貸'))).toBeUndefined()
    expect(lines.find((l) => l.accountId === accId(db, '減価償却費'))!.amount).toBe(439919)
  })

  it('償却対象年度でなければ起票0件', () => {
    const { db, fyId } = setup(2030)
    mazda(db)
    expect(postDepreciation(db, fyId).posted).toBe(0)
  })

  it('直接法: 資産科目が貸方、未設定なら skip', () => {
    const { db, fyId } = setup(2023)
    db.insert(businessSettings)
      .values({ depreciationRecordMethod: 'direct', createdAt: '2021-01-01T00:00:00Z', updatedAt: '2021-01-01T00:00:00Z' })
      .run()
    // 資産科目あり（車両運搬具）。
    createFixedAsset(db, { name: '車', acquisitionCost: 1_508_300, businessStartDate: '2021-08-10', usefulLife: 2, businessUseRatio: 50, accountId: accId(db, '車両運搬具') })
    // 資産科目なし → skip。
    mazda(db)
    const r = postDepreciation(db, fyId)
    expect(r.recordMethod).toBe('direct')
    expect(r.posted).toBe(1)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0].name).toBe('マツダ2')

    const entry = db
      .select()
      .from(journalEntries)
      .where(and(eq(journalEntries.source, 'depreciation')))
      .all()[0]
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, entry.id)).all()
    expect(lines.find((l) => l.side === 'credit')!.accountId).toBe(accId(db, '車両運搬具'))
  })
})

describe('clearExisting の洗い替え（孤立行・除却起票分の保護）', () => {
  it('減価償却仕訳を手動削除→再起票しても depreciation_entries は二重化しない（孤立行も洗い替え）', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 1_000_000, businessStartDate: '2024-01-01', usefulLife: 5, businessUseRatio: 100, accountId: accId(db, '機械装置') })
    postDepreciation(db, fyId)
    // 減価償却仕訳を手動削除（deleteEntry は depreciation_entries.journalEntryId を null 化＝孤立行が残る）。
    const depEntryId = db.select().from(journalEntries).where(eq(journalEntries.source, 'depreciation')).all()[0].id
    deleteEntry(db, depEntryId)
    // 再起票。孤立行を洗い替えできないと 2行に二重化する（本リグレッションの再現）。
    postDepreciation(db, fyId)
    const entries = db.select().from(depreciationEntries).where(eq(depreciationEntries.fixedAssetId, id)).all()
    expect(entries).toHaveLength(1)
    expect(entries[0].depreciationAmount).toBe(200_000)
    // 除却損も正しい残高で算定される（accumulated=200,000 / bookValue=800,000）。
    const r = retireFixedAsset(db, fyId, id, '2024-12-31')
    expect(r.accumulated).toBe(200_000)
    expect(r.bookValue).toBe(800_000)
  })

  it('除却処理が起票した月割償却（source=retirement）は postDepreciation の洗い替えで消えない', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '器具', acquisitionCost: 250_000, acquiredDate: '2024-06-01', businessStartDate: '2024-06-01', usefulLife: 5, businessUseRatio: 100, accountId: accId(db, '工具器具備品') })
    const r = retireFixedAsset(db, fyId, id, '2024-09-01') // 4ヶ月の月割償却を source='retirement' で起票
    expect(r.depreciationEntryId).not.toBeNull()
    // 期末に postDepreciation（retired 資産は skip。除却起票の depreciation_entries を消さないこと）。
    postDepreciation(db, fyId)
    const entries = db.select().from(depreciationEntries).where(eq(depreciationEntries.fixedAssetId, id)).all()
    expect(entries).toHaveLength(1)
    expect(entries[0].journalEntryId).toBe(r.depreciationEntryId)
  })
})

describe('一括償却資産は除却後も3年均等償却を継続する（§5・slice6）', () => {
  it('期中除却後も翌年・翌々年に1/3を起票し、3年で残高0・4年目以降は起票しない', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, {
      name: '一括備品',
      acquisitionCost: 180_000, // 3年均等＝各60,000
      acquiredDate: '2024-01-01',
      businessStartDate: '2024-01-01',
      depreciationMethod: 'lump_sum',
      businessUseRatio: 100,
      accountId: accId(db, '工具器具備品'),
    })
    // 2024: 起票（60,000）→ 6/30 に除却（除却損なし・status=retired）。
    expect(postDepreciation(db, fyId).posted).toBe(1)
    retireFixedAsset(db, fyId, id, '2024-06-30')
    expect(db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).all()[0].status).toBe('retired')

    const postYear = (year: number) => {
      const fy = db
        .insert(fiscalYears)
        .values({ startDate: `${year}-01-01`, endDate: `${year}-12-31`, status: 'open', createdAt: '2021-01-01T00:00:00Z' })
        .returning()
        .all()[0]
      return { fy, r: postDepreciation(db, fy.id) }
    }

    // 2025・2026: 除却済みでも継続起票（各60,000）。
    const y2025 = postYear(2025)
    expect(y2025.r).toMatchObject({ posted: 1, totalDepreciation: 60_000 })
    const y2026 = postYear(2026)
    expect(y2026.r.posted).toBe(1)
    // 4年目（2027）は schedule 終端のため起票なし。
    expect(postYear(2027).r.posted).toBe(0)

    // depreciation_entries は 2024/2025/2026 の3件、累計180,000・期末残高0。
    const des = db.select().from(depreciationEntries).where(eq(depreciationEntries.fixedAssetId, id)).all()
    expect(des).toHaveLength(3)
    expect(des.reduce((s, e) => s + e.depreciationAmount, 0)).toBe(180_000)
    expect(des.find((e) => e.fiscalYearId === y2026.fy.id)!.closingBookValue).toBe(0)
  })

  it('除却済みでも straight_line は継続起票しない（lump_sum 限定）', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 600_000, businessStartDate: '2024-01-01', usefulLife: 5, businessUseRatio: 100, accountId: accId(db, '機械装置') })
    postDepreciation(db, fyId)
    retireFixedAsset(db, fyId, id, '2024-12-31')
    const fy2025 = db.insert(fiscalYears).values({ startDate: '2025-01-01', endDate: '2025-12-31', status: 'open', createdAt: '2021-01-01T00:00:00Z' }).returning().all()[0]
    expect(postDepreciation(db, fy2025.id).posted).toBe(0)
  })

  it('売却済み（status=sold）の lump_sum も翌年継続起票する（所令§139）', () => {
    const { db, fyId } = setup(2024)
    const id = createFixedAsset(db, { name: '一括', acquisitionCost: 180_000, businessStartDate: '2024-01-01', depreciationMethod: 'lump_sum', businessUseRatio: 100, accountId: accId(db, '工具器具備品') })
    expect(postDepreciation(db, fyId).posted).toBe(1) // 2024: 60,000
    sellFixedAsset(db, fyId, id, '2024-06-30')
    expect(db.select().from(fixedAssets).where(eq(fixedAssets.id, id)).all()[0].status).toBe('sold')
    const fy2025 = db.insert(fiscalYears).values({ startDate: '2025-01-01', endDate: '2025-12-31', status: 'open', createdAt: '2021-01-01T00:00:00Z' }).returning().all()[0]
    expect(postDepreciation(db, fy2025.id)).toMatchObject({ posted: 1, totalDepreciation: 60_000 })
  })
})

describe('洗い替えの原子性', () => {
  it('再起票が途中で失敗したら全体がロールバックされ、既存の起票が無傷で残る', () => {
    const { db, fyId } = setup(2023)
    mazda(db)
    createFixedAsset(db, { name: '備品B', acquisitionCost: 1_508_300, businessStartDate: '2021-08-10', usefulLife: 2, businessUseRatio: 100 })
    postDepreciation(db, fyId)
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'depreciation')).all()).toHaveLength(2)

    // 2件目（備品B）の起票で失敗させ、「既存削除済み・新規は一部だけ」の途中失敗を再現する。
    db.run(
      sql`CREATE TRIGGER fail_mid AFTER INSERT ON journal_entries WHEN NEW.description = '減価償却 備品B' BEGIN SELECT RAISE(ABORT, 'simulated failure'); END`,
    )
    expect(() => postDepreciation(db, fyId)).toThrow()
    db.run(sql`DROP TRIGGER fail_mid`)

    // 洗い替えの削除ごとロールバックされ、起票済み2件と depreciation_entries が残る。
    expect(db.select().from(journalEntries).where(eq(journalEntries.source, 'depreciation')).all()).toHaveLength(2)
    expect(db.select().from(depreciationEntries).all()).toHaveLength(2)
  })
})

describe('少額減価償却資産特例の年間300万円上限', () => {
  it('25万×13件（計325万）→ 12件起票（300万）・13件目は上限超過でスキップ', () => {
    const { db, fyId } = setup(2024)
    for (let i = 1; i <= 13; i++) {
      createFixedAsset(db, {
        name: `少額資産${String(i).padStart(2, '0')}`,
        acquisitionCost: 250_000, // 各30万円未満（適格）
        acquiredDate: '2024-04-01',
        businessStartDate: '2024-04-01',
        depreciationMethod: 'minor_special',
        businessUseRatio: 100,
      })
    }
    const r = postDepreciation(db, fyId)
    expect(r.posted).toBe(12) // 250,000 × 12 = 3,000,000 まで
    expect(r.totalDepreciation).toBe(3_000_000)
    expect(r.skipped).toHaveLength(1)
    expect(r.skipped[0].reason).toMatch(/300万円上限/)
  })
})
