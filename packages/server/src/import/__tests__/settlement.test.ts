import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, accounts, subAccounts, journalEntries, journalLines, mappingHistory, rawTransactions } from '../../db/data/schema.js'
import { importRows } from '../importer.js'
import { parseBankUfj } from '../parsers/bankUfj.js'
import { parseBankShinsei } from '../parsers/bankShinsei.js'
import { journalizeBatch } from '../../journal/journalize.js'
import { confirmEntry } from '../../journal/confirm.js'
import { deleteEntry } from '../../journal/entries.js'
import { ignoreRawTransaction } from '../rawStatus.js'
import {
  matchTransferCandidates,
  listTransferCandidates,
  listLinkedTransfers,
  linkTransfer,
  unlinkTransfer,
  type TransferMatchRow,
} from '../settlement.js'

describe('matchTransferCandidates（純関数）', () => {
  const row = (id: number, accountRef: string, amount: number, direction: 'in' | 'out', txnDate: string, description?: string): TransferMatchRow => ({ id, accountRef, amount, direction, txnDate, description })

  it('同額・逆方向・別口座・日付近接 → 振替候補（摘要に振替系語が無ければ weak）', () => {
    const c = matchTransferCandidates([row(1, 'a', 100, 'out', '2026-05-10'), row(2, 'b', 100, 'in', '2026-05-11')])
    expect(c).toEqual([{ outId: 1, inId: 2, amount: 100, dateDiffDays: 1, confidence: 'weak' }])
  })

  it('摘要に振替系の語（振替/振込/フリコミ等）があれば strong', () => {
    expect(matchTransferCandidates([row(1, 'a', 100, 'out', '2026-05-10', '振替 B銀行'), row(2, 'b', 100, 'in', '2026-05-10')])[0].confidence).toBe('strong')
    expect(matchTransferCandidates([row(1, 'a', 100, 'out', '2026-05-10'), row(2, 'b', 100, 'in', '2026-05-10', 'ﾌﾘｺﾐ')])[0].confidence).toBe('strong') // 半角カナも NFKC で一致
  })

  it('同一口座・同方向・金額不一致・日付遠隔 は候補にしない', () => {
    expect(matchTransferCandidates([row(1, 'a', 100, 'out', '2026-05-10'), row(2, 'a', 100, 'in', '2026-05-10')])).toEqual([]) // 同口座
    expect(matchTransferCandidates([row(1, 'a', 100, 'out', '2026-05-10'), row(2, 'b', 100, 'out', '2026-05-10')])).toEqual([]) // 同方向
    expect(matchTransferCandidates([row(1, 'a', 100, 'out', '2026-05-10'), row(2, 'b', 200, 'in', '2026-05-10')])).toEqual([]) // 金額不一致
    expect(matchTransferCandidates([row(1, 'a', 100, 'out', '2026-05-10'), row(2, 'b', 100, 'in', '2026-05-20')])).toEqual([]) // 日付遠隔
  })

  it('各明細は高々1ペア（貪欲）。出金2件・入金1件なら1ペアのみ', () => {
    const c = matchTransferCandidates([row(1, 'a', 100, 'out', '2026-05-10'), row(3, 'a', 100, 'out', '2026-05-10'), row(2, 'b', 100, 'in', '2026-05-10')])
    expect(c).toHaveLength(1)
    expect(c[0].inId).toBe(2)
  })
})

let tmp: string
const USER = 'u_settle'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-settle-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}
function subId(db: DataDb, ref: string): number {
  return db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, ref)).all()[0].id
}
function rawByAmount(db: DataDb, amount: number, direction: 'in' | 'out') {
  return db.select().from(rawTransactions).where(eq(rawTransactions.amount, amount)).all().find((r) => r.direction === direction)!
}

