import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import {
  fiscalYears,
  journalEntries,
  journalLines,
  accounts,
  subAccounts,
  mappingHistory,
  rawTransactions,
  auditLogs,
} from '../../db/data/schema.js'
import { createManualEntry } from '../manualEntry.js'
import { listEntries, getEntry, updateEntry, unconfirmEntry, deleteEntry, listAuditLogs } from '../entries.js'
import { listDrafts, confirmEntry, updateLineAccount } from '../confirm.js'
import { trialBalance } from '../../reports/reports.js'
import { importRows } from '../../import/importer.js'
import { parseBankUfj } from '../../import/parsers/bankUfj.js'
import { journalizeBatch } from '../journalize.js'

let tmp: string
const USER = 'u_entries'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-entries-'))
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

/** 確定2明細仕訳を1件作る（借)普通預金 / 貸)売上高）。 */
function addConfirmed(db: DataDb, fyId: number, date: string, desc: string, amount: number): number {
  return createManualEntry(db, {
    fiscalYearId: fyId,
    entryDate: date,
    description: desc,
    lines: [
      { side: 'debit', accountId: accId(db, '普通預金'), amount },
      { side: 'credit', accountId: accId(db, '売上高'), amount },
    ],
  })
}

describe('確定済み仕訳の一覧・検索（listEntries / getEntry）', () => {
  it('既定は confirmed のみ。draft は status=draft / all で取得', () => {
    const { db, fyId } = setup()
    addConfirmed(db, fyId, '2026-03-01', '売上A', 10000)
    createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-03-02',
      description: '下書きB',
      status: 'draft',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 5000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 5000 },
      ],
    })

    expect(listEntries(db, fyId).map((e) => e.description)).toEqual(['売上A'])
    expect(listEntries(db, fyId, { status: 'draft' }).map((e) => e.description)).toEqual(['下書きB'])
    expect(listEntries(db, fyId, { status: 'all' })).toHaveLength(2)
  })

  it('日付昇順・期間/摘要/科目で絞り込み、明細と貸借合計を含む', () => {
    const { db, fyId } = setup()
    addConfirmed(db, fyId, '2026-05-10', '入金 5月', 20000)
    addConfirmed(db, fyId, '2026-02-01', '入金 2月', 30000)
    createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-04-01',
      description: '通信費',
      lines: [
        { side: 'debit', accountId: accId(db, '通信費'), amount: 1100 },
        { side: 'credit', accountId: accId(db, '現金'), amount: 1100 },
      ],
    })

    expect(listEntries(db, fyId).map((e) => e.entryDate)).toEqual(['2026-02-01', '2026-04-01', '2026-05-10'])
    expect(listEntries(db, fyId, { from: '2026-03-01', to: '2026-12-31' }).map((e) => e.description)).toEqual(['通信費', '入金 5月'])
    expect(listEntries(db, fyId, { q: '入金' }).map((e) => e.description)).toEqual(['入金 2月', '入金 5月'])
    expect(listEntries(db, fyId, { accountId: accId(db, '普通預金') }).map((e) => e.description)).toEqual(['入金 2月', '入金 5月'])

    const e = listEntries(db, fyId, { q: '通信費' })[0]
    expect(e.debitTotal).toBe(1100)
    expect(e.creditTotal).toBe(1100)
    expect(e.lines).toHaveLength(2)
    expect(getEntry(db, e.id).lines.map((l) => l.accountName)).toContain('通信費')
  })

  it('q の LIKE メタ文字（% _）はエスケープされ素の文字として一致する（listDrafts と同契約・issue #143）', () => {
    const { db, fyId } = setup()
    addConfirmed(db, fyId, '2026-05-10', '50%OFF', 1000)
    addConfirmed(db, fyId, '2026-05-11', 'ﾃﾅﾝﾄ100_ﾔﾁﾝ', 90000)
    addConfirmed(db, fyId, '2026-05-12', 'ｹﾞﾝｷﾝ100X', 5000)
    // '%' がワイルドカード解釈されると全件ヒット、'_' が任意1文字だと 100X もヒットしてしまう。
    expect(listEntries(db, fyId, { q: '%' }).map((e) => e.description)).toEqual(['50%OFF'])
    expect(listEntries(db, fyId, { q: '100_' }).map((e) => e.description)).toEqual(['ﾃﾅﾝﾄ100_ﾔﾁﾝ'])
  })
})

