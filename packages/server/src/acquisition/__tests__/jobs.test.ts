import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { ScrapeResult } from '@kanean/acquisition'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, fiscalYears, journalEntries, subAccounts } from '../../db/data/schema.js'
import { setCrawler } from '../crawler.js'
import { jobsDir } from '../paths.js'
import {
  abortJob,
  getJob,
  JobConflictError,
  listJobViews,
  resetJobRuntime,
  startJob,
} from '../jobs.js'
import { listUnclassified } from '../classify.js'
import { resolveRange } from '../range.js'
import { getWatermark } from '../watermark.js'
import type { Crawler, JobState } from '../types.js'

let tmp: string
const BOOK = 'b_acq'
const REF = 'bank_ufj-1'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-job-'))
  process.env.DATA_DIR = tmp
  resetJobRuntime()
})
afterEach(() => {
  setCrawler(null)
  resetJobRuntime()
  fs.rmSync(tmp, { recursive: true, force: true })
})

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

const EC_REF = 'amazon-1'

/** EC（Amazon）も繋がった状態にする。既存の setup に未払金チャネルを足すだけ。 */
function setupEc(): { db: DataDb; router: DbRouter; fyId: number } {
  const ctx = setup()
  ctx.db
    .insert(subAccounts)
    .values({
      accountId: accId(ctx.db, '未払金'),
      name: 'Amazon',
      linkedAccountRef: EC_REF,
      importSourceType: 'amazon',
      isActive: true,
      sortOrder: 1,
      createdAt: '2026-01-01T00:00:00Z',
      updatedAt: '2026-01-01T00:00:00Z',
    })
    .run()
  return ctx
}

function ecOrder(orderId: string, orderDate: string, amount = 1000) {
  return {
    orderId,
    orderDate,
    orderTotal: amount,
    shipping: 0,
    pointsUsed: 0,
    lines: [
      { lineNo: 1, itemName: `品-${orderId}`, quantity: 1, lineAmount: amount, evidenceRef: `https://example.test/${orderId}` },
    ],
  }
}

function ecScrapeResult(over: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    source: 'amazon',
    kind: 'ec',
    script: 'amazon@v4',
    calibration: { source: 'amazon', origin: 'bundled', version: 'bundled:abc', overridden: [] },
    scrapedAt: '2026-08-12T00:00:00Z',
    range: { since: '2026-01-01', until: '2026-06-30' },
    orders: [ecOrder('250-0000001-0000001', '2026-02-01'), ecOrder('250-0000002-0000002', '2026-05-01')],
    warnings: [],
    exitCode: 0,
    ...over,
  }
}

function scrapeResult(over: Partial<ScrapeResult> = {}): ScrapeResult {
  return {
    source: 'bank_ufj',
    kind: 'bank',
    script: 'mufg@v3',
    calibration: { source: 'bank_ufj', origin: 'bundled', version: 'bundled:abc', overridden: [] },
    scrapedAt: '2026-08-12T00:00:00Z',
    range: { since: '2026-01-01', until: '2026-06-30' },
    transactions: [
      { txnDate: '2026-05-10', amount: 3000, direction: 'out', description: 'デンキダイ', balance: 97000 },
      { txnDate: '2026-05-11', amount: 2000, direction: 'out', description: 'デンキダイ', balance: 95000 },
    ],
    warnings: [],
    exitCode: 0,
    ...over,
  }
}

/** 巡回の代わり。`hold` を解くまで終わらないので、進行中の状態を観察できる。 */
function fakeCrawler(
  opts: { result?: ScrapeResult; fail?: Error; hold?: Promise<void>; waitingMessage?: string } = {},
): Crawler & { seen: { isAborted: () => boolean } | null } {
  const holder = { seen: null as { isAborted: () => boolean } | null }
  return Object.assign(holder, {
    available: true,
    async run(args: Parameters<Crawler['run']>[0]) {
      holder.seen = args
      if (opts.waitingMessage) args.onWaiting(opts.waitingMessage)
      if (opts.hold) await opts.hold
      if (opts.fail) throw opts.fail
      return opts.result ?? scrapeResult()
    },
  })
}

