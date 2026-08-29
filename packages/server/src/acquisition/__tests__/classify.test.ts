import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, fiscalYears, journalEntries, journalLines, subAccounts } from '../../db/data/schema.js'
import { bankImport } from '../../import/bankImport.js'
import { confirmEntry, listDrafts } from '../../journal/confirm.js'
import { importRows } from '../../import/importer.js'
import { parseBankUfj } from '../../import/parsers/bankUfj.js'
import { journalizeBatch } from '../../journal/journalize.js'
import { applyClassification, itemId, listUnclassified } from '../classify.js'
import { extractOrigin } from '../../journal/confirm.js'
import { rawTransactions } from '../../db/data/schema.js'
import { BUNDLED_POLICY, getPolicy, resetPolicy, setPolicy, PolicyTooLargeError } from '../policy.js'
import type { BankTxn } from '../../import/bank.js'

/**
 * 未確定の分類（acquisition spec「未確定の分類」「分類のために外へ出す情報の最小化」）。
 *
 * 要点は3つ。**金額を出さない** / **識別子が取引を指さない** / **人が先に片付けていても壊れない**。
 */

let tmp: string
const BOOK = 'b_classify'
const REF = 'bank_ufj-1'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-classify-'))
  process.env.DATA_DIR = tmp
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

const txn = (over: Partial<BankTxn> = {}): BankTxn => ({
  txnDate: '2026-05-10',
  amount: 3000,
  direction: 'out',
  description: 'デンキダイ',
  ...over,
})

/** 科目の提案を付けずに取り込む＝すべて未確定勘定の draft になる（取込は分類を待たない）。 */
function importUnclassified(router: DbRouter, transactions: BankTxn[]) {
  return bankImport(router, BOOK, { accountRef: REF, transactions })
}

describe('取込は分類を待たない', () => {
  it('科目を付けずに取り込むと、未確定勘定の draft として並ぶ', () => {
    const { db, router } = setup()
    const summary = importUnclassified(router, [txn(), txn({ txnDate: '2026-05-11', amount: 2000 })])

    expect(summary.acceptedRows).toBe(2)
    expect(summary.unresolved).toHaveLength(2)
    const entries = db.select().from(journalEntries).all()
    expect(entries).toHaveLength(2)
    expect(entries.every((e) => e.status === 'draft')).toBe(true)
  })
})

describe('未確定の一覧', () => {
  it('同じ文字はまとめ、件数を添える', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [
      txn(),
      txn({ txnDate: '2026-05-11', amount: 2000 }),
      txn({ txnDate: '2026-05-12', amount: 5000, description: 'ウリアゲ', direction: 'in' }),
    ])

    const { items, total } = listUnclassified(db, fyId)
    expect(total).toBe(2)
    expect(items.map((i) => i.text)).toEqual(['デンキダイ', 'ウリアゲ']) // 件数の多い順
    expect(items[0].count).toBe(2)
    expect(items[0].sources).toEqual(['bank_ufj'])
  })

  it('金額・残高・取引識別子・日付を渡さない', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn({ amount: 123456, balance: 987654 })])

    const { items } = listUnclassified(db, fyId)
    const serialized = JSON.stringify(items)
    expect(serialized).not.toContain('123456')
    expect(serialized).not.toContain('987654')
    expect(serialized).not.toContain('2026-05-10')
    expect(Object.keys(items[0]).sort()).toEqual(['count', 'id', 'sources', 'text'])
  })

  it('識別子は文字から決まる（単体では取引を特定できない）', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn(), txn({ txnDate: '2026-05-11', amount: 2000 })])

    const { items } = listUnclassified(db, fyId)
    // 2件の取引が同じ識別子を共有する＝識別子は取引を指していない
    expect(items[0].count).toBe(2)
    expect(items[0].id).toBe(itemId('デンキダイ'))
  })

  it('連携サービスで絞れる', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    expect(listUnclassified(db, fyId, { source: 'bank_ufj' }).items).toHaveLength(1)
    expect(listUnclassified(db, fyId, { source: 'amazon' }).items).toHaveLength(0)
  })

  it('確定履歴を添える（外部クライアントに履歴を取りに行かせない）', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const { hints } = listUnclassified(db, fyId, { source: 'bank_ufj' })
    expect(Array.isArray(hints)).toBe(true) // 履歴が無ければ空。形が返ることを固定する
  })

  it('未確定が無ければ空', () => {
    const { db, fyId } = setup()
    expect(listUnclassified(db, fyId).items).toHaveLength(0)
  })
})

