#!/usr/bin/env node
// PDF をテキスト化する（同梱 pdf.js。`pdftotext -layout` の代わり）。
//
//   node packages/acquisition/bin/pdf-text.mjs inv1.pdf
//
// スキル/MCP フォールバックで請求書を読むときに使う。巡回本体（bin/scrape.mjs）は
// これを経由せず `core/pdfText.mjs` を直接呼ぶ。poppler は要らない（tasks 10.2a）。
import fs from 'node:fs'
import { pdfToText } from '../src/core/pdfText.mjs'

const file = process.argv[2]
if (!file) {
  console.error('使い方: pdf-text.mjs <file.pdf>')
  process.exit(1)
}

try {
  process.stdout.write(await pdfToText(fs.readFileSync(file)))
} catch (e) {
  console.error(`✖ ${file}: ${e?.message ?? e}`)
  process.exit(1)
}
