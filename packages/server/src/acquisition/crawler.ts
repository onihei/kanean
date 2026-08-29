import type { Crawler } from './types.js'

/**
 * 巡回の実行殻はプロセスごとに1つ。**デスクトップ（Electron）が起動時に差し込む**。
 * サーバ本体は実装を持たない: 巡回は実ブラウザの窓を開く操作で、
 * 開発時の Node プロセスや MCP ブリッジからは行えないため。
 */
let current: Crawler | null = null

/** 巡回できない環境（開発時の素の server・テスト）での既定。 */
export const UNAVAILABLE_CRAWLER: Crawler = {
  available: false,
  async run() {
    throw new CrawlerUnavailableError()
  },
}

export class CrawlerUnavailableError extends Error {
  readonly code = 'crawler_unavailable'
  constructor() {
    super('取込の巡回はデスクトップアプリからのみ実行できます（ブラウザの窓を開く操作のため）')
    this.name = 'CrawlerUnavailableError'
  }
}

export function setCrawler(crawler: Crawler | null): void {
  current = crawler
}

export function getCrawler(): Crawler {
  return current ?? UNAVAILABLE_CRAWLER
}
