import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, fixedAssets } from '../../db/data/schema.js'
import { listFixedAssets, fixedAssetSchedule, createFixedAsset } from '../register.js'

let tmp: string
const USER = 'u_fa'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-fa-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** open 年度を year に設定したシード済み DB。 */
function setup(year: number): DataDb {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: `${year}-01-01`, endDate: `${year}-12-31`, status: 'open', createdAt: '2021-01-01T00:00:00Z' }).run()
  return db
}

// マツダ2: 取得1,508,300 / 中古2年(率0.5) / 2021-08供用(5ヶ月) / 事業50%
// → 2021:314,230  2022:754,150  2023:439,919（残高1）
function mazda(db: DataDb): number {
  return createFixedAsset(db, {
    name: 'マツダ2',
    managementNo: '001',
    acquisitionCost: 1_508_300,
    acquiredDate: '2021-08-10',
    businessStartDate: '2021-08-10',
    usefulLife: 2,
    businessUseRatio: 50,
  })
}

describe('固定資産台帳（定額法・暦年マッピング）', () => {
  it('検算 マツダ2 最終年(2023): 償却439,919 / 経費219,960 / 残高1', () => {
    const db = setup(2023)
    mazda(db)
    const list = listFixedAssets(db)
    expect(list).toHaveLength(1)
    const a = list[0]
    expect(a.supported).toBe(true)
    expect(a.current).toMatchObject({ year: 2023, depreciationAmount: 439919, businessAmount: 219960, closingBookValue: 1 })
    expect(a.bookValue).toBe(1)
  })

  it('初年度(2021)は5ヶ月月割で314,230・経費157,115', () => {
    const db = setup(2021)
    mazda(db)
    const a = listFixedAssets(db)[0]
    expect(a.current).toMatchObject({ year: 2021, openingBookValue: 1_508_300, depreciationAmount: 314230, businessAmount: 157115 })
  })

  it('全期間スケジュールは3年・暦年が連続し最終残高1', () => {
    const db = setup(2023)
    const id = mazda(db)
    const { supported, years } = fixedAssetSchedule(db, id)
    expect(supported).toBe(true)
    expect(years.map((y) => y.year)).toEqual([2021, 2022, 2023])
    expect(years.map((y) => y.depreciationAmount)).toEqual([314230, 754150, 439919])
    expect(years[2].closingBookValue).toBe(1)
  })

  it('償却完了後の年度(2024)は当年償却なし・備忘1円据え置き', () => {
    const db = setup(2024)
    mazda(db)
    const a = listFixedAssets(db)[0]
    expect(a.current).toBeNull()
    expect(a.bookValue).toBe(1)
  })

  it('供用前の年度(2020)は未供用・取得価額のまま', () => {
    const db = setup(2020)
    mazda(db)
    const a = listFixedAssets(db)[0]
    expect(a.current).toBeNull()
    expect(a.bookValue).toBe(1_508_300)
  })

  it('定率法(200%)は耐用年数から償却率を解決し supported=true（初年度＝残高×償却率）', () => {
    const db = setup(2023)
    // 耐用年数5年 → 償却率0.4。初年度 500,000×0.4=200,000・残高300,000。
    createFixedAsset(db, { name: '機械', acquisitionCost: 500_000, businessStartDate: '2023-01-01', depreciationMethod: 'declining_balance', usefulLife: 5 })
    const a = listFixedAssets(db)[0]
    expect(a.supported).toBe(true)
    expect(a.current?.depreciationAmount).toBe(200_000)
    expect(a.current?.closingBookValue).toBe(300_000)
    expect(a.bookValue).toBe(300_000)
  })

  it('定率法でも償却率表に未収載の耐用年数・耐用年数なしは supported=false で素通し', () => {
    const db = setup(2023)
    createFixedAsset(db, { name: '未収載', acquisitionCost: 500_000, businessStartDate: '2023-01-01', depreciationMethod: 'declining_balance', usefulLife: 30 })
    createFixedAsset(db, { name: '年数なし', acquisitionCost: 500_000, businessStartDate: '2023-01-01', depreciationMethod: 'declining_balance', usefulLife: null })
    for (const a of listFixedAssets(db)) {
      expect(a.supported).toBe(false)
      expect(a.current).toBeNull()
      expect(a.bookValue).toBe(500_000)
    }
  })

  it('定率法の全期間スケジュール（取得→備忘1円・改定取得価額へ切替）', () => {
    const db = setup(2023)
    const id = createFixedAsset(db, { name: '機械', acquisitionCost: 500_000, businessStartDate: '2023-01-01', depreciationMethod: 'declining_balance', usefulLife: 5 })
    const { supported, years } = fixedAssetSchedule(db, id)
    expect(supported).toBe(true)
    expect(years.map((y) => y.depreciationAmount)).toEqual([200_000, 120_000, 72_000, 54_000, 53_999])
    expect(years[years.length - 1].closingBookValue).toBe(1)
  })

  it('createFixedAsset バリデーション（名称・取得価額・比率）', () => {
    const db = setup(2023)
    expect(() => createFixedAsset(db, { name: '', acquisitionCost: 100 })).toThrow()
    expect(() => createFixedAsset(db, { name: 'x', acquisitionCost: 0 })).toThrow()
    expect(() => createFixedAsset(db, { name: 'x', acquisitionCost: 100, businessUseRatio: 150 })).toThrow()
    expect(() => createFixedAsset(db, { name: 'x', acquisitionCost: 100, businessUseRatio: 50.5 })).toThrow(/整数/) // 非整数%
  })
})

