import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { and, eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, accounts, subAccounts, journalLines, rawTransactions, mappingHistory } from '../../db/data/schema.js'
import { ecImport, journalizeEcRow } from '../ecImport.js'
import { ignoreRawTransaction, restoreRawTransaction } from '../rawStatus.js'
import { confirmEntry } from '../../journal/confirm.js'
import type { EcOrder } from '../ec.js'

const expLine = (lineNo: number, itemName: string, lineAmount: number, account = '消耗品費') => ({
  lineNo,
  itemName,
  quantity: 1,
  lineAmount,
  proposedAccount: account,
  treatment: 'expense' as const,
  evidenceRef: 'e',
})

let tmp: string
const USER = 'u_ec'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-ec-'))
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
  // 未払金に Amazon チャネル補助（linked_account_ref='amazon-1' は registerService の自動採番に相当）。クリアリング勘定。
  db.insert(subAccounts)
    .values({ accountId: accId(db, '未払金'), name: 'Amazon', linkedAccountRef: 'amazon-1', importSourceType: 'amazon', isActive: true, sortOrder: 0, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
    .run()
  return { db, router }
}

const order = (over: Partial<EcOrder> = {}): EcOrder => ({
  orderId: '249-1234567-7654321',
  orderDate: '2026-05-20',
  orderTotal: 4980,
  lines: [
    { lineNo: 1, itemName: 'SanDisk microSDXC 256GB', quantity: 1, lineAmount: 2980, proposedAccount: '消耗品費', treatment: 'expense', reason: '作業用ストレージ', confidence: 'high', policyRef: 'ec-classify@v1', evidenceRef: 'e/1.html' },
    { lineNo: 2, itemName: '鬼滅の刃 24巻', quantity: 1, lineAmount: 2000, treatment: 'owner_draw', reason: '漫画＝私用', confidence: 'high', evidenceRef: 'e/2.html' },
  ],
  ...over,
})

function linesByAmount(db: DataDb, amount: number) {
  const raw = db.select().from(rawTransactions).where(eq(rawTransactions.amount, amount)).all()[0]
  const lines = db.select().from(journalLines).where(eq(journalLines.entryId, raw.journalEntryId!)).all()
  return { raw, debit: lines.find((l) => l.side === 'debit')!, credit: lines.find((l) => l.side === 'credit')! }
}

/** 未払金（チャネル補助）の純額＝Σ(貸 − 借)。クリアリング後にカード請求額と一致すべき。 */
function payableNet(db: DataDb): number {
  const payableAcc = db.select().from(accounts).where(eq(accounts.name, '未払金')).all()[0].id
  return db
    .select()
    .from(journalLines)
    .where(eq(journalLines.accountId, payableAcc))
    .all()
    .reduce((n, l) => n + (l.side === 'credit' ? l.amount : -l.amount), 0)
}

describe('ecImport', () => {
  it('クリアリング連鎖: 借)費用科目 / 貸)未払金(Amazon) の draft を品目ごとに生成', () => {
    const { db, router } = setup()
    const s = ecImport(router, USER, { accountRef: 'amazon-1', fileName: 'amazon_2026-05.json', orders: [order()] })
    expect(s.acceptedLines).toBe(2)
    expect(s.draftEntries).toHaveLength(2)

    const payableSub = db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, 'amazon-1')).all()[0]

    // 消耗品費（expense）
    const consum = linesByAmount(db, 2980)
    expect(consum.debit.accountId).toBe(accId(db, '消耗品費'))
    expect(consum.credit.accountId).toBe(accId(db, '未払金'))
    expect(consum.credit.subAccountId).toBe(payableSub.id)
    expect(consum.debit.amount).toBe(2980)
    expect(consum.raw.status).toBe('journalized')
    expect(consum.raw.suggestedAccountId).toBe(accId(db, '消耗品費'))

    // 事業主貸（owner_draw）
    const draw = linesByAmount(db, 2000)
    expect(draw.debit.accountId).toBe(accId(db, '事業主貸'))
    expect(draw.credit.accountId).toBe(accId(db, '未払金'))
  })

  it('生成仕訳は draft・貸借一致', () => {
    const { db, router } = setup()
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [order()] })
    const consum = linesByAmount(db, 2980)
    expect(consum.debit.amount).toBe(consum.credit.amount)
  })

  it('owner_draw / 未知科目は unresolved に出す（要承認）', () => {
    const { db, router } = setup()
    const s = ecImport(router, USER, {
      accountRef: 'amazon-1',
      orders: [
        order({
          orderId: 'X-1',
          orderTotal: 1000,
          lines: [{ lineNo: 1, itemName: '謎の品', quantity: 1, lineAmount: 1000, proposedAccount: '存在しない科目', treatment: 'expense', evidenceRef: 'e/x' }],
        }),
        order(),
      ],
    })
    // 未知科目は未確定勘定にフォールバックし unresolved に積む
    const unknown = linesByAmount(db, 1000)
    expect(unknown.debit.accountId).toBe(accId(db, '未確定勘定'))
    expect(s.unresolved.some((u) => u.itemName === '謎の品' && u.reason.includes('存在しない科目'))).toBe(true)
    // owner_draw も要承認として出る
    expect(s.unresolved.some((u) => u.itemName === '鬼滅の刃 24巻')).toBe(true)
  })

  it('会計期間ゲート: 翌期の注文は取り込まない（件数で可視化）', () => {
    const { db, router } = setup()
    const s = ecImport(router, USER, { accountRef: 'amazon-1', orders: [order({ orderId: 'NY-1', orderDate: '2027-01-05' })] })
    expect(s.acceptedLines).toBe(0)
    expect(s.excludedCount).toBe(2)
    expect(db.select().from(rawTransactions).all()).toHaveLength(0)
  })

  it('冪等: 同一 source+order_id+line_no の再投入はスキップ', () => {
    const { router } = setup()
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [order()] })
    const s2 = ecImport(router, USER, { accountRef: 'amazon-1', orders: [order()] })
    expect(s2.acceptedLines).toBe(0)
    expect(s2.skippedDup).toBe(2)
  })

  it('order_total と明細合計のズレを warning に出す（明細は取り込む）', () => {
    const { router } = setup()
    const s = ecImport(router, USER, { accountRef: 'amazon-1', orders: [order({ orderTotal: 5000 })] }) // 明細合計4980
    expect(s.warnings).toHaveLength(1)
    expect(s.warnings[0].orderId).toBe('249-1234567-7654321')
    expect(s.acceptedLines).toBe(2)
  })

  it('期間境界: 1/1・12/31 は取込、前年末は除外', () => {
    const { router } = setup()
    const s = ecImport(router, USER, {
      accountRef: 'amazon-1',
      orders: [
        order({ orderId: 'B-1', orderDate: '2026-01-01', orderTotal: 2980, lines: [expLine(1, 'a', 2980)] }),
        order({ orderId: 'B-2', orderDate: '2026-12-31', orderTotal: 2980, lines: [expLine(1, 'b', 2980)] }),
        order({ orderId: 'B-3', orderDate: '2025-12-31', orderTotal: 2980, lines: [expLine(1, 'c', 2980)] }),
      ],
    })
    expect(s.acceptedLines).toBe(2)
    expect(s.excludedCount).toBe(1)
    expect(s.excludedOutOfPeriod[0].orderId).toBe('B-3')
  })

  it('同一source・別account_ref は別物として両方取込（口座別スコープ）', () => {
    const { db, router } = setup()
    db.insert(subAccounts)
      .values({ accountId: accId(db, '未払金'), name: 'Amazon2', linkedAccountRef: 'amazon-2', importSourceType: 'amazon', isActive: true, sortOrder: 1, createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' })
      .run()
    const s1 = ecImport(router, USER, { accountRef: 'amazon-1', orders: [order()] })
    const s2 = ecImport(router, USER, { accountRef: 'amazon-2', orders: [order()] })
    expect(s1.acceptedLines).toBe(2)
    expect(s2.acceptedLines).toBe(2)
    expect(s2.skippedDup).toBe(0)
  })

  it('ignored→restore は EC経路で再仕訳し AI科目を保持する（銀行 suggest を通さない）', () => {
    const { db, router } = setup()
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [order()] })
    const before = linesByAmount(db, 2980)
    ignoreRawTransaction(db, before.raw.id)
    restoreRawTransaction(db, before.raw.id)
    const after = linesByAmount(db, 2980)
    expect(after.debit.accountId).toBe(accId(db, '消耗品費')) // 未確定勘定や履歴推測ではない
    expect(after.credit.accountId).toBe(accId(db, '未払金'))
  })

  it('マーカー導入前の既存行（payload に track 無し）も restore は EC 経路で再仕訳する（batch フォールバック・issue #126）', () => {
    const { db, router } = setup()
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [order()] })
    const before = linesByAmount(db, 2980)
    // 旧世代の payload を再現: track マーカーだけ落とす（orderId 等はそのまま）。
    const p = JSON.parse(before.raw.rawPayload!) as Record<string, unknown>
    delete p.track
    db.update(rawTransactions).set({ rawPayload: JSON.stringify(p) }).where(eq(rawTransactions.id, before.raw.id)).run()
    ignoreRawTransaction(db, before.raw.id)
    restoreRawTransaction(db, before.raw.id)
    const after = linesByAmount(db, 2980)
    expect(after.debit.accountId).toBe(accId(db, '消耗品費'))
    expect(after.credit.accountId).toBe(accId(db, '未払金'))
  })

  it('会計期間ゲート: 繰越後に前年度の raw を仕訳化しようとすると弾かれる（restore・直接呼びとも）', () => {
    const { db, router } = setup()
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [order()] })
    const before = linesByAmount(db, 2980)
    ignoreRawTransaction(db, before.raw.id)
    db.update(fiscalYears).set({ status: 'closed' }).where(eq(fiscalYears.startDate, '2026-01-01')).run()
    db.insert(fiscalYears).values({ startDate: '2027-01-01', endDate: '2027-12-31', status: 'open', createdAt: '2027-01-01T00:00:00Z' }).run()

    expect(() => restoreRawTransaction(db, before.raw.id)).toThrow(/範囲外/)
    expect(db.select().from(rawTransactions).where(eq(rawTransactions.id, before.raw.id)).all()[0].status).toBe('ignored')
    // 行レベルの関数を直接呼んでも同じ（呼出側の分岐ではなく書込みの直前で弾く）。
    expect(() => journalizeEcRow(db, before.raw)).toThrow(/範囲外/)
  })

  it('未確定勘定の確定は mapping_history に学習しない（汚染防止）', () => {
    const { db, router } = setup()
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [order({ orderId: 'U-1', orderTotal: 1000, lines: [expLine(1, '謎の品', 1000, '存在しない科目')] })] })
    const u = linesByAmount(db, 1000)
    expect(u.debit.accountId).toBe(accId(db, '未確定勘定'))
    confirmEntry(db, u.raw.journalEntryId!)
    const hist = db.select().from(mappingHistory).where(and(eq(mappingHistory.sourceType, 'amazon'), eq(mappingHistory.pattern, '謎の品'))).all()
    expect(hist).toHaveLength(0)
  })

  it('学習ループ: 確定すると item_name→科目 が mapping_history に書き戻る（既存フック流用）', () => {
    const { db, router } = setup()
    const s = ecImport(router, USER, { accountRef: 'amazon-1', orders: [order()] })
    const consum = linesByAmount(db, 2980)
    confirmEntry(db, consum.raw.journalEntryId!)

    const hist = db
      .select()
      .from(mappingHistory)
      .where(and(eq(mappingHistory.sourceType, 'amazon'), eq(mappingHistory.pattern, 'SanDisk microSDXC 256GB')))
      .all()[0]
    expect(hist).toBeTruthy()
    expect(hist.accountId).toBe(accId(db, '消耗品費'))
    expect(hist.hitCount).toBe(1)
    // ドラフト2件のうち1件を確定したので s は draftEntries を返している
    expect(s.draftEntries.length).toBe(2)
  })
})