describe('編集（updateEntry, draft のみ・監査ログ）', () => {
  it('draft の明細・金額・摘要を差し替え、監査ログ(update)に before/after を残す', () => {
    const { db, fyId } = setup()
    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-06-01',
      description: '下書き',
      status: 'draft',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 1000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 1000 },
      ],
    })
    updateEntry(db, id, {
      entryDate: '2026-06-05',
      description: '修正後',
      note: '金額誤り訂正',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 2000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 2000 },
      ],
    })
    const e = getEntry(db, id)
    expect(e.entryDate).toBe('2026-06-05')
    expect(e.description).toBe('修正後')
    expect(e.debitTotal).toBe(2000)

    const logs = listAuditLogs(db, id)
    expect(logs).toHaveLength(1)
    expect(logs[0].action).toBe('update')
    expect(logs[0].note).toBe('金額誤り訂正')
    const before = logs[0].before as { entry: { description: string }; lines: { amount: number }[] }
    expect(before.entry.description).toBe('下書き')
    expect(before.lines[0].amount).toBe(1000)
  })

  it('貸借不一致の編集は拒否し、元の明細を保持', () => {
    const { db, fyId } = setup()
    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-06-01',
      status: 'draft',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 1000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 1000 },
      ],
    })
    expect(() =>
      updateEntry(db, id, {
        entryDate: '2026-06-01',
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 1000 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 999 },
        ],
      }),
    ).toThrow(/貸借不一致/)
    expect(getEntry(db, id).debitTotal).toBe(1000)
    expect(listAuditLogs(db, id)).toHaveLength(0)
  })

  it('確定済み仕訳は直接編集できない（確定取消が前提）', () => {
    const { db, fyId } = setup()
    const id = addConfirmed(db, fyId, '2026-06-01', '確定', 1000)
    expect(() =>
      updateEntry(db, id, {
        entryDate: '2026-06-01',
        lines: [
          { side: 'debit', accountId: accId(db, '普通預金'), amount: 2000 },
          { side: 'credit', accountId: accId(db, '売上高'), amount: 2000 },
        ],
      }),
    ).toThrow(/確定済み/)
  })
})

describe('確定取消（unconfirmEntry）', () => {
  it('confirmed → draft に戻り試算表から外れ、監査ログ(unconfirm)が残る', () => {
    const { db, fyId } = setup()
    const id = addConfirmed(db, fyId, '2026-06-01', '売上', 50000)
    expect(trialBalance(db, fyId).rows.find((r) => r.accountName === '売上高')!.balance).toBe(50000)

    unconfirmEntry(db, id, '誤計上のため')
    expect(db.select().from(journalEntries).where(eq(journalEntries.id, id)).all()[0].status).toBe('draft')
    expect(trialBalance(db, fyId).rows).toHaveLength(0)
    expect(listEntries(db, fyId, { status: 'draft' })).toHaveLength(1)

    const logs = listAuditLogs(db, id)
    expect(logs[0].action).toBe('unconfirm')
    expect(logs[0].note).toBe('誤計上のため')
  })

  it('未確定（draft）は確定取消できない', () => {
    const { db, fyId } = setup()
    const id = createManualEntry(db, {
      fiscalYearId: fyId,
      entryDate: '2026-06-01',
      status: 'draft',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 100 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 100 },
      ],
    })
    expect(() => unconfirmEntry(db, id)).toThrow(/確定済み/)
  })
})

