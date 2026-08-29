import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import {
  accounts,
  attachments,
  fiscalYears,
  journalEntries,
  journalLines,
  rawTransactions,
} from '../../db/data/schema.js'
import { createTwoLineDraftEntry } from '../../journal/draftEntry.js'
import { resolveLineTax } from '../../journal/lineTax.js'
import {
  buildReceiptDescription,
  receiptImport,
  receiptMatch,
  type ReceiptImportArgs,
} from '../receiptImport.js'

let tmp: string
// 添付ストレージは帳簿IDが ULID であることを要求する（attachments/storage.ts）。
const BOOK = '01JZQK8F3M4N5P6R7S8T9VWXYZ'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-receipt-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): { db: DataDb; router: DbRouter } {
  const router = new DbRouter()
  const db = router.bookDb(BOOK)
  seedDataPlane(db)
  db.insert(fiscalYears)
    .values({
      startDate: '2026-01-01',
      endDate: '2026-12-31',
      status: 'open',
      createdAt: '2026-01-01T00:00:00Z',
    })
    .run()
  return { db, router }
}

/** 中身が違えば SHA-256 も違う画像を作る。 */
function image(seed: string) {
  const bytes = Buffer.from(`fake-jpeg-${seed}`)
  return {
    fileName: `${seed}.jpg`,
    contentType: 'image/jpeg',
    bytes,
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
  }
}

const args = (over: Partial<ReceiptImportArgs> = {}): ReceiptImportArgs => ({
  transactionDate: '2026-05-10',
  totalAmount: 1200,
  merchant: 'コンビニA',
  proposedAccount: '消耗品費',
  image: image('a'),
  ...over,
})