describe('一括償却資産（lump_sum・§5）', () => {
  it('180,000 → 3年×60,000・暦年連続・残高0・按分なし', () => {
    const db = setup(2024)
    const id = createFixedAsset(db, { name: '一括資産', acquisitionCost: 180_000, acquiredDate: '2024-03-01', businessStartDate: '2024-03-01', depreciationMethod: 'lump_sum', businessUseRatio: 50 })
    const { supported, years } = fixedAssetSchedule(db, id)
    expect(supported).toBe(true)
    expect(years.map((y) => y.year)).toEqual([2024, 2025, 2026])
    expect(years.map((y) => y.depreciationAmount)).toEqual([60_000, 60_000, 60_000])
    expect(years[2].closingBookValue).toBe(0)
    // 按分しない（事業50%でも全額が必要経費）。
    expect(years[0]).toMatchObject({ businessAmount: 60_000, householdAmount: 0 })
  })
})

describe('少額減価償却資産特例（minor_special・§6）', () => {
  it('250,000・事業80% → 取得年に全額・経費200,000・家事50,000・残高0', () => {
    const db = setup(2024)
    const id = createFixedAsset(db, { name: '少額資産', acquisitionCost: 250_000, acquiredDate: '2024-05-01', businessStartDate: '2024-05-01', depreciationMethod: 'minor_special', businessUseRatio: 80 })
    const { years } = fixedAssetSchedule(db, id)
    expect(years).toHaveLength(1)
    expect(years[0]).toMatchObject({ year: 2024, depreciationAmount: 250_000, businessAmount: 200_000, householdAmount: 50_000, closingBookValue: 0 })
  })

  it('取得価額30万円以上は少額特例の対象外（登録を拒否・境界299,999は可）', () => {
    const db = setup(2024)
    expect(() => createFixedAsset(db, { name: '高額', acquisitionCost: 300_000, businessStartDate: '2024-05-01', depreciationMethod: 'minor_special' })).toThrow(/30万円未満/)
    expect(() => createFixedAsset(db, { name: '境界', acquisitionCost: 299_999, businessStartDate: '2024-05-01', depreciationMethod: 'minor_special' })).not.toThrow()
  })
})

