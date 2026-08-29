import { randomUUID } from 'node:crypto'
import type { ScrapeResult } from '@kanean/acquisition'
import type { DbRouter } from '../db/router.js'
import { dataDir } from '../config.js'
import { bankImport } from '../import/bankImport.js'
import { ecImport } from '../import/ecImport.js'
import { CrawlerUnavailableError, getCrawler } from './crawler.js'
import { dumpIfRequested } from './dump.js'
import { findTarget, resolveRange } from './range.js'
import { advanceWatermark, prevDay } from './watermark.js'
import { deleteJob, listJobs, loadJob, purgeJobs, saveJob, toView, type PersistedJob } from './store.js'
import type { ImportCounts, JobView } from './types.js'
import { isTerminal } from './types.js'

/**
 * 取込ジョブの進行（acquisition spec「長時間ジョブとしての進行」）。
 *
 * 人のログイン待ちを含むので、開始と結果取得を分ける。UI からも MCP からも**同じジョブ**を触る。
 * **取込は分類を待たない**（design D4）: 取得できたらそのまま importer へ流し、
 * 科目が決まっていない明細は未確定勘定の draft として帳簿に並ぶ。分類は後工程（`classify.ts`）。
 */

/** 進行中のジョブ（プロセス内）。アプリを終了すれば消える＝再開の仕組みは持たない。 */
interface RunningJob {
  jobId: string
  bookId: string
  source: string
  aborted: boolean
}

const running = new Map<string, RunningJob>()

export class JobConflictError extends Error {
  readonly code = 'job_in_progress'
  constructor(readonly job: JobView) {
    super(`この連携サービスの取込は既に進行中です（${job.jobId}）`)
    this.name = 'JobConflictError'
  }
}

export class JobNotFoundError extends Error {
  readonly code = 'job_not_found'
  constructor(jobId: string) {
    super(`取込ジョブが見つかりません: ${jobId}`)
    this.name = 'JobNotFoundError'
  }
}

function now(): string {
  return new Date().toISOString()
}

function findRunning(bookId: string, source: string): RunningJob | undefined {
  for (const r of running.values()) if (r.bookId === bookId && r.source === source) return r
  return undefined
}

/**
 * 取込を開始する。**巡回の完了は待たない**（開始してすぐ識別子と状態を返す）。
 * @param requested 人が範囲を限る場合のみ指定する。既定は「開いている期間 ∩ 前回取得以降」。
 */
export function startJob(
  router: DbRouter,
  bookId: string,
  source: string,
  requested: { since?: string; until?: string; evidence?: boolean } = {},
): JobView {
  // 巡回の殻が無い環境（ブラウザ実行・MCP 単体）ではジョブを作らず同期的に断る。
  // 非同期の crawl 内で失敗させると 200＋即 failed のジョブになり、HTTP 層の 503
  // （crawler_unavailable）マッピングが一度も効かない（issue #142 の契約ズレ）。
  if (!getCrawler().available) throw new CrawlerUnavailableError()

  const dir = dataDir()
  purgeJobs(dir)

  // 同じ対象を二重に走らせない（acquisition spec）。進行中があればそれを返す。
  const already = findRunning(bookId, source)
  if (already) {
    const job = loadJob(dir, already.jobId)
    if (job && !isTerminal(job.state)) throw new JobConflictError(toView(job))
    running.delete(already.jobId)
  }

  const db = router.bookDb(bookId)
  const target = findTarget(db, source)
  const range = resolveRange(db, dir, bookId, source, requested)

  const job: PersistedJob = {
    jobId: randomUUID(),
    bookId,
    source,
    accountRef: target.accountRef,
    kind: target.kind,
    state: 'starting',
    waitingFor: null,
    message: null,
    failedStep: null,
    range: { since: range.since, until: range.until },
    rangeLimited: range.rangeLimited,
    startedAt: now(),
    updatedAt: now(),
    counts: null,
    calibration: null,
  }
  saveJob(dir, job)

  const handle: RunningJob = { jobId: job.jobId, bookId, source, aborted: false }
  running.set(job.jobId, handle)

  // 巡回そのものは待たずに進める（完了は状態の問い合わせで知る）。
  // crawl は本体を try/catch/finally で覆うが、catch 内の記録（saveJob）自体が失敗すると
  // （ディスクフル・権限・DATA_DIR 消失）例外が catch の外へ出て unhandledRejection＝
  // プロセス終了になる。ここで必ず受けて、巡回1件の失敗をサーバの死に昇格させない（issue #148）。
  // running の解放は crawl の finally が済ませているので、ログを残す以外にやることはない。
  crawl(router, handle, job, requested.evidence ?? false).catch((e) => {
    console.error('[acquisition] crawl failed', e)
  })

  return toView(job)
}

