import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import {
  fiscalYears,
  accounts,
  subAccounts,
  autoJournalRules,
  journalEntries,
  journalLines,
  rawTransactions,
} from '../../db/data/schema.js'
import { importRows } from '../../import/importer.js'
import { parseBankUfj } from '../../import/parsers/bankUfj.js'
import { parseBankShinsei } from '../../import/parsers/bankShinsei.js'
import { journalizeBatch } from '../journalize.js'
import { confirmEntry } from '../confirm.js'

let tmp: string
const USER = 'u_jnl'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-jnl-'))
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
  db.insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .run()
  // 普通預金に取込元口座を紐付け（account_ref → linked_account_ref）
  const futsu = accId(db, '普通預金')
  db.insert(subAccounts)
    .values({ accountId: futsu, name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
    .run()
  return { db, router }
}

const csv = [
  '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
  '"2026/5/11","東京電力","","8,000","","100,000"', // 出金（ルールで水道光熱費へ）
  '"2026/6/1","売上入金","ﾄｲｳｴｱ","","330,000","430,000"', // 入金（サジェスト無→未確定勘定）
].join('\r\n')

describe('journalizeBatch', () => {
  it('出金: ルール一致で 借)水道光熱費 / 貸)普通預金 の draft', () => {
    const { db, router } = setup()
    db.insert(autoJournalRules)
      .values({ name: '東京電力→水道光熱費', priority: 10, matchField: 'description', matchOp: 'contains', matchValue: '東京電力', direction: 'out', resultAccountId: accId(db, '水道光熱費'), isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
      .run()
    const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
    const summary = journalizeBatch(db, batch.batchId)
    expect(summary.drafted).toBe(2)

    // 出金エントリの明細
    const outRaw = db.select().from(rawTransactions).where(eq(rawTransactions.amount, 8000)).all()[0]
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, outRaw.journalEntryId!)).all()
    const debit = lines.find((l) => l.side === 'debit')!
    const credit = lines.find((l) => l.side === 'credit')!
    expect(debit.accountId).toBe(accId(db, '水道光熱費'))
    expect(credit.accountId).toBe(accId(db, '普通預金'))
    expect(debit.amount).toBe(8000)
    expect(credit.amount).toBe(8000)
  })

  it('入金: サジェスト無→相手は未確定勘定、借)普通預金 / 貸)未確定勘定', () => {
    const { db, router } = setup()
    const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
    journalizeBatch(db, batch.batchId)

    const inRaw = db.select().from(rawTransactions).where(eq(rawTransactions.amount, 330000)).all()[0]
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, inRaw.journalEntryId!)).all()
    expect(lines.find((l) => l.side === 'debit')!.accountId).toBe(accId(db, '普通預金'))
    expect(lines.find((l) => l.side === 'credit')!.accountId).toBe(accId(db, '未確定勘定'))
  })

  it('生成仕訳は全て draft・貸借一致', () => {
    const { db, router } = setup()
    const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
    journalizeBatch(db, batch.batchId)
    const entries = db.select().from(journalEntries).all()
    expect(entries.length).toBe(2)
    expect(entries.every((e) => e.status === 'draft')).toBe(true)
    for (const e of entries) {
      const lines = db.select().from(journalLines).where(eq(journalLines.entryId, e.id)).all()
      const d = lines.filter((l) => l.side === 'debit').reduce((a, l) => a + l.amount, 0)
      const c = lines.filter((l) => l.side === 'credit').reduce((a, l) => a + l.amount, 0)
      expect(d).toBe(c)
    }
  })
})

