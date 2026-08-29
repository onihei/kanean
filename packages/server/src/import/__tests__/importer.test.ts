import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DbRouter } from '../../db/router.js'
import { fiscalYears, importBatches, rawTransactions } from '../../db/data/schema.js'
import { importRows } from '../importer.js'
import { backfillDedupHashes } from '../dedupBackfill.js'
import { parseBankUfj } from '../parsers/bankUfj.js'

let tmp: string
const USER = 'u_import'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-import-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function setupOpenYear(router: DbRouter): void {
  const db = router.bookDb(USER) // 初回オープンでマイグレート
  db.insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .run()
}

const csv = [
  '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
  '"2026/5/11","クレジット","","193,945","","37,717,278"',
  '"2026/6/1","水道光熱費","","8,000","","37,709,278"',
  '"2027/1/5","翌期分","","1,000","","37,708,278"', // 翌期＝範囲外
].join('\r\n')

describe('importRows（dedup + 会計期間ゲート）', () => {
  it('開いている期間内のみ取り込み、翌期は除外', () => {
    const router = new DbRouter()
    setupOpenYear(router)
    const summary = importRows(router, USER, {
      sourceType: 'bank_ufj',
      accountRef: 'ufj-1234',
      rows: parseBankUfj(csv).rows,
    })
    expect(summary.inserted).toBe(2)
    expect(summary.skippedOutOfPeriod).toBe(1) // 2027分
    expect(summary.skippedDup).toBe(0)

    const stored = router.bookDb(USER).select().from(rawTransactions).all()
    expect(stored).toHaveLength(2)
    expect(stored.every((r) => r.txnDate >= '2026-01-01' && r.txnDate <= '2026-12-31')).toBe(true)
  })

  it('再取込は全て重複スキップ（冪等）', () => {
    const router = new DbRouter()
    setupOpenYear(router)
    const rows = parseBankUfj(csv).rows
    importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows })
    const again = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows })
    expect(again.inserted).toBe(0)
    expect(again.skippedDup).toBe(2)
    expect(router.bookDb(USER).select().from(rawTransactions).all()).toHaveLength(2)
  })

  it('同日同額同摘要が複数でも全件取込・再取込は冪等（取りこぼし0・二重計上なし・内訳返却）', () => {
    const router = new DbRouter()
    setupOpenYear(router)
    // 残高まで完全同一の同日同額同摘要が2件（旧実装では1件しか入らなかった）。
    const dupCsv = [
      '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
      '"2026/5/11","自販機","","150","","1000"',
      '"2026/5/11","自販機","","150","","1000"',
    ].join('\r\n')
    const rows = parseBankUfj(dupCsv).rows

    const first = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1', rows })
    expect(first.inserted).toBe(2) // 全件取込（取りこぼし0）
    expect(first.skippedDup).toBe(0)
    expect(first.duplicates).toHaveLength(0)
    expect(router.bookDb(USER).select().from(rawTransactions).all()).toHaveLength(2)

    const again = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1', rows })
    expect(again.inserted).toBe(0) // 冪等（二重計上なし）
    expect(again.skippedDup).toBe(2)
    expect(again.duplicates).toHaveLength(2) // 黙って落とさず内訳を返す
    expect(again.duplicates[0]).toMatchObject({ txnDate: '2026-05-11', amount: 150, direction: 'out', description: '自販機' })
    expect(router.bookDb(USER).select().from(rawTransactions).all()).toHaveLength(2)
  })

  it('dedup_hash 移行バックフィル: 旧スキーム取込済みでも再ハッシュ後は同一CSV再取込が冪等（二重計上しない）', () => {
    const router = new DbRouter()
    setupOpenYear(router)
    const db = router.bookDb(USER)
    const rows = parseBankUfj(csv).rows.filter((r) => r.txnDate <= '2026-12-31') // 期間内2件

    // 旧スキーム相当で取込済みの行を直接投入（dedup_hash は新方式と一致しない任意値）。
    const batch = db
      .insert(importBatches)
      .values({ sourceType: 'bank_ufj', accountRef: 'ufj-1234', importedAt: 'x', rowCount: rows.length, status: 'done' })
      .returning()
      .all()[0]
    rows.forEach((r, i) =>
      db
        .insert(rawTransactions)
        .values({
          batchId: batch.id,
          txnDate: r.txnDate,
          amount: r.amount,
          direction: r.direction,
          description: r.description,
          rawPayload: r.rawPayload,
          dedupHash: `OLD_SCHEME_${i}`, // 旧方式のダミー hash（新方式と不一致）
          accountRef: 'ufj-1234',
          status: 'pending',
        })
        .run(),
    )
    expect(db.select().from(rawTransactions).all()).toHaveLength(2)

    // バックフィルで新方式 hash に揃える（冪等）。
    expect(backfillDedupHashes(db)).toBe(2)
    // 移行後、同一CSVの再取込は新方式 hash が一致＝衝突で二重計上しない。
    const again = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows })
    expect(again.inserted).toBe(0)
    expect(again.skippedDup).toBe(2)
    expect(db.select().from(rawTransactions).all()).toHaveLength(2)
    // 再度バックフィルしても更新0（冪等）。
    expect(backfillDedupHashes(db)).toBe(0)
  })

  it('dedup_hash 移行バックフィル: 同日同額同摘要の重複行も出現インデックスまで取込時と一致する', () => {
    const router = new DbRouter()
    setupOpenYear(router)
    const db = router.bookDb(USER)
    // 出現インデックス次元の乖離を検出する fixture（内容が完全同一の2行 → n=0,1 で distinct hash）。
    const dupCsv = [
      '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
      '"2026/5/11","自販機","","150","","1000"',
      '"2026/5/11","自販機","","150","","1000"',
    ].join('\r\n')
    const rows = parseBankUfj(dupCsv).rows

    const batch = db
      .insert(importBatches)
      .values({ sourceType: 'bank_ufj', accountRef: 'ufj-1234', importedAt: 'x', rowCount: rows.length, status: 'done' })
      .returning()
      .all()[0]
    rows.forEach((r, i) =>
      db
        .insert(rawTransactions)
        .values({
          batchId: batch.id,
          txnDate: r.txnDate,
          amount: r.amount,
          direction: r.direction,
          description: r.description,
          rawPayload: r.rawPayload,
          dedupHash: `OLD_SCHEME_${i}`,
          accountRef: 'ufj-1234',
          status: 'pending',
        })
        .run(),
    )

    expect(backfillDedupHashes(db)).toBe(2)
    // 出現インデックス（0,1）まで取込時のレシピと一致 → 全行 distinct かつ再取込で全件衝突。
    const hashes = db.select().from(rawTransactions).all().map((r) => r.dedupHash)
    expect(new Set(hashes).size).toBe(2)
    const again = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows })
    expect(again.inserted).toBe(0)
    expect(again.skippedDup).toBe(2)
    expect(db.select().from(rawTransactions).all()).toHaveLength(2)
    expect(backfillDedupHashes(db)).toBe(0)
  })

  it('会計年度が無ければ例外', () => {
    const router = new DbRouter()
    router.bookDb(USER) // マイグレートのみ（fiscal year なし）
    expect(() =>
      importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows }),
    ).toThrow()
  })

  it('部分取込: parseErrors があり正常行も入れば status=partial、内訳を batch に保存・返却', () => {
    const router = new DbRouter()
    setupOpenYear(router)
    const { rows, errors } = parseBankUfj(
      [
        '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
        '"2026/5/11","正常","","100","","1000"',
        '"baddate","不正日付","","200","","900"', // 日付不正→退避
      ].join('\r\n'),
    )
    expect(rows).toHaveLength(1)
    expect(errors).toHaveLength(1)

    const db = router.bookDb(USER)
    const summary = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1', rows, parseErrors: errors })
    expect(summary.inserted).toBe(1) // 正常行は取り込む
    expect(summary.status).toBe('partial') // 一部失敗
    expect(summary.errorCount).toBe(1)
    expect(summary.errors[0].message).toMatch(/日付/)

    // batch に status / error_count / error_sample が保存される。
    const batch = db.select().from(importBatches).all()[0]
    expect(batch.status).toBe('partial')
    expect(batch.errorCount).toBe(1)
    expect(JSON.parse(batch.errorSample!)).toHaveLength(1)
  })

  it('部分取込: 全行成功なら status=done・errorCount 0・error_sample は null', () => {
    const router = new DbRouter()
    setupOpenYear(router)
    const { rows } = parseBankUfj(
      ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/5/11","正常","","100","","1000"'].join('\r\n'),
    )
    const summary = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1', rows })
    expect(summary.status).toBe('done')
    expect(summary.errorCount).toBe(0)
    const batch = router.bookDb(USER).select().from(importBatches).all()[0]
    expect(batch.status).toBe('done')
    expect(batch.errorSample).toBeNull()
  })
})
