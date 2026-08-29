import fs from 'node:fs'
import path from 'node:path'
import type { Calibration } from '@kanean/acquisition'
import { jobsDir, readJsonSafe, writeJsonAtomic } from './paths.js'
import type { ImportCounts, JobState, JobView } from './types.js'
import { isTerminal, JOB_STATES } from './types.js'

/**
 * 取込ジョブの記録。**進行の記録だけ**を持ち、明細は持たない（design D4）。
 *
 * 明細は取り込んだ時点で帳簿（data plane）へ入るので、ここに会計データは残らない。
 * このファイルが全部消えても帳簿は完全に成立する（失うのは「直近の取込の結果表示」だけ）。
 */
export interface PersistedJob {
  jobId: string
  bookId: string
  source: string
  accountRef: string
  kind: 'bank' | 'card' | 'ec'
  state: JobState
  waitingFor: string | null
  message: string | null
  failedStep: string | null
  range: { since: string; until: string }
  rangeLimited: boolean
  startedAt: string
  updatedAt: string
  counts: ImportCounts | null
  calibration: Calibration | null
}

/** 進行中のまま放置された記録を残す日数（アプリを落とせば巡回は消えるので、記録だけが残りうる）。 */
export const RUNNING_TTL_DAYS = 1
/** 終わったジョブの記録を残す日数（結果の確認のためだけに残す）。 */
export const TERMINAL_TTL_DAYS = 7

function jobFile(dataDir: string, jobId: string): string {
  return path.join(jobsDir(dataDir), `${jobId}.json`)
}

export function saveJob(dataDir: string, job: PersistedJob): void {
  writeJsonAtomic(jobFile(dataDir, job.jobId), job)
}

/**
 * 記録の形が変わったあとに残っている古いファイルは、無いものとして扱う。
 * ここには会計データが無いので捨てて困らない。読めない記録を UI や MCP へ流すと
 * 「知らない状態」を各所で場当たりに扱うことになるので、入口で落とす。
 */
function isReadable(job: PersistedJob | null): job is PersistedJob {
  return job != null && (JOB_STATES as readonly string[]).includes(job.state)
}

export function loadJob(dataDir: string, jobId: string): PersistedJob | null {
  const job = readJsonSafe<PersistedJob | null>(jobFile(dataDir, jobId), null)
  return isReadable(job) ? job : null
}

export function listJobs(dataDir: string, bookId?: string): PersistedJob[] {
  const dir = jobsDir(dataDir)
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.json'))
    .map((f) => readJsonSafe<PersistedJob | null>(path.join(dir, f), null))
    .filter((j): j is PersistedJob => isReadable(j) && (!bookId || j.bookId === bookId))
    .sort((a, b) => b.startedAt.localeCompare(a.startedAt))
}

export function deleteJob(dataDir: string, jobId: string): void {
  const f = jobFile(dataDir, jobId)
  if (fs.existsSync(f)) fs.rmSync(f)
}

/**
 * 古い記録を掃除する。会計データではないので、消えても取り直しは発生しない。
 * 呼び出し側は取込の開始・一覧のたびに呼べばよい（掃除のための常駐処理を持たない）。
 */
export function purgeJobs(dataDir: string, now = new Date()): { removed: string[] } {
  const removed: string[] = []
  for (const job of listJobs(dataDir)) {
    const ageDays = (now.getTime() - new Date(job.updatedAt).getTime()) / 86_400_000
    const ttl = isTerminal(job.state) ? TERMINAL_TTL_DAYS : RUNNING_TTL_DAYS
    if (ageDays > ttl) {
      deleteJob(dataDir, job.jobId)
      removed.push(job.jobId)
    }
  }
  return { removed }
}

export function toView(job: PersistedJob): JobView {
  return {
    jobId: job.jobId,
    bookId: job.bookId,
    source: job.source,
    accountRef: job.accountRef,
    kind: job.kind,
    state: job.state,
    waitingFor: job.waitingFor,
    message: job.message,
    range: job.range,
    rangeLimited: job.rangeLimited,
    startedAt: job.startedAt,
    updatedAt: job.updatedAt,
    calibration: job.calibration,
    // `failed` が無い旧記録（フィールド追加前）は 0 として読む
    counts: job.counts ? { ...job.counts, failed: (job.counts as Partial<ImportCounts>).failed ?? 0 } : null,
    failedStep: job.failedStep,
  }
}
