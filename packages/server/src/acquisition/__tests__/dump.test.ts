import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import type { ScrapeResult } from '@kanean/acquisition'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { accounts, fiscalYears, subAccounts } from '../../db/data/schema.js'
import { setCrawler } from '../crawler.js'
import { dumpIfRequested } from '../dump.js'
import { abortJob, getJob, resetJobRuntime, startJob } from '../jobs.js'
import type { Crawler, JobState } from '../types.js'

/**
 * 検証用ダンプ（tasks 4.3 / 10.4）。**既定では何もしない**ことと、
 * 出せば `bin/scrape.mjs --out` と同じ形が落ちることを固定する。
 */

let tmp: string
let out: string
const BOOK = 'b_dump'
const REF = 'bank_ufj-1'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-dump-'))
  out = path.join(tmp, 'dumped')
  process.env.DATA_DIR = tmp
  delete process.env.KANEAN_ACQ_DUMP
  resetJobRuntime()
})
afterEach(() => {
  setCrawler(null)
  resetJobRuntime()
  delete process.env.KANEAN_ACQ_DUMP
  fs.rmSync(tmp, { recursive: true, force: true })
})

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

function setup(): DbRouter {
  const router = new DbRouter()
  const db = router.bookDb(BOOK)
  seedDataPlane(db)
  db.insert(fiscalYears)
    .values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' })
    .run()
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
  return router
}

function scrapeResult(): ScrapeResult {
  return {
    source: 'bank_ufj',
    kind: 'bank',
    script: 'mufg@v3',
    calibration: { source: 'bank_ufj', origin: 'bundled', version: 'bundled:abc', overridden: [] },
    scrapedAt: '2026-08-12T00:00:00Z',
    range: { since: '2026-01-01', until: '2026-06-30' },
    transactions: [
      { txnDate: '2026-05-10', amount: 3000, direction: 'out', description: 'デンキダイ', balance: 97000 },
    ],
    warnings: [],
    exitCode: 0,
  }
}

function fakeCrawler(opts: { hold?: Promise<void> } = {}): Crawler {
  return {
    available: true,
    async run() {
      if (opts.hold) await opts.hold
      return scrapeResult()
    },
  }
}

async function waitForState(jobId: string, state: JobState, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (getJob(jobId).state === state) return
    if (Date.now() > deadline) throw new Error(`状態 ${state} に到達しない（現在 ${getJob(jobId).state}）`)
    await new Promise((r) => setTimeout(r, 10))
  }
}

describe('dumpIfRequested', () => {
  it('環境変数が無ければ何も書かない（配布物では経路ごと死んでいる）', () => {
    expect(dumpIfRequested('bank_ufj', scrapeResult())).toBeNull()
  })

  it('空文字は「未設定」と同じに扱う', () => {
    process.env.KANEAN_ACQ_DUMP = '   '
    expect(dumpIfRequested('bank_ufj', scrapeResult())).toBeNull()
  })

  it('CLI の --out と同じ形で書く（exitCode を落とす・2スペース・末尾改行）', () => {
    process.env.KANEAN_ACQ_DUMP = out
    const file = dumpIfRequested('bank_ufj', scrapeResult())
    expect(file).toBe(path.join(out, 'bank_ufj.json'))

    const text = fs.readFileSync(file!, 'utf8')
    expect(text.endsWith('}\n')).toBe(true)
    expect(text).toContain('\n  "source": "bank_ufj"')

    const parsed = JSON.parse(text)
    expect(parsed.exitCode).toBeUndefined()
    expect(parsed.transactions).toHaveLength(1)
    expect(parsed.calibration.version).toBe('bundled:abc')
  })

  it('書けなくても投げない（検証の補助が取込を止めないこと）', () => {
    // ファイルを出力先の名前で作っておく＝ディレクトリを作れない
    fs.writeFileSync(out, 'not a directory')
    process.env.KANEAN_ACQ_DUMP = out
    expect(dumpIfRequested('bank_ufj', scrapeResult())).toBeNull()
  })
})

describe('取込ジョブからのダンプ', () => {
  it('取込が通ればダンプが残る', async () => {
    process.env.KANEAN_ACQ_DUMP = out
    const router = setup()
    setCrawler(fakeCrawler())
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')
    expect(fs.existsSync(path.join(out, 'bank_ufj.json'))).toBe(true)
  })

  it('中断したときは書かない（中断したら何も残さない）', async () => {
    process.env.KANEAN_ACQ_DUMP = out
    const router = setup()
    let release!: () => void
    setCrawler(fakeCrawler({ hold: new Promise<void>((r) => (release = r)) }))
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'fetching')

    abortJob(view.jobId)
    release()
    await new Promise((r) => setTimeout(r, 50))

    expect(getJob(view.jobId).state).toBe('aborted')
    expect(fs.existsSync(path.join(out, 'bank_ufj.json'))).toBe(false)
  })

  it('環境変数が無ければ取込が通ってもファイルは増えない', async () => {
    const router = setup()
    setCrawler(fakeCrawler())
    const view = startJob(router, BOOK, 'bank_ufj')
    await waitForState(view.jobId, 'done')
    expect(fs.existsSync(out)).toBe(false)
  })
})