describe('ecImport 注文レベル調整（方式B・未払金=請求額）', () => {
  it('送料→借)雑費/貸)未払金・ポイント利用→借)未払金/貸)事業主借、未払金=請求額', () => {
    const { db, router } = setup()
    // 明細は値引き反映後の純額（PDF小計）。1390 + 11880 + 送料500 − ポイント165 = 13605（請求額）。
    const o = order({
      orderId: 'ADJ-1',
      orderTotal: 13605,
      shipping: 500,
      pointsUsed: 165,
      lines: [expLine(1, 'ケーブル', 1390), { lineNo: 2, itemName: 'トリマー', quantity: 1, lineAmount: 11880, treatment: 'owner_draw' as const, evidenceRef: 'e' }],
    })
    const s = ecImport(router, USER, { accountRef: 'amazon-1', orders: [o] })
    expect(s.acceptedLines).toBe(4) // 明細2 + 送料 + ポイント利用
    expect(s.warnings).toHaveLength(0) // 突合一致（黙って合わせ込まずとも 0）

    const ship = linesByAmount(db, 500)
    expect(ship.debit.accountId).toBe(accId(db, '雑費'))
    expect(ship.credit.accountId).toBe(accId(db, '未払金'))

    const pts = linesByAmount(db, 165)
    expect(pts.debit.accountId).toBe(accId(db, '未払金')) // ポイント利用は未払金を減らす
    expect(pts.credit.accountId).toBe(accId(db, '事業主借'))

    // クリアリング後の未払金 純額＝カード請求額。
    expect(payableNet(db)).toBe(13605)
  })

  it('ポイント付与→借)事業主貸/貸)雑収入（未払金に無影響）', () => {
    const { db, router } = setup()
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [order({ orderId: 'PE-1', orderTotal: 1000, pointsEarned: 30, lines: [expLine(1, 'x', 1000)] })] })
    const earned = linesByAmount(db, 30)
    expect(earned.debit.accountId).toBe(accId(db, '事業主貸'))
    expect(earned.credit.accountId).toBe(accId(db, '雑収入'))
    expect(payableNet(db)).toBe(1000) // 明細分のみ
  })

  it('調整込みでも Σ純額+送料−ポイント≠請求額 なら warning（黙って落とさない）', () => {
    const { router } = setup()
    const s = ecImport(router, USER, { accountRef: 'amazon-1', orders: [order({ orderId: 'M-1', orderTotal: 9999, shipping: 100, pointsUsed: 50, lines: [expLine(1, 'a', 1000)] })] })
    expect(s.warnings.some((w) => w.orderId === 'M-1')).toBe(true) // 1000+100-50=1050≠9999
    expect(s.acceptedLines).toBe(3) // 明細1 + 送料 + ポイント（取込は継続）
  })

  it('調整行も冪等（再投入でスキップ）', () => {
    const { router } = setup()
    const o = order({ orderId: 'I-1', orderTotal: 1100, shipping: 100, lines: [expLine(1, 'a', 1000)] })
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [o] })
    const s2 = ecImport(router, USER, { accountRef: 'amazon-1', orders: [o] })
    expect(s2.acceptedLines).toBe(0)
    expect(s2.skippedDup).toBe(2) // 明細 + 送料
  })

  it('調整行の ignored→restore も EC経路で正しく再仕訳（送料=借)雑費/貸)未払金）', () => {
    const { db, router } = setup()
    ecImport(router, USER, { accountRef: 'amazon-1', orders: [order({ orderId: 'R-1', orderTotal: 1100, shipping: 100, lines: [expLine(1, 'a', 1000)] })] })
    const ship = linesByAmount(db, 100)
    ignoreRawTransaction(db, ship.raw.id)
    restoreRawTransaction(db, ship.raw.id)
    const after = linesByAmount(db, 100)
    expect(after.debit.accountId).toBe(accId(db, '雑費'))
    expect(after.credit.accountId).toBe(accId(db, '未払金'))
  })
})