const ufjCsv = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/5/10","振替 シンセイ","","100,000","","900,000"'].join('\r\n')
const shinseiCsv = ['"取引日","摘要","出金金額","入金金額","残高","メモ"', '"2026/05/11","振込 UFJ","","100000","1100000",""'].join('\r\n')

/** seed＋年度＋2口座リンク＋両CSV取込＋仕訳化（各 raw が個別 draft を持つ状態）。 */
function setup(): { db: DataDb; router: DbRouter } {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  const futsu = accId(db, '普通預金')
  db.insert(subAccounts).values([
    { accountId: futsu, name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    { accountId: futsu, name: '新生普通', linkedAccountRef: 'shinsei-1', isActive: true, sortOrder: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
  ]).run()
  const b1 = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(ufjCsv).rows })
  journalizeBatch(db, b1.batchId)
  const b2 = importRows(router, USER, { sourceType: 'bank_shinsei', accountRef: 'shinsei-1', rows: parseBankShinsei(shinseiCsv).rows })
  journalizeBatch(db, b2.batchId)
  return { db, router }
}

describe('口座間振替の名寄せ（settlement・Phase3）', () => {
  it('候補検知: 別口座・同額・逆方向・日付近接が候補に出る', () => {
    const { db } = setup()
    const cands = listTransferCandidates(db)
    expect(cands).toHaveLength(1)
    expect(cands[0].amount).toBe(100000)
    expect(cands[0].out.accountRef).toBe('ufj-1234')
    expect(cands[0].in.accountRef).toBe('shinsei-1')
    expect(cands[0].confidence).toBe('strong') // 摘要が「振替 シンセイ」「振込 UFJ」＝裏付けあり
  })

  it('名寄せ: 2本の draft を 1本の振替仕訳（借)入金口座 / 貸)出金口座）に統合し二重計上しない', () => {
    const { db } = setup()
    const out = rawByAmount(db, 100000, 'out')
    const inn = rawByAmount(db, 100000, 'in')
    const entriesBefore = db.select().from(journalEntries).all().length // 2 個別 draft
    expect(entriesBefore).toBe(2)

    linkTransfer(db, out.id, inn.id)

    // 個別 draft 2本が消え、振替 1本のみ。
    const entries = db.select().from(journalEntries).all()
    expect(entries).toHaveLength(1)
    const transfer = entries[0]
    expect(transfer.source).toBe('transfer')
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, transfer.id)).all()
    const debit = lines.find((l) => l.side === 'debit')!
    const credit = lines.find((l) => l.side === 'credit')!
    expect(debit.accountId).toBe(accId(db, '普通預金'))
    expect(debit.subAccountId).toBe(subId(db, 'shinsei-1')) // 入金側＝借方
    expect(credit.subAccountId).toBe(subId(db, 'ufj-1234')) // 出金側＝貸方
    expect(debit.amount).toBe(100000)
    expect(credit.amount).toBe(100000)

    // 両 raw が同じ振替 entry を指し相互リンク。候補からは消える。
    const o2 = db.select().from(rawTransactions).where(eq(rawTransactions.id, out.id)).all()[0]
    const i2 = db.select().from(rawTransactions).where(eq(rawTransactions.id, inn.id)).all()[0]
    expect(o2.journalEntryId).toBe(transfer.id)
    expect(i2.journalEntryId).toBe(transfer.id)
    expect(o2.settlementRawId).toBe(inn.id)
    expect(i2.settlementRawId).toBe(out.id)
    expect(listTransferCandidates(db)).toHaveLength(0)
    expect(listLinkedTransfers(db)).toHaveLength(1)
  })

  it('名寄せの検証: 同方向・同口座・金額不一致・確定済みは拒否', () => {
    const { db } = setup()
    const out = rawByAmount(db, 100000, 'out')
    const inn = rawByAmount(db, 100000, 'in')
    expect(() => linkTransfer(db, inn.id, out.id)).toThrow(/出金明細と入金明細/) // 引数の向き逆
    // 確定済み拒否: out の draft を確定してから名寄せ
    confirmEntry(db, out.journalEntryId!)
    expect(() => linkTransfer(db, out.id, inn.id)).toThrow(/確定済み/)
  })

  it('解除: 振替 1本を消し、両明細を個別 draft に戻す（settlement リンク解除）', () => {
    const { db } = setup()
    const out = rawByAmount(db, 100000, 'out')
    const inn = rawByAmount(db, 100000, 'in')
    linkTransfer(db, out.id, inn.id)
    unlinkTransfer(db, out.id)

    const entries = db.select().from(journalEntries).all()
    expect(entries).toHaveLength(2) // 個別 draft 2本に戻る
    expect(entries.every((e) => e.source !== 'transfer')).toBe(true)
    const o2 = db.select().from(rawTransactions).where(eq(rawTransactions.id, out.id)).all()[0]
    const i2 = db.select().from(rawTransactions).where(eq(rawTransactions.id, inn.id)).all()[0]
    expect(o2.settlementRawId).toBeNull()
    expect(i2.settlementRawId).toBeNull()
    expect(o2.status).toBe('journalized')
    expect(listTransferCandidates(db)).toHaveLength(1) // 再び候補に戻る
  })

  it('linkTransfer は日付が離れすぎたペアを拒否（write gate・±3日）', () => {
    const { db } = setup()
    const out = rawByAmount(db, 100000, 'out')
    const inn = rawByAmount(db, 100000, 'in')
    db.update(rawTransactions).set({ txnDate: '2026-06-30' }).where(eq(rawTransactions.id, inn.id)).run()
    expect(() => linkTransfer(db, out.id, inn.id)).toThrow(/離れすぎ/)
  })

  it('確定済みの個別仕訳を持つ明細は候補に出ない（押せない名寄せを誘発しない）', () => {
    const { db } = setup()
    const out = rawByAmount(db, 100000, 'out')
    confirmEntry(db, out.journalEntryId!)
    expect(listTransferCandidates(db)).toHaveLength(0)
  })

  it('名寄せ済み明細の ignore は拒否（先に名寄せ解除が必要・孤児化防止）', () => {
    const { db } = setup()
    const out = rawByAmount(db, 100000, 'out')
    const inn = rawByAmount(db, 100000, 'in')
    linkTransfer(db, out.id, inn.id)
    expect(() => ignoreRawTransaction(db, out.id)).toThrow(/名寄せ/)
  })

  it('振替 entry を直接削除すると両明細の settlement_raw_id が解除され候補に復帰（宙吊り無し）', () => {
    const { db } = setup()
    const out = rawByAmount(db, 100000, 'out')
    const inn = rawByAmount(db, 100000, 'in')
    linkTransfer(db, out.id, inn.id)
    const entryId = db.select().from(rawTransactions).where(eq(rawTransactions.id, out.id)).all()[0].journalEntryId!
    deleteEntry(db, entryId)
    const o = db.select().from(rawTransactions).where(eq(rawTransactions.id, out.id)).all()[0]
    const i = db.select().from(rawTransactions).where(eq(rawTransactions.id, inn.id)).all()[0]
    expect(o.settlementRawId).toBeNull()
    expect(i.settlementRawId).toBeNull()
    expect(listTransferCandidates(db)).toHaveLength(1) // 候補に復帰
  })

  it('振替 draft を確定しても mapping_history を汚染しない（決定的再導出のため学習除外）', () => {
    const { db } = setup()
    const out = rawByAmount(db, 100000, 'out')
    const inn = rawByAmount(db, 100000, 'in')
    linkTransfer(db, out.id, inn.id)
    const entryId = db.select().from(rawTransactions).where(eq(rawTransactions.id, out.id)).all()[0].journalEntryId!
    confirmEntry(db, entryId)
    expect(db.select().from(mappingHistory).all()).toHaveLength(0)
  })
})