async function waitForState(jobId: string, state: JobState, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (getJob(jobId).state === state) return
    if (Date.now() > deadline) throw new Error(`状態 ${state} に到達しない（現在 ${getJob(jobId).state}）`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('進行', () => {
  it('開始してすぐ識別子と状態を返す（巡回の完了は待たない）', async () => {
    const { router } = setup()
    let release!: () => void
    setCrawler(fakeCrawler({ hold: new Promise<void>((r) => (release = r)) }))

    const view = startJob(router, BOOK, 'bank_ufj')
    expect(view.jobId).toBeTruthy()
    expect(['starting', 'fetching']).toContain(view.state)
    expect(view.range).toEqual({ since: '2026-01-01', until: expect.any(String) })

    release()
    await waitForState(view.jobId, 'done')
  })

  it('何を待っているか（ログイン）が分かる', async () => {
    const { router } = setup()
    let release!: () => void
    setCrawler(
      fakeCrawler({
        hold: new Promise<void>((r) => (release = r)),
        waitingMessage: '三菱UFJダイレクトにログインしてください',
      }),
    )
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'awaiting_login')
    expect(getJob(view.jobId).waitingFor).toContain('ログイン')
    release()
    await waitForState(view.jobId, 'done')
  })

  it('同じ対象を二重に走らせない（進行中のジョブを返す）', async () => {
    const { router } = setup()
    let release!: () => void
    setCrawler(fakeCrawler({ hold: new Promise<void>((r) => (release = r)) }))
    const first = startJob(router, BOOK, 'bank_ufj')

    let thrown: unknown = null
    try {
      startJob(router, BOOK, 'bank_ufj')
    } catch (e) {
      thrown = e
    }
    expect(thrown).toBeInstanceOf(JobConflictError)
    expect((thrown as JobConflictError).job.jobId).toBe(first.jobId)

    release()
    await waitForState(first.jobId, 'done')
  })

  it('巡回が失敗したら、どの手順で失敗したかを残す', async () => {
    const { router } = setup()
    const err = Object.assign(new Error('明細テーブルが見つからない'), { step: 'extract-table' })
    setCrawler(fakeCrawler({ fail: err }))
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'failed')
    expect(getJob(view.jobId).failedStep).toBe('extract-table')
    expect(getJob(view.jobId).message).toContain('明細テーブル')
  })

  it('失敗の記録自体が書けなくても（catch 内 saveJob 例外）プロセスを道連れにしない（issue #148）', async () => {
    const { router } = setup()
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {})
    // catch 節の update→saveJob を確実に失敗させる: jobs ディレクトリの位置を普通のファイルで塞ぐ
    // （writeJsonAtomic の mkdirSync が ENOTDIR/EEXIST で throw）＝DATA_DIR 破損の再現。
    setCrawler({
      available: true,
      run: async () => {
        fs.rmSync(jobsDir(tmp), { recursive: true, force: true })
        fs.writeFileSync(jobsDir(tmp), 'not a directory')
        throw new Error('巡回失敗')
      },
    } as Crawler)
    startJob(router, BOOK, 'bank_ufj')
    // 未捕捉なら unhandledRejection で vitest がテストを落とす。捕捉されてログに残ることを確認。
    await vi.waitFor(() => expect(errSpy).toHaveBeenCalledWith('[acquisition] crawl failed', expect.any(Error)))
    errSpy.mockRestore()

    // finally（running 解放）は catch の例外より先に済んでいる＝復旧後は同じ source を再開できる。
    fs.rmSync(jobsDir(tmp), { force: true })
    setCrawler(fakeCrawler())
    const second = startJob(router, BOOK, 'bank_ufj')
    await waitForState(second.jobId, 'done')
  })

  it('取れるものが無ければそのまま完了する', async () => {
    const { router } = setup()
    setCrawler(fakeCrawler({ result: scrapeResult({ transactions: [] }) }))
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')
    expect(getJob(view.jobId).counts?.accepted).toBe(0)
    expect(getJob(view.jobId).message).toContain('新しい明細はありません')
  })

  it('一覧で追える', async () => {
    const { router } = setup()
    setCrawler(fakeCrawler())
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')
    expect(listJobViews(BOOK).map((j) => j.jobId)).toContain(view.jobId)
    expect(listJobViews('other-book')).toHaveLength(0)
  })

  it('どの較正で取ったかが結果に残る', async () => {
    const { router } = setup()
    setCrawler(fakeCrawler())
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')
    expect(getJob(view.jobId).calibration).toMatchObject({ origin: 'bundled', version: 'bundled:abc' })
  })
})

