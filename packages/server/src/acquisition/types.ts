import type { Calibration, ScrapeResult } from '@kanean/acquisition'
import { JOB_STATES, type AcquisitionJob, type ImportCounts, type JobState } from '@kanean/shared'

export { JOB_STATES }
export type { ImportCounts, JobState }

/**
 * 取込ジョブの状態（acquisition spec「長時間ジョブとしての進行」）。
 *
 *   starting ─▶ awaiting_login ─▶ fetching ─▶ done（draft が帳簿に並ぶ）
 *                    │               │
 *                    └───────────────┴──▶ failed / aborted
 *
 * **取込は分類を待たない**（design D4）。科目が決まっていない明細も未確定勘定の draft として
 * 投入され、分類は後工程（`classify.ts`）で当てる。ジョブが持つのは進行の記録だけ。
 */

export const TERMINAL_STATES: readonly JobState[] = ['done', 'failed', 'aborted']

export function isTerminal(state: JobState): boolean {
  return TERMINAL_STATES.includes(state)
}


export interface JobView extends AcquisitionJob {
  /** 較正の詳細（@kanean/acquisition の型を参照するため shared には置けない）。 */
  calibration: Calibration | null
}

/** 巡回の実行殻（Electron）。**サーバは実装を持たない**＝デスクトップが起動時に差し込む。 */
export interface Crawler {
  readonly available: boolean
  run(opts: {
    source: string
    since: string
    until: string
    evidence: boolean
    dataDir: string
    log: (msg: string) => void
    onWaiting: (message: string) => void
    isAborted: () => boolean
  }): Promise<ScrapeResult>
}
