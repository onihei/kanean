import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, accounts, subAccounts, journalLines, rawTransactions, mappingHistory, importBatches } from '../../db/data/schema.js'
import { bankImport, journalizeBankRow } from '../bankImport.js'
import { ignoreRawTransaction, restoreRawTransaction } from '../rawStatus.js'
import { confirmEntry } from '../../journal/confirm.js'
import type { BankTxn } from '../bank.js'

let tmp: string
const USER = 'u_bank'
const REF = 'bank_ufj-1'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-bank-'))
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
  // 普通預金に三菱UFJ銀行の口座補助（linked_account_ref='bank_ufj-1' は registerService の自動採番に相当）。
  db.insert(subAccounts)
    .values({ accountId: accId(db, '普通預金'), name: '三菱UFJ銀行', linkedAccountRef: REF, importSourceType: 'bank_ufj', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
    .run()
  return { db, router }
}

const txn = (over: Partial<BankTxn> = {}): BankTxn => ({
  txnDate: '2026-05-10',
  amount: 1000,
  direction: 'out',
  description: 'テスト',
  ...over,
})

/** description で raw → 仕訳明細を引く。 */
function legs(db: DataDb, description: string) {
  const raw = db.select().from(rawTransactions).where(eq(rawTransactions.description, description)).all()[0]
  const lines = db.select().from(journalLines).where(eq(journalLines.entryId, raw.journalEntryId!)).all()
  return {
    raw,
    deposit: lines.find((l) => l.lineNo === 1)!, // 普通預金
    counter: lines.find((l) => l.lineNo === 2)!, // 相手科目
    debit: lines.find((l) => l.side === 'debit')!,
    credit: lines.find((l) => l.side === 'credit')!,
  }
}

describe('bankImport — 普通預金一脚・direction で貸借', () => {
  it('入金(in) は 借)普通預金 / 貸)相手科目、出金(out) は 借)相手科目 / 貸)普通預金', () => {
    const { db, router } = setup()
    const depositSubId = db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, REF)).all()[0].id
    bankImport(router, USER, {
      accountRef: REF,
      transactions: [
        txn({ description: '報酬入金', amount: 50000, direction: 'in', treatment: 'revenue', proposedAccount: '売掛金' }),
        txn({ description: 'デンキ', amount: 8000, direction: 'out', treatment: 'expense', proposedAccount: '水道光熱費' }),
      ],
    })
    const incoming = legs(db, '報酬入金')
    expect(incoming.deposit.side).toBe('debit')
    expect(incoming.deposit.accountId).toBe(accId(db, '普通預金'))
    expect(incoming.deposit.subAccountId).toBe(depositSubId) // 口座補助が一脚に乗る
    expect(incoming.counter.side).toBe('credit')
    expect(incoming.counter.accountId).toBe(accId(db, '売掛金'))

    const outgoing = legs(db, 'デンキ')
    expect(outgoing.deposit.side).toBe('credit')
    expect(outgoing.counter.side).toBe('debit')
    expect(outgoing.counter.accountId).toBe(accId(db, '水道光熱費'))
  })

  it('§5.1 法的項目: 利息→事業主借 / 源泉→事業主貸 / 消費税→租税公課', () => {
    const { db, router } = setup()
    bankImport(router, USER, {
      accountRef: REF,
      transactions: [
        txn({ description: '税引前利息', amount: 718, direction: 'in', treatment: 'owner_contribution' }),
        txn({ description: '国税', amount: 109, direction: 'out', treatment: 'owner_draw' }),
        txn({ description: '税金 シヨウヒゼイ', amount: 30000, direction: 'out', treatment: 'expense', proposedAccount: '租税公課' }),
      ],
    })
    // 利息: 借)普通預金 / 貸)事業主借
    const interest = legs(db, '税引前利息')
    expect(interest.deposit.side).toBe('debit')
    expect(interest.counter.accountId).toBe(accId(db, '事業主借'))
    expect(interest.counter.side).toBe('credit')
    // 源泉: 借)事業主貸 / 貸)普通預金
    const wh = legs(db, '国税')
    expect(wh.counter.accountId).toBe(accId(db, '事業主貸'))
    expect(wh.counter.side).toBe('debit')
    expect(wh.deposit.side).toBe('credit')
    // 消費税: 借)租税公課 / 貸)普通預金
    const tax = legs(db, '税金 シヨウヒゼイ')
    expect(tax.counter.accountId).toBe(accId(db, '租税公課'))
    expect(tax.counter.side).toBe('debit')
  })

  it('settlement: counterSubAccountRef で未払金カードチャネルの補助科目を解決（親一致時のみ）', () => {
    const { db, router } = setup()
    const cardSub = db
      .insert(subAccounts)
      .values({ accountId: accId(db, '未払金'), name: '三菱UFJ-VISA', linkedAccountRef: 'card_mufg_visa-1', importSourceType: 'card_mufg_visa', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
      .returning()
      .all()[0]
    bankImport(router, USER, {
      accountRef: REF,
      transactions: [txn({ description: 'クレジット', amount: 193945, direction: 'out', treatment: 'settlement', proposedAccount: '未払金', counterSubAccountRef: 'card_mufg_visa-1' })],
    })
    const s = legs(db, 'クレジット')
    expect(s.counter.accountId).toBe(accId(db, '未払金'))
    expect(s.counter.subAccountId).toBe(cardSub.id) // 未払金カードチャネルに付替え
    expect(s.counter.side).toBe('debit')
  })

  it('未知の科目名は未確定勘定＋unresolved（黙って確定しない）', () => {
    const { db, router } = setup()
    const s = bankImport(router, USER, {
      accountRef: REF,
      transactions: [txn({ description: '謎の出金', amount: 1234, direction: 'out', treatment: 'expense', proposedAccount: '存在しない科目' })],
    })
    expect(s.unresolved).toHaveLength(1)
    const l = legs(db, '謎の出金')
    expect(l.counter.accountId).toBe(accId(db, '未確定勘定'))
  })

  it('balance を raw に保存（残高チェーンの素）', () => {
    const { db, router } = setup()
    bankImport(router, USER, { transactions: [txn({ description: '残高あり', balance: 37717278 })], accountRef: REF })
    const raw = db.select().from(rawTransactions).where(eq(rawTransactions.description, '残高あり')).all()[0]
    expect(raw.balance).toBe(37717278)
  })

  it('会計期間ゲート: 翌期(open範囲外)は登録しない（excluded で可視化）', () => {
    const { db, router } = setup()
    const s = bankImport(router, USER, {
      accountRef: REF,
      transactions: [
        txn({ description: '期内', txnDate: '2026-12-31' }),
        txn({ description: '翌期', txnDate: '2027-01-05' }),
      ],
    })
    expect(s.acceptedRows).toBe(1)
    expect(s.excludedCount).toBe(1)
    expect(db.select().from(rawTransactions).where(eq(rawTransactions.description, '翌期')).all()).toHaveLength(0)
  })

  it('再POSTは冪等（出現インデックス方式で skippedDup）', () => {
    const { router } = setup()
    const payload = { accountRef: REF, transactions: [txn({ description: 'A', amount: 100 }), txn({ description: 'A', amount: 100 })] }
    const first = bankImport(router, USER, payload)
    expect(first.acceptedRows).toBe(2) // 同日同額同摘要の別取引は出現連番で全件保持
    const second = bankImport(router, USER, payload)
    expect(second.acceptedRows).toBe(0)
    expect(second.skippedDup).toBe(2)
  })

  it('取込0件（全件重複/期間外）は空バッチを残さない（履歴ノイズ防止）', () => {
    const { db, router } = setup()
    const payload = { accountRef: REF, transactions: [txn({ description: 'A', amount: 100 })] }
    bankImport(router, USER, payload) // 1件取込→batch 1
    bankImport(router, USER, payload) // 全件dup→空バッチは作らない
    expect(db.select().from(importBatches).all()).toHaveLength(1)
    // 翌期のみ（全件期間外）でも空バッチを作らない
    bankImport(router, USER, { accountRef: REF, transactions: [txn({ description: 'B', txnDate: '2027-03-01' })] })
    expect(db.select().from(importBatches).all()).toHaveLength(1)
  })

  it('restore: ignored→復帰で同じ貸借に再仕訳（AI候補から再構築）', () => {
    const { db, router } = setup()
    bankImport(router, USER, { accountRef: REF, transactions: [txn({ description: '光熱費', amount: 8000, direction: 'out', treatment: 'expense', proposedAccount: '水道光熱費' })] })
    const raw = db.select().from(rawTransactions).where(eq(rawTransactions.description, '光熱費')).all()[0]
    ignoreRawTransaction(db, raw.id)
    expect(db.select().from(rawTransactions).where(eq(rawTransactions.id, raw.id)).all()[0].status).toBe('ignored')
    restoreRawTransaction(db, raw.id)
    const restored = legs(db, '光熱費')
    expect(restored.counter.accountId).toBe(accId(db, '水道光熱費'))
    expect(restored.counter.side).toBe('debit')
    expect(restored.deposit.accountId).toBe(accId(db, '普通預金'))
  })

  it('会計期間ゲート: 繰越後に前年度の raw を仕訳化しようとすると弾かれる（restore・直接呼びとも）', () => {
    const { db, router } = setup()
    bankImport(router, USER, { accountRef: REF, transactions: [txn({ description: '光熱費', amount: 8000, direction: 'out', treatment: 'expense', proposedAccount: '水道光熱費' })] })
    const raw = db.select().from(rawTransactions).where(eq(rawTransactions.description, '光熱費')).all()[0]
    ignoreRawTransaction(db, raw.id)
    db.update(fiscalYears).set({ status: 'closed' }).where(eq(fiscalYears.startDate, '2026-01-01')).run()
    db.insert(fiscalYears).values({ startDate: '2027-01-01', endDate: '2027-12-31', status: 'open', createdAt: '2027-01-01T00:00:00Z' }).run()

    expect(() => restoreRawTransaction(db, raw.id)).toThrow(/範囲外/)
    expect(db.select().from(rawTransactions).where(eq(rawTransactions.id, raw.id)).all()[0].status).toBe('ignored')
    // 行レベルの関数を直接呼んでも同じ（呼出側の分岐ではなく書込みの直前で弾く）。
    expect(() => journalizeBankRow(db, raw)).toThrow(/範囲外/)
  })

  it('確定→学習: 摘要→相手科目が mapping_history(bank_ufj) に書き戻される（§7.2）', () => {
    const { db, router } = setup()
    const s = bankImport(router, USER, { accountRef: REF, transactions: [txn({ description: 'トウキヨウデンリヨク', amount: 8000, direction: 'out', treatment: 'expense', proposedAccount: '水道光熱費' })] })
    confirmEntry(db, s.draftEntries[0].entryId)
    const hist = db.select().from(mappingHistory).where(eq(mappingHistory.pattern, 'トウキヨウデンリヨク')).all()[0]
    expect(hist.sourceType).toBe('bank_ufj')
    expect(hist.accountId).toBe(accId(db, '水道光熱費'))
  })
})