async function crawl(
  router: DbRouter,
  handle: RunningJob,
  job: PersistedJob,
  evidence: boolean,
): Promise<void> {
  const dir = dataDir()
  const update = (patch: Partial<PersistedJob>): void => {
    const latest = loadJob(dir, job.jobId) ?? job
    // 中断済みなら以後の状態遷移で上書きしない（人の意思を巡回の進行が消さないように）
    if (latest.state === 'aborted' && patch.state !== 'aborted') return
    Object.assign(latest, patch, { updatedAt: now() })
    saveJob(dir, latest)
  }

  try {
    update({ state: 'fetching' })
    const result = await getCrawler().run({
      source: job.source,
      since: job.range.since,
      until: job.range.until,
      evidence,
      dataDir: dir,
      log: () => {},
      onWaiting: (message) => update({ state: 'awaiting_login', waitingFor: message }),
      isAborted: () => handle.aborted,
    })

    if (handle.aborted) {
      // 中断時はそこまでに取得した分を**投入せずに**終える（acquisition spec）
      update({
        state: 'aborted',
        waitingFor: null,
        message: '人の操作で中断しました（取得分は投入していません）',
      })
      return
    }

    // 検証用ダンプ（KANEAN_ACQ_DUMP が立っているときだけ。既定では何もしない）。
    // 中断したときは通らない＝「中断したら何も残さない」を崩さない。
    dumpIfRequested(job.source, result)

    // 取れたらそのまま投入する。分類は待たない（未確定は draft として並ぶ）。
    const counts = runImport(router, job, result)
    update({
      state: 'done',
      waitingFor: null,
      counts,
      calibration: result.calibration,
      message: describe(counts),
    })
    advanceIfContinuous(job, result)
  } catch (e) {
    const err = e as { step?: string; message?: string }
    update({
      state: handle.aborted ? 'aborted' : 'failed',
      waitingFor: null,
      failedStep: err.step ?? null,
      message: err.message ?? '巡回に失敗しました',
    })
  } finally {
    running.delete(job.jobId)
  }
}

function describe(counts: ImportCounts): string {
  if (counts.accepted === 0 && counts.duplicated === 0 && counts.failed === 0)
    return '期間内に新しい明細はありませんでした'
  const unresolvedTail = counts.unresolved > 0 ? `（うち ${counts.unresolved} 件は科目が未確定）` : ''
  const failedTail =
    counts.failed > 0 ? `。${counts.failed} 件は取得できませんでした（再実行で再取得を試みます）` : ''
  return `${counts.accepted} 件を取り込みました${unresolvedTail}${failedTail}`
}

function advanceIfContinuous(job: PersistedJob, result: ScrapeResult): void {
  // 範囲を限った取得では差分の起点を前進させない（取りこぼし防止。acquisition spec）
  if (job.rangeLimited) return
  if (!result.partial) {
    advanceWatermark(dataDir(), job.bookId, job.source, result.range)
    return
  }
  // 部分成功: 巡回は古い順が規約なので、最初に失敗した明細の日付の前日までは連続して取れている。
  // そこまでだけ前進させ、失敗した分が必ず次回の既定範囲に残るようにする（acquisition spec）。
  // 失敗日が分からない・取得 0 件・失敗が範囲の先頭、のときは前進しない（現行維持）。
  const failed = result.failedOrders ?? []
  if (!failed.length) return
  const gotAny = (result.orders?.length ?? 0) > 0 || (result.transactions?.length ?? 0) > 0
  if (!gotAny) return
  const firstFailure = failed.reduce((a, f) => (f.orderDate < a ? f.orderDate : a), failed[0].orderDate)
  const contiguousUntil = prevDay(firstFailure)
  if (contiguousUntil < result.range.since) return
  advanceWatermark(dataDir(), job.bookId, job.source, {
    since: result.range.since,
    until: contiguousUntil,
  })
}

