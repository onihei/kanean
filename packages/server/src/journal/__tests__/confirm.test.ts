import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, accounts, subAccounts, journalEntries, journalLines, taxCategories, mappingHistory } from '../../db/data/schema.js'
import { importRows } from '../../import/importer.js'
import { parseBankUfj } from '../../import/parsers/bankUfj.js'
import { journalizeBatch } from '../journalize.js'
import { listDrafts, updateLineAccount, confirmEntry } from '../confirm.js'

let tmp: string
const USER = 'u_confirm'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-confirm-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup() {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  const fy = db.select().from(fiscalYears).all()[0]
  db.insert(subAccounts).values({ accountId: accId(db, '普通預金'), name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' }).run()
  const csv = [
    '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
    '"2026/6/1","ﾄｲｳｴｱ入金","","","330,000","430,000"',
  ].join('\r\n')
  const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
  journalizeBatch(db, batch.batchId)
  return { db, fy }
}

describe('確認画面フロー（listDrafts → 修正 → confirm → 履歴学習）', () => {
  it('draft一覧→相手科目を売上高に修正→確定で confirmed＆履歴記録', () => {
    const { db, fy } = setup()
    const drafts = listDrafts(db, fy.id)
    expect(drafts).toHaveLength(1)
    const draft = drafts[0]
    // 入金: 借)普通預金 / 貸)未確定勘定（line_no=2）
    const counter = draft.lines.find((l) => l.lineNo === 2)!
    expect(counter.accountName).toBe('未確定勘定')

    updateLineAccount(db, counter.id, { accountId: accId(db, '売上高') })
    confirmEntry(db, draft.id)

    expect(db.select().from(journalEntries).where(eq(journalEntries.id, draft.id)).all()[0].status).toBe('confirmed')

    // 履歴学習: 摘要「ﾄｲｳｴｱ入金」→ 売上高
    const hist = db.select().from(mappingHistory).all()
    expect(hist).toHaveLength(1)
    expect(hist[0].pattern).toBe('ﾄｲｳｴｱ入金')
    expect(hist[0].accountId).toBe(accId(db, '売上高'))
    expect(hist[0].hitCount).toBe(1)
  })

  it('確定後は draft 一覧から消える', () => {
    const { db, fy } = setup()
    const draft = listDrafts(db, fy.id)[0]
    confirmEntry(db, draft.id)
    expect(listDrafts(db, fy.id)).toHaveLength(0)
  })

  it('確定済み仕訳の明細は updateLineAccount で変更できない（痕跡なし改変の防止）', () => {
    const { db, fy } = setup()
    const draft = listDrafts(db, fy.id)[0]
    const counter = draft.lines.find((l) => l.lineNo === 2)!
    confirmEntry(db, draft.id)
    expect(() => updateLineAccount(db, counter.id, { accountId: accId(db, '売上高') })).toThrow(/確定済み/)
  })

  it('科目変更で税区分が新科目の既定に追随し税額を再計算（通信費→課仕10%・内税）', () => {
    const { db, fy } = setup()
    const counter = listDrafts(db, fy.id)[0].lines.find((l) => l.lineNo === 2)! // 未確定勘定 330,000
    updateLineAccount(db, counter.id, { accountId: accId(db, '通信費') })
    const line = db.select().from(journalLines).where(eq(journalLines.id, counter.id)).all()[0]
    expect(line.accountId).toBe(accId(db, '通信費'))
    const tc = db.select().from(taxCategories).where(eq(taxCategories.id, line.taxCategoryId!)).all()[0]
    expect(tc.code).toBe('PUR_10')
    expect(line.taxAmount).toBe(30_000) // 330,000×10/110
  })

  it('税区分のみの変更は勘定・補助科目を保持する（部分更新／補助消失の防止）', () => {
    const { db, fy } = setup()
    const counter = listDrafts(db, fy.id)[0].lines.find((l) => l.lineNo === 2)!
    const sub = db
      .insert(subAccounts)
      .values({ accountId: accId(db, '未確定勘定'), name: '補助A', isActive: true, sortOrder: 0, createdAt: 'x', updatedAt: 'x' })
      .returning()
      .all()[0]
    db.update(journalLines).set({ subAccountId: sub.id }).where(eq(journalLines.id, counter.id)).run()

    const pur10 = db.select().from(taxCategories).where(eq(taxCategories.code, 'PUR_10')).all()[0].id
    updateLineAccount(db, counter.id, { taxCategoryId: pur10 }) // accountId/subAccountId は送らない

    const line = db.select().from(journalLines).where(eq(journalLines.id, counter.id)).all()[0]
    expect(line.accountId).toBe(accId(db, '未確定勘定')) // 勘定維持
    expect(line.subAccountId).toBe(sub.id) // 補助維持（null上書きしない）
    expect(line.taxCategoryId).toBe(pur10)
    expect(line.taxAmount).toBe(30_000)
  })

  it('存在しない税区分の明示指定は拒否', () => {
    const { db, fy } = setup()
    const counter = listDrafts(db, fy.id)[0].lines.find((l) => l.lineNo === 2)!
    expect(() => updateLineAccount(db, counter.id, { taxCategoryId: 999_999 })).toThrow(/税区分 999999 が見つかりません/)
  })

  it('再取込で同摘要は履歴からサジェスト（学習が効く）', () => {
    const { db, fy } = setup()
    const draft = listDrafts(db, fy.id)[0]
    const counter = draft.lines.find((l) => l.lineNo === 2)!
    updateLineAccount(db, counter.id, { accountId: accId(db, '売上高') })
    confirmEntry(db, draft.id)

    // 別口座参照だが同摘要を再取込（dedup回避のため別日付）
    const router = new DbRouter()
    const csv2 = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/7/1","ﾄｲｳｴｱ入金","","","330,000","760,000"'].join('\r\n')
    const b2 = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv2).rows })
    journalizeBatch(db, b2.batchId)

    const newDraft = listDrafts(db, fy.id)[0]
    const newCounter = newDraft.lines.find((l) => l.lineNo === 2)!
    expect(newCounter.accountName).toBe('売上高') // 未確定勘定でなく学習結果
  })
})
