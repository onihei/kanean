import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, fiscalYears, journalLines, rawTransactions, subAccounts } from '../../db/data/schema.js'
import { bankImport } from '../../import/bankImport.js'
import { SUSPENSE_ACCOUNT } from '../../import/bank.js'
import { applyClassification, itemId } from '../classify.js'
import { updateLineAccount } from '../../journal/confirm.js'

/**
 * applyClassification の原子性（issue #141）。
 *
 * 分類の適用は最大で明細数×2回の書き込みになる。途中で失敗（並行確定・明細消失など）したとき、
 * 「一部だけ科目が当たり根拠だけ書かれた明細」と「何も当たっていない明細」が混在してはならない。
 * 失敗の作り込みは updateLineAccount の2回目呼び出しを throw させて模擬する（1回目は実物を通す）。
 */

vi.mock('../../journal/confirm.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../journal/confirm.js')>()
  return { ...mod, updateLineAccount: vi.fn(mod.updateLineAccount) }
})

let tmp: string
const BOOK = 'b_classify_tx'
const REF = 'bank_ufj-1'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-classify-tx-'))
  process.env.DATA_DIR = tmp
  vi.mocked(updateLineAccount).mockClear()
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): { db: DataDb; router: DbRouter; fyId: number } {
  const router = new DbRouter()
  const db = router.bookDb(BOOK)
  seedDataPlane(db)
  const fy = db
    .insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .returning()
    .all()[0]
  db.insert(subAccounts)
    .values({
      accountId: accId(db, '普通預金'),
      name: '三菱UFJ銀行',
      linkedAccountRef: REF,
      importSourceType: 'bank_ufj',
      isActive: true,
      sortOrder: 0,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    .run()
  return { db, router, fyId: fy.id }
}

describe('applyClassification の原子性', () => {
  it('途中で失敗したら全体を巻き戻す（一部適用の中途半端な状態を残さない）', () => {
    const { db, router, fyId } = setup()
    // 同じ摘要の未確定2件 → 1つの answer が2明細に効く（updateLineAccount が2回呼ばれる）
    bankImport(router, BOOK, {
      accountRef: REF,
      transactions: [
        { txnDate: '2026-05-10', amount: 3000, direction: 'out', description: 'デンキダイ' },
        { txnDate: '2026-05-11', amount: 2000, direction: 'out', description: 'デンキダイ' },
      ],
    })
    const suspenseId = accId(db, SUSPENSE_ACCOUNT)
    const before = db.select().from(journalLines).where(eq(journalLines.accountId, suspenseId)).all()
    expect(before).toHaveLength(2)
    const rawPayloadsBefore = db.select().from(rawTransactions).all().map((r) => r.rawPayload)

    // 2回目の適用で並行確定と同種の失敗を模擬（1回目は実物を通す＝1件は本当に UPDATE される）
    const real = vi.mocked(updateLineAccount).getMockImplementation()!
    let calls = 0
    vi.mocked(updateLineAccount).mockImplementation((dbOrTx, lineId, patch) => {
      calls++
      if (calls === 2) throw new Error('確定済み仕訳の明細は変更できません（並行確定の模擬）')
      return real(dbOrTx, lineId, patch)
    })

    expect(() =>
      applyClassification(db, fyId, [
        { id: itemId('デンキダイ'), proposedAccount: '水道光熱費', reason: '電気代', confidence: 'high' },
      ]),
    ).toThrow(/確定済み仕訳の明細は変更できません/)

    // 1件目に当たった科目も巻き戻っている（全明細が未確定勘定のまま）
    const after = db.select().from(journalLines).where(eq(journalLines.accountId, suspenseId)).all()
    expect(after).toHaveLength(2)
    // 根拠の書き戻し（raw_payload の更新）も残っていない＝取込直後と同一
    const rawPayloadsAfter = db.select().from(rawTransactions).all().map((r) => r.rawPayload)
    expect(rawPayloadsAfter).toEqual(rawPayloadsBefore)
    expect(rawPayloadsAfter.some((p) => (p ?? '').includes('水道光熱費'))).toBe(false)
  })

  it('失敗が無ければ従来どおり全件に適用される（トランザクション化で挙動が変わらない）', () => {
    const { db, router, fyId } = setup()
    bankImport(router, BOOK, {
      accountRef: REF,
      transactions: [
        { txnDate: '2026-05-10', amount: 3000, direction: 'out', description: 'デンキダイ' },
        { txnDate: '2026-05-11', amount: 2000, direction: 'out', description: 'デンキダイ' },
      ],
    })
    const r = applyClassification(db, fyId, [
      { id: itemId('デンキダイ'), proposedAccount: '水道光熱費', reason: '電気代', confidence: 'high' },
    ])
    expect(r).toMatchObject({ applied: 2, unmatched: 0, remaining: 0 })
    const suspenseId = accId(db, SUSPENSE_ACCOUNT)
    expect(db.select().from(journalLines).where(eq(journalLines.accountId, suspenseId)).all()).toHaveLength(0)
  })
})
