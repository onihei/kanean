import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, accounts, subAccounts, journalEntries, rawTransactions } from '../../db/data/schema.js'
import { importRows } from '../importer.js'
import { parseBankUfj } from '../parsers/bankUfj.js'
import { journalizeBatch } from '../../journal/journalize.js'
import { confirmEntry } from '../../journal/confirm.js'
import { listRawTransactions, ignoreRawTransaction, restoreRawTransaction } from '../rawStatus.js'

let tmp: string
const USER = 'u_rawstatus'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-raw-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

const csv = [
  '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
  '"2026/5/11","コンビニ","","8,000","","100,000"',
  '"2026/6/1","売上入金","ﾄｲｳｴｱ","","330,000","430,000"',
].join('\r\n')

/** seed＋年度＋口座リンク＋取込。journalize=true なら draft 仕訳まで作る。 */
function setup(journalize = true): { db: DataDb; router: DbRouter; batchId: number } {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  db.insert(subAccounts).values({ accountId: accId(db, '普通預金'), name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }).run()
  const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
  if (journalize) journalizeBatch(db, batch.batchId)
  return { db, router, batchId: batch.batchId }
}

function rawByAmount(db: DataDb, amount: number) {
  return db.select().from(rawTransactions).where(eq(rawTransactions.amount, amount)).all()[0]
}

describe('取込明細の状態ライフサイクル（ignored 退避・Phase3）', () => {
  it('journalized(draft) の明細を ignore→draft が削除され status=ignored・journalEntryId=null', () => {
    const { db } = setup()
    const raw = rawByAmount(db, 8000)
    expect(raw.status).toBe('journalized')
    const entryId = raw.journalEntryId!
    ignoreRawTransaction(db, raw.id)
    const after = rawByAmount(db, 8000)
    expect(after.status).toBe('ignored')
    expect(after.journalEntryId).toBeNull()
    expect(db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).all()).toHaveLength(0)
  })

  it('pending（未仕訳）の明細も ignore できる（仕訳が無い）', () => {
    const { db } = setup(false) // journalize しない＝pending のまま
    const raw = rawByAmount(db, 8000)
    expect(raw.status).toBe('pending')
    ignoreRawTransaction(db, raw.id)
    expect(rawByAmount(db, 8000).status).toBe('ignored')
  })

  it('ignore は冪等（既に ignored なら何もしない）', () => {
    const { db } = setup()
    const raw = rawByAmount(db, 8000)
    ignoreRawTransaction(db, raw.id)
    expect(() => ignoreRawTransaction(db, raw.id)).not.toThrow()
    expect(rawByAmount(db, 8000).status).toBe('ignored')
  })

  it('確定済みの仕訳がある明細は ignore できない（先に確定取消が必要）', () => {
    const { db } = setup()
    const raw = rawByAmount(db, 8000)
    confirmEntry(db, raw.journalEntryId!)
    expect(() => ignoreRawTransaction(db, raw.id)).toThrow(/確定済み/)
    expect(rawByAmount(db, 8000).status).toBe('journalized') // 変わらない
  })

  it('ignored を restore→pending 経由で draft 仕訳が作り直される', () => {
    const { db } = setup()
    const raw = rawByAmount(db, 8000)
    ignoreRawTransaction(db, raw.id)
    restoreRawTransaction(db, raw.id)
    const restored = rawByAmount(db, 8000)
    expect(restored.status).toBe('journalized')
    expect(restored.journalEntryId).not.toBeNull()
    const e = db.select().from(journalEntries).where(eq(journalEntries.id, restored.journalEntryId!)).all()[0]
    expect(e.status).toBe('draft')
  })

  it('restore は ignored 以外を拒否', () => {
    const { db } = setup()
    const raw = rawByAmount(db, 8000)
    expect(() => restoreRawTransaction(db, raw.id)).toThrow(/除外/)
  })

  it('listRawTransactions: 状態フィルタ・source_type・entryStatus を返す', () => {
    const { db } = setup()
    expect(listRawTransactions(db, { status: 'journalized' }).rawTransactions).toHaveLength(2)
    expect(listRawTransactions(db, { status: 'ignored' }).rawTransactions).toHaveLength(0)
    const v = listRawTransactions(db, { status: 'journalized' }).rawTransactions[0]
    expect(v.sourceType).toBe('bank_ufj')
    expect(v.entryStatus).toBe('draft')

    ignoreRawTransaction(db, rawByAmount(db, 8000).id)
    expect(listRawTransactions(db, { status: 'ignored' }).rawTransactions).toHaveLength(1)
    expect(listRawTransactions(db, { status: 'journalized' }).rawTransactions).toHaveLength(1)
    expect(listRawTransactions(db).rawTransactions).toHaveLength(2) // フィルタ無し＝全件
    expect(listRawTransactions(db, { status: 'ignored' }).rawTransactions[0].entryStatus).toBeNull()
  })

  it('listRawTransactions: 500件上限を超えても total/truncated で件数を告知（黙って切らない）', () => {
    const { db, batchId } = setup(false) // pending 2件
    for (let i = 0; i < 501; i++) {
      db.insert(rawTransactions)
        .values({ batchId, txnDate: '2026-02-01', amount: 100 + i, direction: 'out', description: `x${i}`, dedupHash: `h${i}`, accountRef: 'ufj-1234', status: 'pending' })
        .run()
    }
    const res = listRawTransactions(db, { status: 'pending' })
    expect(res.total).toBe(503) // 2 + 501
    expect(res.rawTransactions).toHaveLength(500) // 先頭500のみ
    expect(res.truncated).toBe(true)
  })

  it('restore: 再仕訳に失敗（開いている会計年度なし）したら ignored のまま（pending に取り残さない）', () => {
    const { db } = setup()
    const raw = rawByAmount(db, 8000)
    ignoreRawTransaction(db, raw.id)
    db.update(fiscalYears).set({ status: 'closed' }).run() // open 年度を無くす
    expect(() => restoreRawTransaction(db, raw.id)).toThrow(/会計年度/)
    expect(rawByAmount(db, 8000).status).toBe('ignored') // 補償で ignored へ戻る
  })
})