describe('登録入力の検証（HTTP 境界は無検証キャストのためドメイン層で遮断）', () => {
  it('未知の償却方法は拒否（旧定額/旧定率は台帳表示用に許可）', () => {
    const db = setup(2024)
    const base = { name: '資産', acquisitionCost: 100_000, businessStartDate: '2024-05-01' }
    expect(() => createFixedAsset(db, { ...base, depreciationMethod: 'straightline' })).toThrow(/未対応/)
    expect(() => createFixedAsset(db, { ...base, depreciationMethod: 'old_straight_line' })).not.toThrow()
    expect(() => createFixedAsset(db, { ...base, depreciationMethod: 'old_declining_balance' })).not.toThrow()
  })

  it('日付は YYYY-MM-DD 形式かつ実在日のみ（取得日・供用開始日）', () => {
    const db = setup(2024)
    const base = { name: '資産', acquisitionCost: 100_000 }
    expect(() => createFixedAsset(db, { ...base, businessStartDate: '2024/05/01' })).toThrow(/YYYY-MM-DD/)
    expect(() => createFixedAsset(db, { ...base, businessStartDate: '2024-02-30' })).toThrow(/存在しない日付/)
    expect(() => createFixedAsset(db, { ...base, acquiredDate: 'invalid' })).toThrow(/YYYY-MM-DD/)
    expect(() => createFixedAsset(db, { ...base, businessStartDate: '2024-02-29' })).not.toThrow() // うるう年
  })

  it('耐用年数は正の整数・償却率は 0 < rate <= 1', () => {
    const db = setup(2024)
    const base = { name: '資産', acquisitionCost: 100_000, businessStartDate: '2024-05-01' }
    expect(() => createFixedAsset(db, { ...base, usefulLife: 0 })).toThrow(/正の整数/)
    expect(() => createFixedAsset(db, { ...base, usefulLife: 2.5 })).toThrow(/正の整数/)
    expect(() => createFixedAsset(db, { ...base, usefulLife: NaN })).toThrow(/正の整数/)
    expect(() => createFixedAsset(db, { ...base, depreciationRate: 0 })).toThrow(/償却率/)
    expect(() => createFixedAsset(db, { ...base, depreciationRate: 1.5 })).toThrow(/償却率/)
    expect(() => createFixedAsset(db, { ...base, depreciationRate: NaN })).toThrow(/償却率/)
    expect(() => createFixedAsset(db, { ...base, usefulLife: 4, depreciationRate: 0.25 })).not.toThrow()
  })

  it('償却率は公示率の桁形（小数5桁以内）のみ — 償却計算が整数分数で行われるため', () => {
    const db = setup(2024)
    const base = { name: '資産', acquisitionCost: 100_000, businessStartDate: '2024-05-01' }
    expect(() => createFixedAsset(db, { ...base, depreciationRate: 0.123456 })).toThrow(/小数5桁以内/)
    expect(() => createFixedAsset(db, { ...base, depreciationRate: 1 / 3 })).toThrow(/小数5桁以内/)
    expect(() => createFixedAsset(db, { ...base, depreciationRate: 0.04854 })).not.toThrow() // 5桁（保証率の桁形）
  })

  it('旧データの桁あふれ償却率は supported=false で縮退（一覧を落とさず誤計算もしない）', () => {
    const db = setup(2024)
    // createFixedAsset の検証を通らない率は DB 直接投入（旧データ相当）で再現する。
    db.insert(fixedAssets)
      .values({
        name: '旧データ',
        acquisitionCost: 100_000,
        businessStartDate: '2024-05-01',
        depreciationMethod: 'straight_line',
        depreciationRate: 0.3333333,
        businessUseRatio: 100,
        status: 'active',
        createdAt: 'x',
        updatedAt: 'x',
      })
      .run()
    const list = listFixedAssets(db)
    expect(list).toHaveLength(1)
    expect(list[0].supported).toBe(false)
    expect(list[0].current).toBeNull()
  })
})
