#!/usr/bin/env node
// 巡回結果の突き合わせ（tasks 4.3 / 10.4）。実行殻A（Playwright）と実行殻B（Electron）が
// 同じ明細を返すことを確かめるための道具で、取込そのものには関わらない。
//
//   # 殻A: スキル経路の CLI が --out に書く
//   node packages/acquisition/bin/scrape.mjs ufjvisa --since 2026-01-01 --until 2026-06-30 \
//     --out /tmp/acq/pw-card_mufg_visa.json
//
//   # 殻B: アプリを KANEAN_ACQ_DUMP 付きで起動して UI から取込むと同じ形が落ちる
//   KANEAN_ACQ_DUMP=/tmp/acq/el pnpm dev:app
//
//   node packages/acquisition/bin/acq-diff.mjs \
//     /tmp/acq/pw-card_mufg_visa.json /tmp/acq/el/card_mufg_visa.json
//
// 終了コード: 0=一致 / 1=差あり・読めない / 2=前提（較正・範囲）が食い違っていて比較が成立しない。
import fs from 'node:fs'
import { diffResults } from '../src/core/compare.mjs'

const [, , leftPath, rightPath, ...rest] = process.argv
const max = (() => {
  const i = rest.indexOf('--max')
  const n = i === -1 ? NaN : Number(rest[i + 1])
  return Number.isFinite(n) && n > 0 ? n : 30
})()

if (!leftPath || !rightPath) {
  console.error('使い方: acq-diff.mjs <殻Aの出力.json> <殻Bの出力.json> [--max N]')
  process.exit(1)
}

function load(p) {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'))
  } catch (e) {
    console.error(`✖ 読めません: ${p}（${e.message}）`)
    process.exit(1)
  }
}

const { identical, context, differences } = diffResults(load(leftPath), load(rightPath))

function report(title, items) {
  console.log(`\n${title}（${items.length}件）`)
  for (const d of items.slice(0, max)) console.log(`  ${d.path}\n    A: ${d.a}\n    B: ${d.b}`)
  if (items.length > max) console.log(`  … 他 ${items.length - max} 件（--max で増やせる）`)
}

console.log(`A: ${leftPath}\nB: ${rightPath}`)

if (identical) {
  console.log('\n✔ 一致（scrapedAt と証跡パスの土台を除く）')
  process.exit(0)
}

if (context.length) {
  report('⚠ 前提の食い違い', context)
  console.log('\n※ 較正・範囲・スクリプト版が違うと、明細の差は殻の差とは言えません。')
}
if (differences.length) report('✖ 明細の差', differences)

process.exit(context.length && !differences.length ? 2 : 1)