describe('科目を当てる', () => {
  it('同じ文字の未確定すべてに当たり、確定はしない', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn(), txn({ txnDate: '2026-05-11', amount: 2000 })])
    const { items } = listUnclassified(db, fyId)

    const r = applyClassification(db, fyId, [{ id: items[0].id, proposedAccount: '水道光熱費' }])
    expect(r.applied).toBe(2)
    expect(r.remaining).toBe(0)

    const lines = db
      .select({ accountId: journalLines.accountId })
      .from(journalLines)
      .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
      .where(eq(journalLines.accountId, accId(db, '水道光熱費')))
      .all()
    expect(lines).toHaveLength(2)
    // 確定はしない（承認は人が画面で行う）
    expect(db.select().from(journalEntries).all().every((e) => e.status === 'draft')).toBe(true)
  })

  it('人が先に片付けていたら適用0件（失敗にしない）', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const { items } = listUnclassified(db, fyId)

    applyClassification(db, fyId, [{ id: items[0].id, proposedAccount: '水道光熱費' }])
    // 同じ分類がもう一度返ってきても、対象はもう無い
    const again = applyClassification(db, fyId, [{ id: items[0].id, proposedAccount: '通信費' }])
    expect(again.applied).toBe(0)
    expect(again.unmatched).toBe(1)
  })

  it('知らない識別子は適用せず件数で返す', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const r = applyClassification(db, fyId, [{ id: 'deadbeef', proposedAccount: '水道光熱費' }])
    expect(r.applied).toBe(0)
    expect(r.unmatched).toBe(1)
    expect(r.remaining).toBe(1) // 未確定はそのまま残る
  })

  it('知らない勘定科目は作らず、名前を返す（黙って別の科目へ寄せない）', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const { items } = listUnclassified(db, fyId)
    const r = applyClassification(db, fyId, [{ id: items[0].id, proposedAccount: '架空の科目' }])
    expect(r.applied).toBe(0)
    expect(r.unknownAccounts).toEqual(['架空の科目'])
    expect(r.remaining).toBe(1)
  })

  it('確定済みには当たらない', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const { items } = listUnclassified(db, fyId)
    const entryId = db.select().from(journalEntries).all()[0].id
    confirmEntry(db, entryId)

    // 確定した仕訳はもう未確定の一覧に出ない
    expect(listUnclassified(db, fyId).items).toHaveLength(0)
    const r = applyClassification(db, fyId, [{ id: items[0].id, proposedAccount: '水道光熱費' }])
    expect(r.applied).toBe(0)
    expect(r.unmatched).toBe(1)
  })

  it('当てた科目に応じて税区分が解決される（updateLineAccount の権威を通る）', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const { items } = listUnclassified(db, fyId)
    applyClassification(db, fyId, [{ id: items[0].id, proposedAccount: '水道光熱費' }])

    const line = db
      .select()
      .from(journalLines)
      .where(eq(journalLines.accountId, accId(db, '水道光熱費')))
      .all()[0]
    expect(line.taxCategoryId).not.toBeNull()
  })
})

