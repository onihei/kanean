import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts, subAccounts } from '../../db/data/schema.js'
import { createManualEntry } from '../manualEntry.js'
import { trialBalance, generalLedger } from '../../reports/reports.js'
import { listDrafts } from '../confirm.js'

let tmp: string
const USER = 'u_manual'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-manual-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): { db: DataDb; fyId: number } {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  const fy = db
    .insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .returning()
    .all()[0]
  return { db, fyId: fy.id }
}

describe('手入力・複合仕訳の起票（createManualEntry）', () => {
  it('単純2明細: 借)普通預金 / 貸)売上高 を confirmed で起票し帳票に反映', () => {
    const { db, fyId } = setup()
    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-05-01',
      description: '現金売上',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 50000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 50000 },
      ],
    })
    const entry = db.select().from(journalEntries).where(eq(journalEntries.id, id)).all()[0]
    expect(entry).toMatchObject({ source: 'manual', status: 'confirmed', entryDate: '2026-05-01' })

    const tb = trialBalance(db, fyId)
    expect(tb.balanced).toBe(true)
    expect(tb.rows.find((r) => r.accountName === '普通預金')!.balance).toBe(50000)
    expect(tb.rows.find((r) => r.accountName === '売上高')!.balance).toBe(50000)
  })

  it('複合仕訳: 借)普通預金99,790 借)支払手数料210 / 貸)売上高100,000（借2:貸1）', () => {
    const { db, fyId } = setup()
    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-06-10',
      description: '振込入金（手数料控除）',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 99790 },
        { side: 'debit', accountId: accId(db, '支払手数料'), amount: 210 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 100000 },
      ],
    })
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, id)).all()
    expect(lines).toHaveLength(3)
    expect(lines.map((l) => l.lineNo)).toEqual([1, 2, 3])
    expect(trialBalance(db, fyId).balanced).toBe(true)
    expect(generalLedger(db, fyId, accId(db, '売上高')).closingBalance).toBe(100000)
  })

  it('貸借不一致は拒否', () => {
    const { db, fyId } = setup()
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2026-05-01',
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 50000 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 49999 },
        ],
      }),
    ).toThrow(/貸借不一致/)
    expect(db.select().from(journalEntries).all()).toHaveLength(0)
  })

  it('明細1件のみ・0円・負数は拒否', () => {
    const { db, fyId } = setup()
    const cash = accId(db, '普通預金')
    const sales = accId(db, '売上高')
    expect(() => createManualEntry(db, { fiscalYearId: fyId, entryDate: '2026-05-01', lines: [{ side: 'debit', accountId: cash, amount: 100 }] })).toThrow(/2明細以上/)
    expect(() =>
      createManualEntry(db, { fiscalYearId: fyId, entryDate: '2026-05-01', lines: [{ side: 'debit', accountId: cash, amount: 0 }, { side: 'credit', accountId: sales, amount: 0 }] }),
    ).toThrow(/正の整数/)
    expect(() =>
      createManualEntry(db, { fiscalYearId: fyId, entryDate: '2026-05-01', lines: [{ side: 'debit', accountId: cash, amount: -100 }, { side: 'credit', accountId: sales, amount: -100 }] }),
    ).toThrow(/正の整数/)
  })

  it('会計期間外の日付は拒否（期間ゲート）', () => {
    const { db, fyId } = setup()
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2027-01-05',
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 100 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 100 },
        ],
      }),
    ).toThrow(/範囲外/)
  })

  it('補助科目が勘定科目に属さない場合は拒否', () => {
    const { db, fyId } = setup()
    const cash = accId(db, '普通預金')
    const sales = accId(db, '売上高')
    // 売上高の下に補助科目を作り、普通預金明細に誤って付与する。
    const sub = db
      .insert(subAccounts)
      .values({ accountId: sales, name: 'A店', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' })
      .returning()
      .all()[0]
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2026-05-01',
        lines: [
          { side: 'debit', accountId: cash, subAccountId: sub.id, amount: 100 },
          { side: 'credit', accountId: sales, amount: 100 },
        ],
      }),
    ).toThrow(/属しません/)
  })

  it('実在しない日付（2026-02-30）は範囲内でも拒否', () => {
    const { db, fyId } = setup()
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2026-02-30',
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 100 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 100 },
        ],
      }),
    ).toThrow(/存在しない日付/)
  })

  it('closed 年度には起票不可', () => {
    const { db } = setup()
    const closed = db
      .insert(fiscalYears)
      .values({ startDate: '2025-01-01', endDate: '2025-12-31', status: 'closed', createdAt: '2025-01-01T00:00:00Z' })
      .returning()
      .all()[0]
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: closed.id,
        entryDate: '2025-06-01',
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 100 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 100 },
        ],
      }),
    ).toThrow(/closed/)
  })

  it('安全整数域外の金額は拒否（精度破壊の防止）', () => {
    const { db, fyId } = setup()
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2026-05-01',
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 1e21 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 1e21 },
        ],
      }),
    ).toThrow(/安全な整数/)
  })

  it('税額が負・金額超過は拒否', () => {
    const { db, fyId } = setup()
    const cash = accId(db, '普通預金')
    const sales = accId(db, '売上高')
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2026-05-01',
        lines: [
          { side: 'debit', accountId: cash, amount: 1100 },
          { side: 'credit', accountId: sales, taxAmount: -100, amount: 1100 },
        ],
      }),
    ).toThrow(/税額は0以上/)
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2026-05-01',
        lines: [
          { side: 'debit', accountId: cash, amount: 1100 },
          { side: 'credit', accountId: sales, taxAmount: 2000, amount: 1100 },
        ],
      }),
    ).toThrow(/税額が金額を超え/)
  })

  it('status の不正値は拒否（HTTP 境界は無検証キャストのため実行時に遮断）', () => {
    const { db, fyId } = setup()
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2026-05-01',
        status: 'CONFIRMED' as 'confirmed', // 型を偽装した不正値（as キャスト経由の侵入を再現）
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 100 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 100 },
        ],
      }),
    ).toThrow(/status は draft \/ confirmed/)
  })

  it('システム予約 source（depreciation 等）は拒否（期末処理の洗い替えで黙って消える事故防止）', () => {
    const { db, fyId } = setup()
    for (const source of ['depreciation', 'proration', 'retirement', 'sale', 'rollover']) {
      expect(() =>
        createManualEntry(db, {
          fiscalYearId: fyId,
          entryDate: '2026-05-01',
          source,
          lines: [
            { side: 'debit', accountId: accId(db, '普通預金'), amount: 100 },
            { side: 'credit', accountId: accId(db, '売上高'), amount: 100 },
          ],
        }),
      ).toThrow(/システム予約/)
    }
    // 'invoice' 等の非予約 source は従来どおり通る。
    expect(() =>
      createManualEntry(db, {
        fiscalYearId: fyId,
        entryDate: '2026-05-01',
        source: 'invoice',
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 100 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 100 },
        ],
      }),
    ).not.toThrow()
  })

  it('status=draft は確認待ち一覧に出る（確定はしない）', () => {
    const { db, fyId } = setup()
    createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-05-01',
      description: '下書き',
      status: 'draft',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 100 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 100 },
      ],
    })
    expect(listDrafts(db, fyId)).toHaveLength(1)
    expect(trialBalance(db, fyId).rows).toHaveLength(0) // confirmed のみ集計
  })
})