describe('取込は分類を待たない', () => {
  it('取り込んだ時点で draft が帳簿に並ぶ', async () => {
    const { db, router } = setup()
    setCrawler(fakeCrawler())
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')

    const entries = db.select().from(journalEntries).all()
    expect(entries).toHaveLength(2)
    // 投入結果はすべて draft（承認は人が UI で行う）
    expect(entries.every((e) => e.status === 'draft')).toBe(true)

    const counts = getJob(view.jobId).counts!
    expect(counts.accepted).toBe(2)
    // 科目が決まっていないので、そのぶんが未確定として示される
    expect(counts.unresolved).toBe(2)
    expect(getJob(view.jobId).message).toContain('科目が未確定')
  })

  it('取り込んだものがそのまま分類対象になる', async () => {
    const { db, router, fyId } = setup()
    setCrawler(fakeCrawler())
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')

    const { items } = listUnclassified(db, fyId)
    expect(items.map((i) => i.text)).toEqual(['デンキダイ']) // 同じ摘要はまとまる
    expect(items[0].count).toBe(2)
  })

  it('同じ明細を2回取り込んでも二重計上しない（冪等は既存 importer が持つ）', async () => {
    const { db, router } = setup()
    setCrawler(fakeCrawler())

    const first = startJob(router, BOOK, 'bank_ufj')
    await waitForState(first.jobId, 'done')

    const second = startJob(router, BOOK, 'bank_ufj', { since: '2026-01-01', until: '2026-06-30' })
    await waitForState(second.jobId, 'done')

    expect(getJob(second.jobId).counts?.accepted).toBe(0)
    expect(getJob(second.jobId).counts?.duplicated).toBe(2)
    expect(db.select().from(journalEntries).all()).toHaveLength(2)
  })
})

describe('中断', () => {
  it('中断するとそこまでの分を投入せずに終える', async () => {
    const { db, router } = setup()
    let release!: () => void
    const crawler = fakeCrawler({ hold: new Promise<void>((r) => (release = r)) })
    setCrawler(crawler)
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'fetching')

    const aborted = abortJob(view.jobId)
    expect(aborted.state).toBe('aborted')
    expect(crawler.seen?.isAborted()).toBe(true)

    release()
    await new Promise((r) => setTimeout(r, 50))
    expect(getJob(view.jobId).state).toBe('aborted') // 巡回の完了で上書きされない
    expect(db.select().from(journalEntries).all()).toHaveLength(0)
  })

  it('終わったジョブの中断は何もしない', async () => {
    const { router } = setup()
    setCrawler(fakeCrawler())
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')
    abortJob(view.jobId)
    expect(getJob(view.jobId).state).toBe('done')
  })
})

describe('取りこぼしの防止', () => {
  it('通常の取得では連続終端が前進する', async () => {
    const { router } = setup()
    setCrawler(fakeCrawler())
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')
    expect(getWatermark(tmp, BOOK, 'bank_ufj')).toBe('2026-06-30')
  })

  it('範囲を限った取得では前進させない（残りが次回の対象として残る）', async () => {
    const { router } = setup()
    setCrawler(
      fakeCrawler({ result: scrapeResult({ range: { since: '2026-06-01', until: '2026-06-30' } }) }),
    )
    const view = startJob(router, BOOK, 'bank_ufj', { since: '2026-06-01', until: '2026-06-30' })
    expect(view.rangeLimited).toBe(true)
    await waitForState(view.jobId, 'done')
    expect(getWatermark(tmp, BOOK, 'bank_ufj')).toBeNull()
  })

  it('部分成功では前進させない（拾えなかった分が二度と来ないため）', async () => {
    const { router } = setup()
    setCrawler(fakeCrawler({ result: scrapeResult({ partial: true }) }))
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')
    expect(getWatermark(tmp, BOOK, 'bank_ufj')).toBeNull()
  })
})

