import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, accounts, subAccounts, journalEntries, journalLines } from '../../db/data/schema.js'
import { importRows } from '../../import/importer.js'
import { parseBankUfj } from '../../import/parsers/bankUfj.js'
import { ecImport } from '../../import/ecImport.js'
import { bankImport } from '../../import/bankImport.js'
import { journalizeBatch } from '../journalize.js'
import { listDrafts, extractOrigin, confirmEntriesBatch } from '../confirm.js'

/**
 * 取込レビュー強化（説明可能なAI仕訳＋例外ベースレビュー）のサーバ側:
 * - extractOrigin: raw_payload のトラック毎の根拠抽出（純関数・壊れた入力で落ちない）
 * - listDrafts   : N+1 解消後の返却互換・origin 付与・from/to/q/confidence フィルタ
 * - confirmEntriesBatch: 部分成功（失敗行はエラー記録して続行）
 */

let tmp: string
const USER = 'u_draft_review'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-draftreview-'))
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
  db.insert(subAccounts)
    .values({ accountId: accId(db, '普通預金'), name: 'UFJ普通', linkedAccountRef: 'ufj-1234', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
    .run()
  return { db, fy, router }
}

/** UI CSV トラックの draft を4件作る（'%'/'_' 入り摘要は LIKE エスケープの検証用）。 */
function importCsvDrafts(router: DbRouter) {
  const csv = [
    '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
    '"2026/6/1","ﾄｲｳｴｱ入金","","","330,000","430,000"',
    '"2026/6/2","50%OFF","","1,000","","429,000"',
    '"2026/6/3","ﾃﾅﾝﾄ100_ﾔﾁﾝ","","90,000","","339,000"',
    '"2026/6/4","ｹﾞﾝｷﾝ100X","","5,000","","334,000"',
  ].join('\r\n')
  const batch = importRows(router, USER, { sourceType: 'bank_ufj', accountRef: 'ufj-1234', rows: parseBankUfj(csv).rows })
  journalizeBatch(router.bookDb(USER), batch.batchId)
}

describe('extractOrigin — raw_payload トラック毎の根拠抽出（純関数）', () => {
  it('ECスキル明細: orderId で識別し reason/confidence/evidenceRef を返す', () => {
    const payload = JSON.stringify({
      source: 'amazon',
      orderId: '249-1234567-7654321',
      itemName: 'SanDisk microSDXC 256GB',
      proposedAccount: '消耗品費',
      treatment: 'expense',
      reason: '作業用ストレージ',
      confidence: 'high',
      evidenceRef: 'e/1.html',
    })
    expect(extractOrigin(payload, 'import')).toEqual({ source: 'ec_skill', reason: '作業用ストレージ', confidence: 'high', evidence: 'e/1.html' })
  })

  it('ECスキル調整行: AI reason が無いので機械的な説明を補う（confidence は null）', () => {
    const payload = JSON.stringify({ source: 'amazon', orderId: '249-1', adjustment: 'shipping', amount: 500 })
    expect(extractOrigin(payload, 'import')).toEqual({ source: 'ec_skill', reason: '注文レベル調整（送料・手数料）', confidence: null, evidence: null })
  })

  it('ECスキル新世代: track=ec_skill マーカーでも識別する（issue #126 の対称化。orderId 併存が通常形）', () => {
    const payload = JSON.stringify({ track: 'ec_skill', source: 'amazon', orderId: '249-2', reason: '書籍', confidence: 'high', evidenceRef: 'e/2.html' })
    expect(extractOrigin(payload, 'import')).toEqual({ source: 'ec_skill', reason: '書籍', confidence: 'high', evidence: 'e/2.html' })
  })

  it('銀行スキル: track=bank_skill で識別し reason/confidence/evidenceRef を返す', () => {
    const payload = JSON.stringify({ track: 'bank_skill', description: 'ﾃﾞﾝｷ', proposedAccount: '水道光熱費', reason: '電気料金の引落', confidence: 'medium', evidenceRef: 'b/1.png' })
    expect(extractOrigin(payload, 'import')).toEqual({ source: 'bank_skill', reason: '電気料金の引落', confidence: 'medium', evidence: 'b/1.png' })
  })

  it('不正な confidence 値は null に落とす（high/medium/low 以外を通さない）', () => {
    const payload = JSON.stringify({ track: 'bank_skill', reason: 'x', confidence: 'very-high' })
    expect(extractOrigin(payload, 'import').confidence).toBeNull()
  })

  it('UI CSV（配列 payload）: entry.source からサジェスト機構を補足する', () => {
    const cols = JSON.stringify(['2026/6/1', 'ﾄｲｳｴｱ入金', '', '', '330,000', '430,000'])
    expect(extractOrigin(cols, 'auto_rule')).toEqual({ source: 'csv', reason: '自動仕訳ルール/履歴学習に一致', confidence: null, evidence: null })
    expect(extractOrigin(cols, 'auto_institution')).toEqual({ source: 'csv', reason: '金融機関既定の自動仕訳', confidence: null, evidence: null })
    expect(extractOrigin(cols, 'import')).toEqual({ source: 'csv', reason: null, confidence: null, evidence: null })
  })

  it('raw なし（payload=null）: manual/transfer/未知 source を落とさず分類する', () => {
    expect(extractOrigin(null, 'manual').source).toBe('manual')
    expect(extractOrigin(null, 'transfer')).toEqual({ source: 'transfer', reason: '口座間振替の名寄せ', confidence: null, evidence: null })
    expect(extractOrigin(null, 'depreciation').source).toBe('other')
  })

  it('壊れた JSON・プリミティブ payload で例外を出さない（best-effort で null 埋め）', () => {
    expect(() => extractOrigin('{broken json', 'import')).not.toThrow()
    expect(extractOrigin('{broken json', 'import')).toEqual({ source: 'csv', reason: null, confidence: null, evidence: null })
    expect(extractOrigin('42', 'import').source).toBe('csv')
    expect(extractOrigin('"str"', 'manual').source).toBe('manual')
  })

  it('空文字の reason/evidenceRef は「情報なし」として null に落とす', () => {
    const payload = JSON.stringify({ track: 'bank_skill', reason: '', evidenceRef: '' })
    expect(extractOrigin(payload, 'import')).toEqual({ source: 'bank_skill', reason: null, confidence: null, evidence: null })
  })
})

describe('listDrafts — N+1 解消後の返却互換と origin 付与', () => {
  it('従来フィールド（id/entryDate/description/source/lines）を維持し、lines は line_no 昇順', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    const drafts = listDrafts(db, fy.id)
    expect(drafts).toHaveLength(4)

    const first = drafts.find((d) => d.description === 'ﾄｲｳｴｱ入金')!
    expect(first.entryDate).toBe('2026-06-01')
    expect(first.source).toBe('import')
    expect(first.lines.map((l) => l.lineNo)).toEqual([1, 2])
    // line_no=1: 取込元口座（普通預金＋補助）/ line_no=2: 相手（サジェストなし＝未確定勘定）。
    expect(first.lines[0].accountName).toBe('普通預金')
    expect(first.lines[0].subAccountId).not.toBeNull()
    expect(first.lines[0].side).toBe('debit') // 入金
    expect(first.lines[1].accountName).toBe('未確定勘定')
    expect(first.lines[1].side).toBe('credit')
    expect(first.lines.every((l) => l.amount === 330_000)).toBe(true)
    // 明細フィールドの互換（web が参照するキーが欠けない）。
    expect(first.lines[0]).toMatchObject({ id: expect.any(Number), lineNo: 1, accountId: accId(db, '普通預金'), taxAmount: null })
    expect('taxCategoryId' in first.lines[0]).toBe(true)
    // 追加された origin（CSV トラック・サジェストなし）。
    expect(first.origin).toEqual({ source: 'csv', reason: null, confidence: null, evidence: null })
  })

  it('subAccountId 絞込（連携サービス毎の確認）は従来どおり効く', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    const sub = db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, 'ufj-1234')).all()[0]
    expect(listDrafts(db, fy.id, { subAccountId: sub.id })).toHaveLength(4)
    expect(listDrafts(db, fy.id, { subAccountId: 999_999 })).toHaveLength(0)
  })

  it('ECスキル取込の draft に AI 根拠（reason/confidence/evidence）が乗る', () => {
    const { db, fy, router } = setup()
    db.insert(subAccounts)
      .values({ accountId: accId(db, '未払金'), name: 'Amazon', linkedAccountRef: 'amazon-1', importSourceType: 'amazon', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
      .run()
    ecImport(router, USER, {
      accountRef: 'amazon-1',
      orders: [
        {
          orderId: '249-1234567-7654321',
          orderDate: '2026-05-20',
          orderTotal: 3480,
          shipping: 500,
          lines: [{ lineNo: 1, itemName: 'SanDisk microSDXC 256GB', quantity: 1, lineAmount: 2980, proposedAccount: '消耗品費', treatment: 'expense', reason: '作業用ストレージ', confidence: 'high', policyRef: 'ec-classify@v1', evidenceRef: 'e/1.html' }],
        },
      ],
    })
    const drafts = listDrafts(db, fy.id)
    const item = drafts.find((d) => d.description === 'SanDisk microSDXC 256GB')!
    expect(item.origin).toEqual({ source: 'ec_skill', reason: '作業用ストレージ', confidence: 'high', evidence: 'e/1.html' })
    const shipping = drafts.find((d) => d.description?.startsWith('送料・手数料'))!
    expect(shipping.origin.source).toBe('ec_skill')
    expect(shipping.origin.reason).toBe('注文レベル調整（送料・手数料）')
  })

  it('銀行スキル取込の draft に AI 根拠が乗る', () => {
    const { db, fy, router } = setup()
    db.insert(subAccounts)
      .values({ accountId: accId(db, '普通預金'), name: '三菱UFJ銀行', linkedAccountRef: 'bank_ufj-9', importSourceType: 'bank_ufj', isActive: true, sortOrder: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
      .run()
    bankImport(router, USER, {
      accountRef: 'bank_ufj-9',
      transactions: [{ txnDate: '2026-05-10', amount: 8000, direction: 'out', description: 'デンキ', treatment: 'expense', proposedAccount: '水道光熱費', reason: '電気料金の引落', confidence: 'medium', evidenceRef: 'b/1.png' }],
    })
    const draft = listDrafts(db, fy.id)[0]
    expect(draft.origin).toEqual({ source: 'bank_skill', reason: '電気料金の引落', confidence: 'medium', evidence: 'b/1.png' })
  })
})

describe('listDrafts — from/to/q/confidence フィルタ', () => {
  it('from/to（entry_date・両端含む）で絞れる', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    expect(listDrafts(db, fy.id, { from: '2026-06-02' }).map((d) => d.entryDate)).toEqual(['2026-06-02', '2026-06-03', '2026-06-04'])
    expect(listDrafts(db, fy.id, { to: '2026-06-01' }).map((d) => d.description)).toEqual(['ﾄｲｳｴｱ入金'])
    expect(listDrafts(db, fy.id, { from: '2026-06-02', to: '2026-06-03' })).toHaveLength(2)
  })

  it('q は摘要の substring 一致', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    expect(listDrafts(db, fy.id, { q: 'ﾄｲｳｴｱ' }).map((d) => d.description)).toEqual(['ﾄｲｳｴｱ入金'])
    expect(listDrafts(db, fy.id, { q: '該当なし' })).toHaveLength(0)
  })

  it('q の LIKE メタ文字（% _）はエスケープされ素の文字として一致する', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    // '%' がワイルドカード解釈されると全4件ヒットしてしまう。リテラル一致なら '50%OFF' のみ。
    expect(listDrafts(db, fy.id, { q: '%' }).map((d) => d.description)).toEqual(['50%OFF'])
    // '_' が任意1文字解釈されると 'ｹﾞﾝｷﾝ100X' もヒットしてしまう。リテラル一致なら 'ﾃﾅﾝﾄ100_ﾔﾁﾝ' のみ。
    expect(listDrafts(db, fy.id, { q: '100_' }).map((d) => d.description)).toEqual(['ﾃﾅﾝﾄ100_ﾔﾁﾝ'])
  })

  it('limit は先頭 N 件に絞り、明細も付いたまま返る（issue #143）', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    const limited = listDrafts(db, fy.id, { limit: 2 })
    expect(limited).toHaveLength(2)
    expect(limited.every((d) => d.lines.length === 2)).toBe(true)
    // 全件（4件）の先頭2件と同一（並びは従来どおり）。
    expect(limited.map((d) => d.id)).toEqual(listDrafts(db, fy.id).slice(0, 2).map((d) => d.id))
  })

  it('confidence は origin 抽出値で絞る（根拠を持たない CSV draft は除外）', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    db.insert(subAccounts)
      .values({ accountId: accId(db, '未払金'), name: 'Amazon', linkedAccountRef: 'amazon-1', importSourceType: 'amazon', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
      .run()
    ecImport(router, USER, {
      accountRef: 'amazon-1',
      orders: [
        {
          orderId: '249-1',
          orderDate: '2026-05-20',
          orderTotal: 4980,
          lines: [
            { lineNo: 1, itemName: '高確信の品', quantity: 1, lineAmount: 2980, proposedAccount: '消耗品費', treatment: 'expense', confidence: 'high', evidenceRef: 'e/1' },
            { lineNo: 2, itemName: '低確信の品', quantity: 1, lineAmount: 2000, proposedAccount: '消耗品費', treatment: 'expense', confidence: 'low', evidenceRef: 'e/2' },
          ],
        },
      ],
    })
    expect(listDrafts(db, fy.id, { confidence: 'high' }).map((d) => d.description)).toEqual(['高確信の品'])
    expect(listDrafts(db, fy.id, { confidence: 'low' }).map((d) => d.description)).toEqual(['低確信の品'])
    expect(listDrafts(db, fy.id, { confidence: 'medium' })).toHaveLength(0)
  })
})

