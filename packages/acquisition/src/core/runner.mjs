// step 実行と失敗診断。**どこへ残すか（sink）は殻が決める**。
//   スキル経路 : リポジトリ配下の .kanean/acquisition/fail/<source>/latest/
//   アプリ経路 : $DATA_DIR/acquisition/diagnostics/<source>/latest/
// 診断の中身は殻によらず同じ形にする（MCP から同じ形で取り出せるようにするため）。

import { ScrapeError } from './errors.mjs'
import { redactHtml, redactUrl } from './redact.mjs'

/**
 * @param {string} source 連携サービスの識別子（`bank_ufj` など）
 * @param {{ sink?: { dump(record: object): Promise<unknown> }, log?: (msg: string) => void }} [opts]
 */
export function makeRunner(source, { sink, log = console.log } = {}) {
  let page = null
  const steps = []
  return {
    steps,
    setPage(p) {
      page = p
    },
    async step(name, fn) {
      log(`▶ ${name}`)
      steps.push(name)
      try {
        return await fn()
      } catch (e) {
        const err = e instanceof ScrapeError ? e : new ScrapeError(name, String(e?.message ?? e))
        err.step ||= name
        err.diagnostic = await captureDiagnostic({ source, page, err, steps })
        if (sink) {
          await sink.dump(err.diagnostic).catch(() => {})
          err.dumped = true
        }
        log(`✖ step=${err.step}: ${err.message}`)
        if (err.hint) log(`  hint: ${err.hint}`)
        throw err
      }
    },
  }
}

/**
 * 失敗の手掛かりを集める。**認証情報とセッション識別子は含めない**（redact.mjs）。
 * ブラウザが死んでいても、最低限 step / message は返す。
 */
export async function captureDiagnostic({ source, page, err, steps = [] }) {
  const record = {
    source,
    step: err.step,
    steps,
    message: err.message,
    hint: err.hint ?? null,
    url: null,
    html: null,
    screenshot: null,
    time: new Date().toISOString(),
  }
  if (!page) return record
  try {
    record.url = redactUrl(page.url())
  } catch {
    // ページが閉じていれば URL も取れない
  }
  try {
    record.html = redactHtml(await page.content())
  } catch {
    // 同上
  }
  try {
    record.screenshot = await page.screenshot({ fullPage: true })
  } catch {
    // 同上
  }
  return record
}