describe('現金レシートの draft 投入', () => {
  it('借) 相手科目 / 貸) 現金 の draft を作る', () => {
    const { db, router } = setup()
    const r = receiptImport(router, BOOK, args())
    expect(r.outcome).toBe('registered')
    if (r.outcome !== 'registered') return

    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, r.entryId)).all()
    const debit = lines.find((l) => l.side === 'debit')!
    const credit = lines.find((l) => l.side === 'credit')!
    expect(debit.accountId).toBe(accId(db, '消耗品費'))
    expect(credit.accountId).toBe(accId(db, '現金'))
    expect(debit.amount).toBe(1200)
    expect(r.accountName).toBe('消耗品費')

    // 確定時の学習が摘要→科目を拾えるよう、相手科目は line_no=2。
    expect(lines.find((l) => l.lineNo === 2)!.accountId).toBe(accId(db, '消耗品費'))

    const entry = db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId)).all()[0]
    expect(entry.status).toBe('draft')
  })

  it('証憑を同じ操作で添付する', () => {
    const { db, router } = setup()
    const r = receiptImport(router, BOOK, args())
    if (r.outcome !== 'registered') throw new Error('registered を期待')
    const rows = db.select().from(attachments).where(eq(attachments.targetId, r.entryId)).all()
    expect(rows).toHaveLength(1)
    expect(rows[0].targetType).toBe('journal_entry')
    expect(rows[0].sha256).toBe(args().image.sha256)
  })

  it('raw_transactions も同時に残る', () => {
    const { db, router } = setup()
    const r = receiptImport(router, BOOK, args())
    if (r.outcome !== 'registered') throw new Error('registered を期待')
    const raw = db
      .select()
      .from(rawTransactions)
      .where(eq(rawTransactions.journalEntryId, r.entryId))
      .all()[0]
    expect(raw.status).toBe('journalized')
    expect(raw.dedupHash).toBe(args().image.sha256)
    expect(raw.accountRef).toBe('receipt')
  })

  it('同じ画像は二重に起票しない（冪等）', () => {
    const { db, router } = setup()
    const first = receiptImport(router, BOOK, args())
    if (first.outcome !== 'registered') throw new Error('registered を期待')

    // 日付も金額も変えて送り直しても、画像が同じなら増えない。
    const second = receiptImport(router, BOOK, args({ transactionDate: '2026-06-01', totalAmount: 9999 }))
    expect(second.outcome).toBe('skipped')
    if (second.outcome !== 'skipped') return
    expect(second.reason).toBe('duplicate')
    expect(second.entryId).toBe(first.entryId)

    expect(db.select().from(journalEntries).all()).toHaveLength(1)
    expect(db.select().from(attachments).all()).toHaveLength(1)
  })

  it('日付か金額が欠けていれば起票せず不足項目を返す', () => {
    const { db, router } = setup()
    const r = receiptImport(router, BOOK, args({ transactionDate: undefined, totalAmount: undefined }))
    expect(r.outcome).toBe('skipped')
    if (r.outcome !== 'skipped') return
    expect(r.reason).toBe('unreadable')
    expect(r.detail).toContain('transactionDate')
    expect(r.detail).toContain('totalAmount')
    expect(db.select().from(journalEntries).all()).toHaveLength(0)
  })

  it('会計期間外は起票しない', () => {
    const { db, router } = setup()
    const r = receiptImport(router, BOOK, args({ transactionDate: '2025-12-31' }))
    expect(r.outcome).toBe('skipped')
    if (r.outcome !== 'skipped') return
    expect(r.reason).toBe('out_of_period')
    expect(db.select().from(journalEntries).all()).toHaveLength(0)
  })

  it('未知の科目は未確定勘定へ寄せて理由を返す', () => {
    const { db, router } = setup()
    const r = receiptImport(router, BOOK, args({ proposedAccount: '存在しない科目' }))
    if (r.outcome !== 'registered') throw new Error('registered を期待')
    expect(r.accountName).toBe('未確定勘定')
    expect(r.unresolved).toContain('存在しない科目')
    const lines = db.select().from(journalLines).where(eq(journalLines.entryId, r.entryId)).all()
    expect(lines.find((l) => l.side === 'debit')!.accountId).toBe(accId(db, '未確定勘定'))
  })

  it('科目の指定が無くても黙って確定しない', () => {
    const { router } = setup()
    const r = receiptImport(router, BOOK, args({ proposedAccount: undefined }))
    if (r.outcome !== 'registered') throw new Error('registered を期待')
    expect(r.accountName).toBe('未確定勘定')
    expect(r.unresolved).toBeTruthy()
  })

  it('会計年度が無ければ 409 相当で弾く', () => {
    const router = new DbRouter()
    seedDataPlane(router.bookDb(BOOK))
    expect(() => receiptImport(router, BOOK, args())).toThrow(/会計年度/)
  })
})

describe('撮影時の文脈', () => {
  it('飲食の人数と相手を摘要に残す', () => {
    const d = buildReceiptDescription(
      args({ merchant: '居酒屋B', meal: { partySize: 3, participants: ['山田', '鈴木'] } }),
    )
    expect(d).toContain('居酒屋B')
    expect(d).toContain('3名')
    expect(d).toContain('山田・鈴木')
  })

  it('相手が分からなくても人数は残る', () => {
    expect(buildReceiptDescription(args({ meal: { partySize: 5 } }))).toContain('5名')
  })

  it('按分・私用と摘要を残す', () => {
    const d = buildReceiptDescription(args({ usage: 'prorated', memo: '打合せ' }))
    expect(d).toContain('按分')
    expect(d).toContain('打合せ')
  })

  it('摘要が仕訳に載る', () => {
    const { db, router } = setup()
    const r = receiptImport(router, BOOK, args({ meal: { partySize: 4, participants: ['佐藤'] } }))
    if (r.outcome !== 'registered') throw new Error('registered を期待')
    const entry = db.select().from(journalEntries).where(eq(journalEntries.id, r.entryId)).all()[0]
    expect(entry.description).toContain('4名')
    expect(entry.description).toContain('佐藤')
  })
})

