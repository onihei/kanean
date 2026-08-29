// 実行殻A: Playwright（開発・Claude Code スキル経路）。
// 巡回手順そのものは `../sites/*.mjs` にあり、この殻は
//   ブラウザの起動 / 契約への薄い適合 / 証跡・診断の置き場所
// だけを与える。挙動を変えないことがこの殻の役目（design D1 の切り出し前と同一）。
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { EXIT, ScrapeError } from '../core/errors.mjs'
import { pdfToText } from '../core/pdfText.mjs'
import { fileDiagnosticsSink, fileEvidenceStore as coreEvidenceStore } from '../core/fileStores.mjs'

// src/runtime/ → src → packages/acquisition → packages → リポジトリルート
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../..')
export const PROFILE_DIR = path.join(ROOT, '.kanean/pw-profile') // playwright MCP と共有
export const FAIL_BASE = path.join(ROOT, '.kanean/acquisition/fail')
export const EVIDENCE_BASE = path.join(ROOT, '.kanean/evidence')

export async function launchBrowser({ profileDir = PROFILE_DIR } = {}) {
  const { chromium } = await import('playwright-core')
  // Akamai 等のボット検知対策: 自動化バナー/navigator.webdriver を除去（自分のデータを個人利用で取得する前提）
  const opts = {
    headless: false,
    viewport: null,
    channel: 'chrome',
    // --window-size: レスポンシブ表(UFJ-VISA等)がSP(モバイル)レイアウトに落ちて .sp ラベルが
    //   値に混入するのを防ぐためPC幅を確保 / 自動化バナー・webdriverフラグ除去でAkamai対策
    args: ['--window-size=1440,1024', '--disable-blink-features=AutomationControlled'],
    ignoreDefaultArgs: ['--enable-automation'],
  }
  try {
    return await chromium.launchPersistentContext(profileDir, opts)
  } catch (e) {
    const msg = String(e?.message ?? e)
    if (
      /SingletonLock|ProcessSingleton|already in use|Target page, context or browser has been closed/i.test(
        msg
      )
    ) {
      const err = new ScrapeError(
        'launch',
        'プロファイルが使用中（playwright MCP のブラウザが開いたまま？）',
        'MCP のブラウザを閉じて（browser_close）から再実行する'
      )
      err.exitCode = EXIT.PROFILE_LOCKED
      throw err
    }
    if (/Chromium distribution 'chrome' is not found|channel/i.test(msg)) {
      // Chrome 不在 → playwright 同梱 chromium にフォールバック
      delete opts.channel
      return await chromium.launchPersistentContext(profileDir, opts)
    }
    throw e
  }
}

/**
 * Playwright の BrowserContext を巡回契約（core/page.mjs の BROWSER_API）へ適合させる。
 * ほぼ素通しで、足りないのはバイナリ取得だけ。
 */
export function adaptContext(pwContext) {
  // Playwright のオブジェクトは内部状態を持つので、プロトタイプ継承ではなく明示的に委譲する。
  return {
    pages: () => pwContext.pages(),
    newPage: () => pwContext.newPage(),
    waitForEvent: (event, opts) => pwContext.waitForEvent(event, opts),
    close: () => pwContext.close(),
    async fetchBinary(url) {
      const res = await pwContext.request.get(url) // cookie 認証で取得
      return { ok: res.ok(), status: res.status(), body: await res.body() }
    },
  }
}

/** 失敗診断をリポジトリ配下へ残す（実体は core/fileStores。置き場所・ファイル名は従来どおり）。 */
export function fileFailureSink(source, base = FAIL_BASE) {
  const failDir = path.join(base, source, 'latest')
  const sink = fileDiagnosticsSink(failDir, { onWritten: (dir) => console.error(`  artifacts: ${dir}`) })
  return { ...sink, failDir }
}

/** 証跡（--evidence）をリポジトリ配下へ残す。無効なら保存せず null を返す（実体は core/fileStores）。 */
export function fileEvidenceStore(source, enabled, base = EVIDENCE_BASE) {
  return coreEvidenceStore(path.join(base, source), enabled)
}

export const tools = { pdfToText }

export function writeOutput(outPath, data) {
  fs.mkdirSync(path.dirname(path.resolve(outPath)), { recursive: true })
  fs.writeFileSync(outPath, JSON.stringify(data, null, 2) + '\n')
}