describe('分類の根拠（理由・確信度）', () => {
  it('当てた根拠が draft の由来として読める（画面の根拠表示・一括確定の条件）', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const { items } = listUnclassified(db, fyId)

    applyClassification(db, fyId, [
      {
        id: items[0].id,
        proposedAccount: '水道光熱費',
        reason: '電気代の口座振替',
        confidence: 'high',
        policyRef: '決定的な項目',
      },
    ])

    const raw = db.select().from(rawTransactions).all()[0]
    const origin = extractOrigin(raw.rawPayload, 'import')
    expect(origin.confidence).toBe('high')
    expect(origin.reason).toBe('電気代の口座振替')
  })

  it('根拠を付けなくても科目は当たる（付けないと画面で根拠が出ないだけ）', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const { items } = listUnclassified(db, fyId)
    const r = applyClassification(db, fyId, [{ id: items[0].id, proposedAccount: '水道光熱費' }])
    expect(r.applied).toBe(1)

    const raw = db.select().from(rawTransactions).all()[0]
    expect(extractOrigin(raw.rawPayload, 'import').confidence).toBeNull()
  })

  it('取込明細の中身（金額・日付）は壊さない', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn({ amount: 4321 })])
    const { items } = listUnclassified(db, fyId)
    applyClassification(db, fyId, [
      { id: items[0].id, proposedAccount: '水道光熱費', reason: 'x', confidence: 'low' },
    ])

    const raw = db.select().from(rawTransactions).all()[0]
    expect(raw.amount).toBe(4321)
    const payload = JSON.parse(raw.rawPayload!) as Record<string, unknown>
    expect(payload.track).toBe('bank_skill') // 由来の識別子を消していない
  })

  it('CSV 取込由来の未確定にも根拠が残り、画面（listDrafts）で読める（issue #144・spec「経路によらず同じ操作」）', () => {
    const { db, router, fyId } = setup()
    // UI CSV トラック: raw_payload は元CSV列の配列＝根拠を相乗りさせる場所が無い。
    const csv = [
      '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
      '"2026/5/10","ﾃﾞﾝｷﾀﾞｲ","","3,000","","97,000"',
    ].join('\r\n')
    const batch = importRows(router, BOOK, { sourceType: 'bank_ufj', accountRef: REF, rows: parseBankUfj(csv).rows })
    journalizeBatch(db, batch.batchId)

    const { items } = listUnclassified(db, fyId)
    expect(items).toHaveLength(1)
    const r = applyClassification(db, fyId, [
      { id: items[0].id, proposedAccount: '水道光熱費', reason: '電気代の口座振替', confidence: 'high', policyRef: 'p@1' },
    ])
    expect(r.applied).toBe(1)

    // 原本（配列 payload）は無傷・根拠は proposal_json に載る。
    const raw = db.select().from(rawTransactions).all()[0]
    expect(Array.isArray(JSON.parse(raw.rawPayload!))).toBe(true)
    expect(JSON.parse(raw.proposalJson!)).toMatchObject({ proposedAccount: '水道光熱費', confidence: 'high' })

    // 画面の由来として読め、例外ベースレビュー（confidence=high 絞り込み）が CSV 経路にも効く。
    const drafts = listDrafts(db, fyId)
    expect(drafts).toHaveLength(1)
    expect(drafts[0].origin).toEqual({ source: 'csv', reason: '電気代の口座振替', confidence: 'high', evidence: null })
    expect(listDrafts(db, fyId, { confidence: 'high' })).toHaveLength(1)
  })
})

describe('分類方針', () => {
  it('未確定の一覧に方針が添えられる（履歴が無い品名の唯一の手掛かり）', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const r = listUnclassified(db, fyId)
    expect(r.policy).toContain('推測で科目を作らない')
    expect(r.policy).toContain('事業主借') // 決定的な項目（利息）が届く
  })

  it('編集すると、そちらが渡る', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    setPolicy('# うちのルール\n\nデンキダイ は 水道光熱費。', tmp)
    expect(listUnclassified(db, fyId).policy).toContain('うちのルール')
    expect(getPolicy(tmp).origin).toBe('override')
  })

  it('既定へ戻せる', () => {
    setPolicy('# 壊れた方針', tmp)
    const r = resetPolicy(tmp)
    expect(r.hadOverride).toBe(true)
    expect(r.text).toBe(BUNDLED_POLICY)
    expect(getPolicy(tmp).origin).toBe('bundled')
  })

  it('空にしたら既定へ倒す（空の方針を配らない）', () => {
    setPolicy('   \n  ', tmp)
    expect(getPolicy(tmp).origin).toBe('bundled')
  })

  it('会話に載るものなので上限を設ける', () => {
    expect(() => setPolicy('あ'.repeat(20_000), tmp)).toThrow(PolicyTooLargeError)
  })
})

describe('履歴は由来ごとに引く', () => {
  it('どの連携サービスの履歴かが分かる形で返る', () => {
    const { db, router, fyId } = setup()
    importUnclassified(router, [txn()])
    const { items } = listUnclassified(db, fyId)
    // 確定すると mapping_history に入る（学習ループ）
    applyClassification(db, fyId, [{ id: items[0].id, proposedAccount: '水道光熱費' }])
    const entryId = db.select().from(journalEntries).all()[0].id
    confirmEntry(db, entryId)

    importUnclassified(router, [txn({ txnDate: '2026-06-10', amount: 4000 })])
    const again = listUnclassified(db, fyId)
    const hint = again.hints.find((h) => h.pattern === 'デンキダイ')
    expect(hint).toBeDefined()
    expect(hint!.source).toBe('bank_ufj')
    expect(hint!.proposedAccount).toBe('水道光熱費')
  })
})
