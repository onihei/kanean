// 失敗診断の置き場所（アプリ経路）。`$DATA_DIR/acquisition/diagnostics/<source>/latest/`。
// 会計データと同じ `$DATA_DIR` に置くのは、これが**秘密ではない**から（認証情報は redact 済み）。
// 巡回セッション（＝秘密）は Electron 側の区画にあり、こことは別（design D7）。
import fs from 'node:fs'
import path from 'node:path'
import { fileDiagnosticsSink } from './fileStores.mjs'

export function diagnosticsDir(dataDir, source) {
  return path.join(dataDir, 'acquisition', 'diagnostics', source, 'latest')
}

export function dataDirDiagnosticsSink(dataDir, source) {
  return fileDiagnosticsSink(diagnosticsDir(dataDir, source))
}

/**
 * 直近の失敗診断を読む。**較正の見直しに足るもの**を返し、画面 HTML の全文は返さない
 * （MCP 経由で会話に載るため。必要なら所在を辿れば人が見られる）。
 * @param {number} [htmlExcerptChars] HTML の抜粋長
 */
export function readDiagnostic(dataDir, source, { htmlExcerptChars = 4000 } = {}) {
  const dir = diagnosticsDir(dataDir, source)
  const errorFile = path.join(dir, 'error.json')
  if (!fs.existsSync(errorFile)) return null
  const info = JSON.parse(fs.readFileSync(errorFile, 'utf8'))
  const htmlFile = path.join(dir, 'page.html')
  const shotFile = path.join(dir, 'screenshot.png')
  const html = fs.existsSync(htmlFile) ? fs.readFileSync(htmlFile, 'utf8') : null
  return {
    ...info,
    artifactsDir: dir,
    screenshotPath: fs.existsSync(shotFile) ? shotFile : null,
    htmlBytes: html ? Buffer.byteLength(html) : 0,
    htmlExcerpt: html ? excerptAroundTables(html, htmlExcerptChars) : null,
  }
}

/**
 * 較正の手掛かりになりやすい所（表・見出し・入力欄）を優先して抜き出す。
 * 単純な先頭 N 文字だと `<head>` のスクリプトだけで埋まって役に立たない。
 */
function excerptAroundTables(html, limit) {
  const parts = []
  const patterns = [/<table[\s\S]{0,3000}?<\/table>/gi, /<h[1-3][\s\S]{0,300}?<\/h[1-3]>/gi, /<(?:input|select)\b[^>]*>/gi]
  for (const re of patterns) {
    for (const m of html.matchAll(re)) {
      parts.push(m[0])
      if (parts.join('\n').length > limit) break
    }
    if (parts.join('\n').length > limit) break
  }
  const text = parts.length ? parts.join('\n') : html
  return text.length > limit ? text.slice(0, limit) + '\n…（省略）' : text
}