/**
 * 投入は既存 importer をそのまま通す（design D6）。
 * 科目の提案は付けない＝**すべて未確定勘定の draft**として並び、分類は後から当てる。
 */
function runImport(router: DbRouter, job: PersistedJob, scrape: ScrapeResult): ImportCounts {
  const fileName = `${job.source}-${job.range.since}_${job.range.until}`
  if (job.kind === 'ec') {
    const orders = scrape.orders ?? []
    if (orders.length === 0) return empty(scrape)
    const summary = ecImport(router, job.bookId, { accountRef: job.accountRef, fileName, orders })
    return {
      accepted: summary.acceptedLines,
      duplicated: summary.skippedDup,
      outOfPeriod: summary.excludedCount,
      unresolved: summary.unresolved.length,
      failed: (scrape.failedOrders ?? []).length,
      warnings: [
        ...(scrape.warnings ?? []),
        ...failedOrderWarnings(scrape),
        ...summary.warnings.map((w) => `${w.orderId}: ${w.message}`),
      ],
    }
  }
  const transactions = scrape.transactions ?? []
  if (transactions.length === 0) return empty(scrape)
  const summary = bankImport(router, job.bookId, {
    accountRef: job.accountRef,
    fileName,
    transactions,
  })
  return {
    accepted: summary.acceptedRows,
    duplicated: summary.skippedDup,
    outOfPeriod: summary.excludedCount,
    unresolved: summary.unresolved.length,
    failed: (scrape.failedOrders ?? []).length,
    warnings: [
      ...(scrape.warnings ?? []),
      ...failedOrderWarnings(scrape),
      ...summary.warnings.map((w) => `#${w.index}: ${w.message}`),
    ],
  }
}

function empty(scrape: ScrapeResult): ImportCounts {
  return {
    accepted: 0,
    duplicated: 0,
    outOfPeriod: 0,
    unresolved: 0,
    failed: (scrape.failedOrders ?? []).length,
    warnings: [...(scrape.warnings ?? []), ...failedOrderWarnings(scrape)],
  }
}

/** 取得できなかった注文の内訳。件数の正は counts.failed で、ここは表示用サンプル。 */
const FAILED_SAMPLE_LIMIT = 50

function failedOrderWarnings(scrape: ScrapeResult): string[] {
  const failed = scrape.failedOrders ?? []
  const shown = failed
    .slice(0, FAILED_SAMPLE_LIMIT)
    .map((f) => `注文 ${f.orderId}（${f.orderDate}）: 取得できませんでした — ${f.reason}`)
  if (failed.length > FAILED_SAMPLE_LIMIT)
    shown.push(`ほか ${failed.length - FAILED_SAMPLE_LIMIT} 件の注文が取得できませんでした`)
  return shown
}

export function getJob(jobId: string): JobView {
  const job = loadJob(dataDir(), jobId)
  if (!job) throw new JobNotFoundError(jobId)
  return toView(job)
}

export function listJobViews(bookId: string): JobView[] {
  purgeJobs(dataDir())
  return listJobs(dataDir(), bookId).map(toView)
}

/** 人による中断。巡回を止め、そこまでに取得した分を投入せずに終える。 */
export function abortJob(jobId: string): JobView {
  const dir = dataDir()
  const job = loadJob(dir, jobId)
  if (!job) throw new JobNotFoundError(jobId)
  if (isTerminal(job.state)) return toView(job)

  const handle = running.get(jobId)
  if (handle) handle.aborted = true
  job.state = 'aborted'
  job.waitingFor = null
  job.message = '人の操作で中断しました（取得分は投入していません）'
  job.updatedAt = now()
  saveJob(dir, job)
  return toView(job)
}

/** テスト用: プロセス内の進行状態を捨てる。 */
export function resetJobRuntime(): void {
  running.clear()
}

export { deleteJob, purgeJobs }
