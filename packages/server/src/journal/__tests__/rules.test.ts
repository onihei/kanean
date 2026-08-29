import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, fiscalYears, journalLines, rawTransactions, subAccounts } from '../../db/data/schema.js'
import { listRules, createRule, updateRule, setRuleActive, deleteRule } from '../rules.js'
import { importRows } from '../../import/importer.js'
import { parseBankUfj } from '../../import/parsers/bankUfj.js'
import { journalizeBatch } from '../journalize.js'

let tmp: string
const USER = 'u_rules'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-rules-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): { db: DataDb; router: DbRouter } {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  // 取込元口座（account_ref → linked_account_ref）。
  db.insert(subAccounts)
    .values({ accountId: accId(db, '普通預金'), name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' })
    .run()
  return { db, router }
}

describe('自動仕訳ルール CRUD', () => {
  it('作成・priority 昇順一覧・更新・無効化・削除', () => {
    const { db } = setup()
    const r2 = createRule(db, { name: 'B', priority: 50, matchField: 'description', matchOp: 'contains', matchValue: 'B社', resultAccountId: accId(db, '通信費') })
    const r1 = createRule(db, { name: 'A', priority: 10, matchField: 'description', matchOp: 'contains', matchValue: 'A社', resultAccountId: accId(db, '水道光熱費') })
    expect(listRules(db).map((r) => r.name)).toEqual(['A', 'B']) // priority 昇順

    updateRule(db, r1, { name: 'A改', priority: 10, matchField: 'description', matchOp: 'contains', matchValue: 'A社', resultAccountId: accId(db, '水道光熱費') })
    expect(listRules(db).find((r) => r.id === r1)!.name).toBe('A改')

    setRuleActive(db, r2, false)
    expect(listRules(db).map((r) => r.id)).toEqual([r1])
    expect(listRules(db, true).map((r) => r.id)).toEqual([r1, r2])

    deleteRule(db, r2)
    expect(listRules(db, true).map((r) => r.id)).toEqual([r1])
  })

  it('matchOp/結果科目の検証（regex/range・補助の belongs-to・科目存在）', () => {
    const { db } = setup()
    const tsuushin = accId(db, '通信費')
    // 不正な正規表現。
    expect(() => createRule(db, { name: 'NG', matchField: 'description', matchOp: 'regex', matchValue: '(', resultAccountId: tsuushin })).toThrow(/正規表現/)
    // range は amount のみ。
    expect(() => createRule(db, { name: 'NG', matchField: 'description', matchOp: 'range', matchValue: '{"min":1}', resultAccountId: tsuushin })).toThrow(/range/)
    // range の JSON 不正。
    expect(() => createRule(db, { name: 'NG', matchField: 'amount', matchOp: 'range', matchValue: 'xxx', resultAccountId: tsuushin })).toThrow(/range/)
    // range: min > max は不一致で死にルールになるため拒否。
    expect(() => createRule(db, { name: 'NG', matchField: 'amount', matchOp: 'range', matchValue: '{"min":5000,"max":1000}', resultAccountId: tsuushin })).toThrow(/min ≤ max/)
    // range: 円整数のみ（小数拒否）。
    expect(() => createRule(db, { name: 'NG', matchField: 'amount', matchOp: 'range', matchValue: '{"min":100.5}', resultAccountId: tsuushin })).toThrow(/整数/)
    // 結果科目が存在しない。
    expect(() => createRule(db, { name: 'NG', matchField: 'description', matchOp: 'contains', matchValue: 'x', resultAccountId: 99999 })).toThrow(/勘定科目/)
    // 補助科目が結果科目に属さない。
    const otherSub = db.select().from(subAccounts).where(eq(subAccounts.accountId, accId(db, '普通預金'))).all()[0].id
    expect(() => createRule(db, { name: 'NG', matchField: 'description', matchOp: 'contains', matchValue: 'x', resultAccountId: tsuushin, resultSubAccountId: otherSub })).toThrow(/属しません/)

    // 正常: range(amount) と regex。
    expect(() => createRule(db, { name: 'OK-range', matchField: 'amount', matchOp: 'range', matchValue: '{"min":1000,"max":5000}', resultAccountId: tsuushin })).not.toThrow()
    expect(() => createRule(db, { name: 'OK-regex', matchField: 'description', matchOp: 'regex', matchValue: '電力|ガス', resultAccountId: tsuushin })).not.toThrow()
  })
})

describe('ルールが取込（journalizeBatch）の相手科目を駆動する', () => {
  it('description 一致ルールで相手科目が自動付与され source=auto_rule', () => {
    const { db, router } = setup()
    createRule(db, { name: '東京電力→水道光熱費', priority: 10, matchField: 'description', matchOp: 'contains', matchValue: '東京電力', direction: 'out', resultAccountId: accId(db, '水道光熱費') })

    const csv = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/5/11","東京電力","","8,000","","100,000"'].join('\r\n')
    const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
    journalizeBatch(db, batch.batchId)

    const raw = db.select().from(rawTransactions).all()[0]
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, raw.journalEntryId!)).all()
    const debit = lines.find((l) => l.side === 'debit')!
    expect(debit.accountId).toBe(accId(db, '水道光熱費')) // ルールで付与
    expect(raw.suggestedAccountId).toBe(accId(db, '水道光熱費'))
  })
})