// 金融機関特有の既定自動仕訳（Phase3 / csv-format §3.2・§5）
function setupBanks(): { db: DataDb; router: DbRouter } {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .run()
  const futsu = accId(db, '普通預金')
  db.insert(subAccounts)
    .values([
      { accountId: futsu, name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
      { accountId: futsu, name: '新生普通', linkedAccountRef: 'shinsei-1', isActive: true, sortOrder: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' },
    ])
    .run()
  return { db, router }
}

const shinseiCsv = [
  '"取引日","摘要","出金金額","入金金額","残高","メモ"',
  '"2026/05/01","税引前利息","","718","2916474",""',
  '"2026/05/01","国税","109","","2916365",""',
  '"2026/05/01","地方税","35","","2916330",""',
].join('\r\n')

function linesOf(db: DataDb, amount: number) {
  const raw = db.select().from(rawTransactions).where(eq(rawTransactions.amount, amount)).all()[0]
  const lines = db.select().from(journalLines).where(eq(journalLines.entryId, raw.journalEntryId!)).all()
  return { raw, debit: lines.find((l) => l.side === 'debit')!, credit: lines.find((l) => l.side === 'credit')! }
}

describe('金融機関特有の既定自動仕訳', () => {
  it('新生: 受取利息→借)普通預金/貸)事業主借、同日の国税・地方税→借)事業主貸/貸)普通預金（利息源泉）', () => {
    const { db, router } = setupBanks()
    const batch = importRows(router, USER, { sourceType: 'bank_shinsei', accountRef: 'shinsei-1', rows: parseBankShinsei(shinseiCsv).rows })
    journalizeBatch(db, batch.batchId)

    const interest = linesOf(db, 718)
    expect(interest.debit.accountId).toBe(accId(db, '普通預金'))
    expect(interest.credit.accountId).toBe(accId(db, '事業主借'))
    const e = db.select().from(journalEntries).where(eq(journalEntries.id, interest.raw.journalEntryId!)).all()[0]
    expect(e.source).toBe('auto_institution')

    for (const amt of [109, 35]) {
      const w = linesOf(db, amt)
      expect(w.debit.accountId).toBe(accId(db, '事業主貸')) // 源泉＝事業主貸（借方）
      expect(w.credit.accountId).toBe(accId(db, '普通預金'))
    }
  })

  it('新生: 同日に利息が無い国税は既定仕訳しない→未確定勘定（予定納税等を源泉と誤らない）', () => {
    const { db, router } = setupBanks()
    const csvNoInterest = ['"取引日","摘要","出金金額","入金金額","残高","メモ"', '"2026/03/15","国税","50000","","100000",""'].join('\r\n')
    const batch = importRows(router, USER, { sourceType: 'bank_shinsei', accountRef: 'shinsei-1', rows: parseBankShinsei(csvNoInterest).rows })
    journalizeBatch(db, batch.batchId)
    const w = linesOf(db, 50000)
    expect(w.debit.accountId).toBe(accId(db, '未確定勘定'))
  })

  it('UFJ: シヨウヒゼイ出金→借)租税公課/貸)普通預金（消費税納付・半角カナ実CSV）', () => {
    const { db, router } = setupBanks()
    // 実CSV(Shift_JIS)同様に半角カナ ｼﾖｳﾋｾﾞｲ を用いる（全角だと実入力を再現できずバグを隠す）。
    const ufjTaxCsv = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/5/20","税金","ｼﾖｳﾋｾﾞｲ","50,000","","100,000"'].join('\r\n')
    const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(ufjTaxCsv).rows })
    journalizeBatch(db, batch.batchId)
    const w = linesOf(db, 50000)
    expect(w.debit.accountId).toBe(accId(db, '租税公課'))
    expect(w.credit.accountId).toBe(accId(db, '普通預金'))
  })

  it('既定自動仕訳(auto_institution)は履歴学習しない→後続の同日利息なし国税は未確定勘定のまま（同日ガード迂回を防ぐ）', () => {
    const { db, router } = setupBanks()
    // ① 同日に税引前利息のある国税(源泉)を取込→事業主貸(auto_institution)で確定。
    const b1 = importRows(router, USER, { sourceType: 'bank_shinsei', accountRef: 'shinsei-1', rows: parseBankShinsei(shinseiCsv).rows })
    journalizeBatch(db, b1.batchId)
    const withholding = linesOf(db, 109)
    expect(withholding.debit.accountId).toBe(accId(db, '事業主貸'))
    confirmEntry(db, withholding.raw.journalEntryId!)
    // ② 別日・同日利息なしの国税(予定納税等)を取込→学習されていないので institution 同日ガードで未確定勘定。
    const csvNoInterest = ['"取引日","摘要","出金金額","入金金額","残高","メモ"', '"2026/03/15","国税","50000","","100000",""'].join('\r\n')
    const b2 = importRows(router, USER, { sourceType: 'bank_shinsei', accountRef: 'shinsei-1', rows: parseBankShinsei(csvNoInterest).rows })
    journalizeBatch(db, b2.batchId)
    const later = linesOf(db, 50000)
    expect(later.debit.accountId).toBe(accId(db, '未確定勘定'))
  })

  it('ユーザールールは既定自動仕訳より優先（rule→institution の順）', () => {
    const { db, router } = setupBanks()
    db.insert(autoJournalRules)
      .values({ name: '利息→現金(検証)', priority: 10, matchField: 'description', matchOp: 'contains', matchValue: '税引前利息', direction: 'in', resultAccountId: accId(db, '現金'), isActive: true, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
      .run()
    const batch = importRows(router, USER, { sourceType: 'bank_shinsei', accountRef: 'shinsei-1', rows: parseBankShinsei(shinseiCsv).rows })
    journalizeBatch(db, batch.batchId)
    const interest = linesOf(db, 718)
    expect(interest.credit.accountId).toBe(accId(db, '現金')) // 既定(事業主借)でなくルールの現金
    const e = db.select().from(journalEntries).where(eq(journalEntries.id, interest.raw.journalEntryId!)).all()[0]
    expect(e.source).toBe('auto_rule')
  })
})