describe('confirmEntriesBatch — 部分成功（例外ベースレビュー）', () => {
  it('失敗行はエラーを記録して続行し、健全な行は確定される', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    const drafts = listDrafts(db, fy.id)
    expect(drafts).toHaveLength(4)
    const [a, broken, c] = drafts

    // 2件目を故意に壊す: 相手行（line_no=2）を消して貸借不一致にする。
    const counter = broken.lines.find((l) => l.lineNo === 2)!
    db.delete(journalLines).where(eq(journalLines.id, counter.id)).run()

    const results = confirmEntriesBatch(db, [a.id, broken.id, c.id, 999_999])
    expect(results).toEqual([
      { id: a.id, ok: true },
      { id: broken.id, ok: false, error: expect.stringContaining('貸借不一致') },
      { id: c.id, ok: true },
      { id: 999_999, ok: false, error: expect.stringContaining('見つかりません') },
    ])

    // 部分成功: 成功2件は confirmed、壊れた1件は draft のまま残る（レビューに残す）。
    const statusOf = (id: number) => db.select().from(journalEntries).where(eq(journalEntries.id, id)).all()[0].status
    expect(statusOf(a.id)).toBe('confirmed')
    expect(statusOf(c.id)).toBe('confirmed')
    expect(statusOf(broken.id)).toBe('draft')
    expect(listDrafts(db, fy.id).map((d) => d.id)).toContain(broken.id)
  })

  it('全件成功で ok:true が並ぶ（confirmEntry と同じ副作用＝draft 一覧から消える）', () => {
    const { db, fy, router } = setup()
    importCsvDrafts(router)
    const ids = listDrafts(db, fy.id).map((d) => d.id)
    const results = confirmEntriesBatch(db, ids)
    expect(results.every((r) => r.ok)).toBe(true)
    expect(listDrafts(db, fy.id)).toHaveLength(0)
  })
})
