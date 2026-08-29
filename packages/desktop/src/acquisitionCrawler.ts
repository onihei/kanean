import { BrowserWindow, session } from 'electron'
import {
  dataDirDiagnosticsSink,
  dataDirEvidenceStore,
  getSite,
  pdfToText,
  readOverride,
  runScrape,
  type ScrapeResult,
} from '@kanean/acquisition'
import {
  clearAcquisitionSession,
  createElectronContext,
  ACQUISITION_PARTITION,
} from '@kanean/acquisition/runtime/electron'
import type { Crawler } from '@kanean/server/acquisition'

/**
 * 巡回の実行殻をアプリへ差し込む（design D1 の実行殻B）。
 *
 * ここが持つのは「Electron の窓とセッションを用意して巡回に渡す」ことだけ。
 * 巡回手順そのものは `@kanean/acquisition` の sites/ にあり、Claude Code のスキル経路と**同じ実体**を使う。
 *
 * 巡回窓は外部サイトを開くので、既定セッションではない専用区画で開く
 * （＝`kanean://` のハンドラがこの窓からは見えない＝アプリ内 API へ到達しえない）。
 */

/** 開いている巡回ウィンドウ。アプリ終了時にまとめて閉じる（何も残さないため）。 */
const openWindows = new Set<BrowserWindow>()

export function electronCrawler(): Crawler {
  return {
    available: true,
    async run({ source, since, until, evidence, dataDir, log, onWaiting, isAborted }): Promise<ScrapeResult> {
      const site = getSite(source)
      if (!site) throw new Error(`巡回手順を持っていない連携サービスです: ${source}`)

      const context = createElectronContext({
        electron: { BrowserWindow, session },
        onWindow: (win) => {
          const w = win as BrowserWindow
          openWindows.add(w)
          w.on('closed', () => openWindows.delete(w))
        },
      })
      try {
        return await runScrape({
          site,
          context,
          args: { since, until },
          selectorsOverride: readOverride(dataDir, source),
          evidence: dataDirEvidenceStore(dataDir, site.EVIDENCE_KEY, evidence),
          sink: dataDirDiagnosticsSink(dataDir, source),
          tools: { pdfToText },
          log,
          onWaiting,
          isAborted,
        })
      } finally {
        // 巡回が終わったら窓は必ず閉じる（成功でも失敗でも中断でも）
        await context.close()
      }
    },
  }
}

/** 巡回ウィンドウを全て閉じる。アプリ終了時と、業務ウィンドウが閉じられたときに呼ぶ。 */
export function closeAcquisitionWindows(): void {
  for (const win of [...openWindows]) {
    if (!win.isDestroyed()) win.destroy()
  }
  openWindows.clear()
}

export function acquisitionWindowCount(): number {
  return openWindows.size
}

/** 巡回のログイン状態を捨てる（acquisition spec「ログイン状態を破棄できる」）。 */
export async function forgetAcquisitionLogins(): Promise<void> {
  closeAcquisitionWindows()
  await clearAcquisitionSession({ session }, ACQUISITION_PARTITION)
}