describe('カード払いの突合候補', () => {
  /** カード明細相当の draft 仕訳（借 費用 / 貸 未払金）を1件置く。 */
  function seedCardEntry(db: DataDb, over: { date?: string; amount?: number; description?: string } = {}) {
    const amount = over.amount ?? 4980
    const expense = accId(db, '消耗品費')
    const payable = accId(db, '未払金')
    const fy = db.select().from(fiscalYears).all()[0]
    return createTwoLineDraftEntry(
      db,
      {
        fiscalYearId: fy.id,
        entryDate: over.date ?? '2026-05-10',
        description: over.description ?? 'カード利用 家電量販店C',
        source: 'import',
        sourceRef: 'seed',
      },
      {
        side: 'debit',
        accountId: expense,
        tax: resolveLineTax(db, { accountId: expense, subAccountId: null, amount }),
        amount,
      },
      {
        side: 'credit',
        accountId: payable,
        tax: resolveLineTax(db, { accountId: payable, subAccountId: null, amount }),
        amount,
      },
    )
  }

  it('日付近接と金額一致で候補を返す', () => {
    const { db, router } = setup()
    const entryId = seedCardEntry(db)
    const r = receiptMatch(router, BOOK, { transactionDate: '2026-05-10', totalAmount: 4980 })
    expect(r.candidates.map((c) => c.entryId)).toContain(entryId)
    const hit = r.candidates.find((c) => c.entryId === entryId)!
    expect(hit.accountName).toBe('消耗品費')
    expect(hit.reasons.join()).toContain('金額一致')
    expect(hit.reasons).toContain('日付一致')
  })

  it('店名が一致すれば根拠に出る', () => {
    const { db, router } = setup()
    seedCardEntry(db)
    const r = receiptMatch(router, BOOK, {
      transactionDate: '2026-05-10',
      totalAmount: 4980,
      merchant: '家電量販店C',
    })
    expect(r.candidates[0].reasons).toContain('店名一致')
  })

  it('日付が窓の外なら候補にしない', () => {
    const { db, router } = setup()
    seedCardEntry(db, { date: '2026-05-01' })
    const r = receiptMatch(router, BOOK, { transactionDate: '2026-05-10', totalAmount: 4980 })
    expect(r.candidates).toHaveLength(0)
  })

  it('一致する明細が無ければ空で返す（黙って起票しない）', () => {
    const { db, router } = setup()
    seedCardEntry(db)
    const r = receiptMatch(router, BOOK, { transactionDate: '2026-05-10', totalAmount: 1 })
    expect(r.candidates).toHaveLength(0)
    expect(db.select().from(journalEntries).all()).toHaveLength(1) // 増えない
  })

  it('候補が複数なら自動で選ばず全部返す', () => {
    const { db, router } = setup()
    const a = seedCardEntry(db, { description: 'カード利用 店D' })
    const b = seedCardEntry(db, { date: '2026-05-11', description: 'カード利用 店E' })
    const r = receiptMatch(router, BOOK, { transactionDate: '2026-05-10', totalAmount: 4980 })
    expect(r.candidates.map((c) => c.entryId).sort()).toEqual([a, b].sort())
  })

  it('店名一致を先に並べる', () => {
    const { db, router } = setup()
    seedCardEntry(db, { description: 'カード利用 店F' })
    const wanted = seedCardEntry(db, { date: '2026-05-12', description: 'カード利用 店G' })
    const r = receiptMatch(router, BOOK, {
      transactionDate: '2026-05-10',
      totalAmount: 4980,
      merchant: '店G',
    })
    expect(r.candidates[0].entryId).toBe(wanted)
  })

  it('突合は仕訳を作らない', () => {
    const { db, router } = setup()
    seedCardEntry(db)
    const before = db.select().from(journalEntries).all().length
    receiptMatch(router, BOOK, { transactionDate: '2026-05-10', totalAmount: 4980 })
    expect(db.select().from(journalEntries).all()).toHaveLength(before)
    expect(db.select().from(attachments).all()).toHaveLength(0)
  })
})
