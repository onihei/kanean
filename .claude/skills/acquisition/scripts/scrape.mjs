#!/usr/bin/env node
// 巡回手順の実体は packages/acquisition/src/sites/<site>.mjs（唯一の実体）。
// ここは CLI（packages/acquisition/bin/scrape.mjs）へサイト名ごと素通しする唯一のラッパ
// （旧 scrape-<site>.mjs ×5 は差分がサイト名1語だけの同文コピーだったため一本化・issue #169）。
// 使い方: node scrape.mjs <site> --since … --until … --out …（site: amazon|rakuten|mufg|shinsei|ufjvisa）
// 終了コード契約（0=OK / 1=失敗 / 2=プロファイル使用中 / 4=部分成功）はそのまま素通しする。
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const here = path.dirname(fileURLToPath(import.meta.url))
const cli = path.resolve(here, '../../../../packages/acquisition/bin/scrape.mjs')
const r = spawnSync(process.execPath, [cli, ...process.argv.slice(2)], { stdio: 'inherit' })
process.exit(r.status ?? 1)
