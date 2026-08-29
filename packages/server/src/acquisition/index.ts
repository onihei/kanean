// 巡回まわりの公開面。**実行殻（Electron）はデスクトップが差し込む**（サーバは実装を持たない）。
export { setCrawler, getCrawler, CrawlerUnavailableError, UNAVAILABLE_CRAWLER } from './crawler.js'
export type { Crawler, JobState, JobView } from './types.js'
export { JOB_STATES, isTerminal } from './types.js'