describe('削除（deleteEntry, 物理削除＋監査スナップショット）', () => {
  it('明細ごと削除し、監査ログ(delete)に before スナップショットを残す', () => {
    const { db, fyId } = setup()
    const id = addConfirmed(db, fyId, '2026-06-01', '削除対象', 7000)
    deleteEntry(db, id, '重複計上のため削除')

    expect(db.select().from(journalEntries).where(eq(journalEntries.id, id)).all()).toHaveLength(0)
    expect(db.select().from(journalLines).where(eq(journalLines.entryId, id)).all()).toHaveLength(0)

    const logs = listAuditLogs(db, id)
    expect(logs[0].action).toBe('delete')
    expect(logs[0].note).toBe('重複計上のため削除')
    const before = logs[0].before as { entry: { description: string }; lines: unknown[] }
    expect(before.entry.description).toBe('削除対象')
    expect(before.lines).toHaveLength(2)
    expect(logs[0].after).toBeNull()
  })

  it('closed 年度の仕訳は削除できない', () => {
    const { db, fyId } = setup()
    // open のうちに起票してから年度を締める。
    const id = addConfirmed(db, fyId, '2026-06-01', '締め後削除不可', 100)
    db.update(fiscalYears).set({ status: 'closed' }).where(eq(fiscalYears.id, fyId)).run()
    expect(() => deleteEntry(db, id)).toThrow(/closed/)
  })
})

describe('取込仕訳の確定取消・削除（学習連動・raw 復帰）', () => {
  it('確定取消で hit_count を1減算（1→0は行削除）。削除で raw が pending に戻る', () => {
    const router = new DbRouter()
    const db = router.bookDb(USER)
    seedDataPlane(db)
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
    const fy = db.select().from(fiscalYears).all()[0]
    db.insert(subAccounts)
      .values({ accountId: accId(db, '普通預金'), name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' })
      .run()

    const csv = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/6/1","ﾄｲｳｴｱ入金","","","330,000","430,000"'].join('\r\n')
    const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
    journalizeBatch(db, batch.batchId)

    const draft = listDrafts(db, fy.id)[0]
    const counter = draft.lines.find((l) => l.lineNo === 2)!
    updateLineAccount(db, counter.id, { accountId: accId(db, '売上高') })
    confirmEntry(db, draft.id)
    expect(db.select().from(mappingHistory).all()[0].hitCount).toBe(1)

    // 確定取消 → 学習取消（hit_count 1→0 で行削除）
    unconfirmEntry(db, draft.id)
    expect(db.select().from(mappingHistory).all()).toHaveLength(0)
    expect(db.select().from(rawTransactions).all()[0].status).toBe('journalized') // entry はまだ存在

    // 削除 → raw は pending に戻り journalEntryId 解除
    deleteEntry(db, draft.id)
    const raw = db.select().from(rawTransactions).all()[0]
    expect(raw.status).toBe('pending')
    expect(raw.journalEntryId).toBeNull()
    expect(db.select().from(auditLogs).all().some((l) => l.action === 'delete')).toBe(true)
  })
})

describe('確定→確定取消→編集→確定 のフロー（Phase1 Exit①④）', () => {
  it('全操作が監査ログに残り、最終確定後の試算表が一致する', () => {
    const { db, fyId } = setup()
    const id = addConfirmed(db, fyId, '2026-06-01', '売上', 100000)

    unconfirmEntry(db, id)
    updateEntry(db, id, {
      entryDate: '2026-06-01',
      description: '売上（訂正）',
      lines: [
        { side: 'debit', accountId: accId(db, '普通預金'), amount: 120000 },
        { side: 'credit', accountId: accId(db, '売上高'), amount: 120000 },
      ],
    })
    confirmEntry(db, id)

    const tb = trialBalance(db, fyId)
    expect(tb.balanced).toBe(true)
    expect(tb.rows.find((r) => r.accountName === '売上高')!.balance).toBe(120000)

    const actions = listAuditLogs(db, id)
      .map((l) => l.action)
      .sort()
    expect(actions).toEqual(['unconfirm', 'update'].sort())
  })
})