/** 2026 を closed にして 2027 を open にする（繰越後の状態。opening_balances は本題でないので作らない）。 */
function rollTo2027(db: DataDb): void {
  db.update(fiscalYears).set({ status: 'closed' }).where(eq(fiscalYears.startDate, '2026-01-01')).run()
  db.insert(fiscalYears).values({ startDate: '2027-01-01', endDate: '2027-12-31', status: 'open', createdAt: '2027-01-01T00:00:00Z' }).run()
}

describe('繰越後の取込明細（会計期間ゲート・年スコープ）', () => {
  it('前年度の ignored は復帰できない（400 相当・状態も仕訳も変わらない）', () => {
    const { db } = setup()
    const raw = rawByAmount(db, 8000)
    ignoreRawTransaction(db, raw.id)
    const entriesBefore = db.select().from(journalEntries).all().length
    rollTo2027(db)

    expect(() => restoreRawTransaction(db, raw.id)).toThrow(/範囲外/)
    expect(rawByAmount(db, 8000).status).toBe('ignored')
    expect(db.select().from(journalEntries).all()).toHaveLength(entriesBefore)
  })

  it('前年度の pending も仕訳化されない（バッチ再仕訳は件数で可視化・全体は落とさない）', () => {
    const { db, batchId } = setup(false) // 2026 の pending 2件
    rollTo2027(db)
    // 2027（当期）の明細を1件足す。範囲外の2件は飛ばし、範囲内の1件だけ仕訳化されること。
    db.insert(rawTransactions)
      .values({ batchId, txnDate: '2027-03-01', amount: 4200, direction: 'out', description: '当期分', dedupHash: 'h2027', accountRef: 'ufj-1234', status: 'pending' })
      .run()

    const summary = journalizeBatch(db, batchId)
    expect(summary.drafted).toBe(1)
    expect(summary.skippedOutOfPeriod).toBe(2)
    expect(rawByAmount(db, 8000).status).toBe('pending') // 前年度分は手つかず
    expect(rawByAmount(db, 4200).status).toBe('journalized')
  })

  it('一覧は既定で当年度だけを返し、外した件数を outOfYearTotal で告知する', () => {
    const { db, batchId } = setup(false) // 2026 の pending 2件
    rollTo2027(db)
    db.insert(rawTransactions)
      .values({ batchId, txnDate: '2027-03-01', amount: 4200, direction: 'out', description: '当期分', dedupHash: 'h2027', accountRef: 'ufj-1234', status: 'pending' })
      .run()

    const scoped = listRawTransactions(db, { status: 'pending' })
    expect(scoped.rawTransactions.map((r) => r.amount)).toEqual([4200])
    expect(scoped.total).toBe(1)
    expect(scoped.outOfYearTotal).toBe(2)

    const all = listRawTransactions(db, { status: 'pending', years: 'all' })
    expect(all.rawTransactions).toHaveLength(3)
    expect(all.total).toBe(3)
    expect(all.outOfYearTotal).toBe(0)
  })

  it('開いている会計年度が無ければ絞らない（見えなくなる方が悪い）', () => {
    const { db } = setup(false)
    db.update(fiscalYears).set({ status: 'closed' }).run()
    const res = listRawTransactions(db)
    expect(res.rawTransactions).toHaveLength(2)
    expect(res.total).toBe(2)
    expect(res.outOfYearTotal).toBe(0)
  })

  it('outOfYearTotal は status フィルタを共有する', () => {
    const { db, batchId } = setup(false)
    ignoreRawTransaction(db, rawByAmount(db, 8000).id) // 2026 の1件を ignored に
    rollTo2027(db)
    db.insert(rawTransactions)
      .values({ batchId, txnDate: '2027-03-01', amount: 4200, direction: 'out', description: '当期分', dedupHash: 'h2027', accountRef: 'ufj-1234', status: 'pending' })
      .run()

    expect(listRawTransactions(db, { status: 'pending' }).outOfYearTotal).toBe(1) // 2026 の pending 1件
    expect(listRawTransactions(db, { status: 'ignored' }).outOfYearTotal).toBe(1) // 2026 の ignored 1件
    expect(listRawTransactions(db).outOfYearTotal).toBe(2) // フィルタ無し＝2026 の全件
  })
})
