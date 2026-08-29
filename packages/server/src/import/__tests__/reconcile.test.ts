import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DbRouter, type DataDb } from '../../db/router.js'
import { fiscalYears, rawTransactions } from '../../db/data/schema.js'
import { importRows } from '../importer.js'
import { reconcileBalances } from '../reconcile.js'
import { parseBankUfj } from '../parsers/bankUfj.js'
import { parseBankShinsei } from '../parsers/bankShinsei.js'
import { parseCardMufgVisa } from '../parsers/cardMufgVisa.js'

let tmp: string
const USER = 'u_reconcile'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-reconcile-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function setup(): { db: DataDb; router: DbRouter } {
  const router = new DbRouter()
  const db = router.bookDb(USER)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  return { db, router }
}

const HEADER = '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"'

describe('残高同期・突合（reconcileBalances）', () => {
  it('残高が連続して整合する取込は balanced（gap なし）', () => {
    const { db, router } = setup()
    const csv = [
      HEADER,
      '"2026/5/1","給与","","","300000","1300000"', // 入金300,000 → 残高1,300,000
      '"2026/5/2","家賃","","80000","","1220000"', // 出金80,000 → 1,300,000-80,000=1,220,000 ✓
      '"2026/5/3","売上入金","","","50000","1270000"', // 入金50,000 → 1,220,000+50,000=1,270,000 ✓
    ].join('\r\n')
    importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1', rows: parseBankUfj(csv).rows })

    const rep = reconcileBalances(db)
    expect(rep.accounts).toHaveLength(1)
    const acc = rep.accounts[0]
    expect(acc.accountRef).toBe('ufj-1')
    expect(acc.rowCount).toBe(3)
    expect(acc.balanced).toBe(true)
    expect(acc.gaps).toHaveLength(0)
    expect(acc.lastBalance).toBe(1270000)
  })

  it('取りこぼし（中間取引の欠落）を残高の不連続として検知し差異額を出す', () => {
    const { db, router } = setup()
    // 5/1 出金1,000→残高9,000、5/3 出金200→残高9,300。本来は間に入金+500 があったはず。
    const csv = [HEADER, '"2026/5/1","A","","1000","","9000"', '"2026/5/3","C","","200","","9300"'].join('\r\n')
    importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1', rows: parseBankUfj(csv).rows })

    const acc = reconcileBalances(db).accounts[0]
    expect(acc.balanced).toBe(false)
    expect(acc.gaps).toHaveLength(1)
    const g = acc.gaps[0]
    expect(g.date).toBe('2026-05-03')
    expect(g.expectedPrevBalance).toBe(9500) // 5/3の出金200の前は9500で終わるはずが、取込内に見つからない
    expect(g.balance).toBe(9300)
    expect(g.delta).toBe(-200)
  })

  it('逆時系列CSV（同日を新しい順に列挙・残高が下に増える）でも誤検知しない（順序独立）', () => {
    const { db, router } = setup()
    // 真の順: 入金500→10500、出金200→10300、出金100→10200。新生CSVは新しい順に列挙されがち。
    const csv = [
      '"取引日","摘要","出金金額","入金金額","残高","メモ"',
      '"2026/05/01","C","100","","10200",""', // out 100 → 10200（pre 10300）
      '"2026/05/01","B","200","","10300",""', // out 200 → 10300（pre 10500）
      '"2026/05/01","A","","500","10500",""', // in 500 → 10500（pre 10000＝期首）
    ].join('\n')
    importRows(router, USER, { sourceType: 'bank_shinsei', accountRef: 'shinsei-1', rows: parseBankShinsei(csv).rows })

    const acc = reconcileBalances(db).accounts[0]
    expect(acc.balanced).toBe(true) // 旧実装（id順チェーン）では正常データを差異と誤検知していた
    expect(acc.gaps).toHaveLength(0)
  })

  it('クロスバッチの同日取引（後の取込が時系列上は先行する行を追加）でも誤検知しない', () => {
    const { db, router } = setup()
    // 真の順: 期首10000 → EARLY 出金50 → 9950 → LATE 出金150 → 9800。
    // バッチ1で LATE を先に取込、バッチ2で時系列上は先行する EARLY を後から取込。
    const late = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/5/2","LATE","","150","","9800"'].join('\r\n')
    const early = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/5/2","EARLY","","50","","9950"'].join('\r\n')
    importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-x', rows: parseBankUfj(late).rows })
    importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-x', rows: parseBankUfj(early).rows })

    const acc = reconcileBalances(db).accounts[0]
    expect(acc.rowCount).toBe(2)
    expect(acc.balanced).toBe(true) // id順に依存せず残高チェーンで連結＝誤検知なし
    expect(acc.gaps).toHaveLength(0)
  })

  it('日跨ぎの取りこぼしを見逃さない（期首0→後日0復帰でも・残高チェーンは日付順を尊重）', () => {
    const { db, router } = setup()
    // 5/1 入金500→500（期首0）。5/2 出金300→0（本来は直前に -200 の取引があったはず）。
    // 値だけのマッチングだと期首pre 0 が 5/2行のpost 0 を予測元に消費して見逃す → 日付順で防ぐ。
    const d1 = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/5/1","入金","","","500","500"'].join('\r\n')
    const d2 = ['"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"', '"2026/5/2","出金","","300","","0"'].join('\r\n')
    importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-z', rows: parseBankUfj(d1).rows })
    importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-z', rows: parseBankUfj(d2).rows })

    const acc = reconcileBalances(db).accounts[0]
    expect(acc.balanced).toBe(false)
    expect(acc.gaps).toHaveLength(1)
    expect(acc.gaps[0].date).toBe('2026-05-02')
    expect(acc.gaps[0].expectedPrevBalance).toBe(300) // 5/2出金300の直前は300のはず（5/1は500で締め＝-200欠落）
  })

  it('残高列を持たない明細（カード等）は突合対象外（口座が出てこない）', () => {
    const { db, router } = setup()
    const cardCsv = [
      '"確定情報","お支払日","ご利用店名","ご利用日","支払回数","何回目","ご利用金額（円）","現地通貨額"',
      '"確定","2026年6月10日","店A","2026年5月5日","　１","","210",""',
    ].join('\r\n')
    importRows(router, USER, { sourceType: 'card_mufg_visa', accountRef: 'card-1', rows: parseCardMufgVisa(cardCsv).rows })

    // カード行は balance=null なので突合対象外＝口座が出ない。
    expect(reconcileBalances(db).accounts).toHaveLength(0)
    // ただし行自体は取り込まれている（balance は null）。
    const stored = db.select().from(rawTransactions).all()
    expect(stored).toHaveLength(1)
    expect(stored[0].balance).toBeNull()
  })
})