describe('部分成功（取得できなかった注文の可視化と連続終端）', () => {
  const FAILED = [
    { orderId: '250-0000003-0000003', orderDate: '2026-03-10', reason: '突合NG: Σline≠total' },
    { orderId: '250-0000004-0000004', orderDate: '2026-04-02', reason: 'PDF取得失敗 HTTP 500' },
  ]

  it('取得できなかった件数と理由が結果と完了メッセージに出る', async () => {
    const { router } = setupEc()
    setCrawler(fakeCrawler({ result: ecScrapeResult({ failedOrders: FAILED, partial: true }) }))
    const view = startJob(router, BOOK, 'amazon')
    await waitForState(view.jobId, 'done')

    const job = getJob(view.jobId)
    expect(job.counts?.accepted).toBe(2)
    expect(job.counts?.failed).toBe(2)
    expect(job.message).toContain('2 件は取得できませんでした')
    expect(job.message).toContain('再実行で再取得')
    // 個別の理由は warnings に注文ID・日付付きで並ぶ（UI の警告欄がそのまま見せる）
    expect(
      job.counts?.warnings.some((w) => w.includes('250-0000003-0000003') && w.includes('突合NG')),
    ).toBe(true)
    expect(job.counts?.warnings.some((w) => w.includes('2026-04-02'))).toBe(true)
  })

  it('全件取得できたときは失敗表示を出さない', async () => {
    const { router } = setupEc()
    setCrawler(fakeCrawler({ result: ecScrapeResult() }))
    const view = startJob(router, BOOK, 'amazon')
    await waitForState(view.jobId, 'done')
    expect(getJob(view.jobId).counts?.failed).toBe(0)
    expect(getJob(view.jobId).message).not.toContain('取得できませんでした')
  })

  it('初回取込の部分失敗では「最初の失敗の前日」まで前進し、次回の既定範囲が失敗注文を含む', async () => {
    const { db, router } = setupEc()
    setCrawler(fakeCrawler({ result: ecScrapeResult({ failedOrders: FAILED, partial: true }) }))
    const view = startJob(router, BOOK, 'amazon')
    await waitForState(view.jobId, 'done')

    expect(getWatermark(tmp, BOOK, 'amazon')).toBe('2026-03-09')
    // 取込済み明細の最大日付（2026-05-01）へ飛ばず、失敗した 2026-03-10 が次回の範囲に入る
    const next = resolveRange(db, tmp, BOOK, 'amazon')
    expect(next.since).toBe('2026-03-10')
    expect(next.rangeLimited).toBe(false)
  })

  it('最初の失敗が範囲の先頭なら前進しない', async () => {
    const { router } = setupEc()
    setCrawler(
      fakeCrawler({
        result: ecScrapeResult({
          failedOrders: [{ orderId: '250-0000005-0000005', orderDate: '2026-01-01', reason: 'PDFが読めない' }],
          partial: true,
        }),
      }),
    )
    const view = startJob(router, BOOK, 'amazon')
    await waitForState(view.jobId, 'done')
    expect(getWatermark(tmp, BOOK, 'amazon')).toBeNull()
  })

  it('取得できた注文が無い部分成功では前進せず、失敗だけを報せる', async () => {
    const { router } = setupEc()
    setCrawler(fakeCrawler({ result: ecScrapeResult({ orders: [], failedOrders: FAILED, partial: true }) }))
    const view = startJob(router, BOOK, 'amazon')
    await waitForState(view.jobId, 'done')

    expect(getWatermark(tmp, BOOK, 'amazon')).toBeNull()
    expect(getJob(view.jobId).counts?.accepted).toBe(0)
    expect(getJob(view.jobId).counts?.failed).toBe(2)
    expect(getJob(view.jobId).message).toContain('取得できませんでした')
  })

  it('範囲を限った取得では部分成功でも前進しない', async () => {
    const { router } = setupEc()
    setCrawler(
      fakeCrawler({
        result: ecScrapeResult({
          range: { since: '2026-03-01', until: '2026-06-30' },
          orders: [ecOrder('250-0000002-0000002', '2026-05-01')],
          failedOrders: [{ orderId: '250-0000006-0000006', orderDate: '2026-06-01', reason: '突合NG' }],
          partial: true,
        }),
      }),
    )
    const view = startJob(router, BOOK, 'amazon', { since: '2026-03-01', until: '2026-06-30' })
    expect(view.rangeLimited).toBe(true)
    await waitForState(view.jobId, 'done')
    expect(getWatermark(tmp, BOOK, 'amazon')).toBeNull()
  })
})

describe('巡回できない環境', () => {
  it('デスクトップ以外では、その旨を返して始めない（ジョブを作らない）', () => {
    const { router } = setup()
    setCrawler(null) // 開発時の server 単体・MCP ブリッジ
    // 同期的に断る＝HTTP 層で 503 crawler_unavailable になる。failed ジョブは残さない。
    expect(() => startJob(router, BOOK, 'bank_ufj')).toThrow(/デスクトップアプリ/)
    expect(listJobViews(BOOK)).toHaveLength(0)
  })
})
