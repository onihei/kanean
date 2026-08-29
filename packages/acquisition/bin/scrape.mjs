#!/usr/bin/env node
// 巡回 CLI（実行殻A: Playwright）。Claude Code の acquisition スキルはこれを叩く。
//
//   node bin/scrape.mjs ufjvisa --since 2026-01-01 --until 2026-06-13 --out /tmp/acq-card.json [--evidence]
//
// 終了コード契約: 0=OK / 1=失敗 / 2=プロファイル使用中 / 4=部分成功（SKILL.md と一致）。
// 失敗時は .kanean/acquisition/fail/<source>/latest/ に error.json + page.html + screenshot.png。
import path from 'node:path'
import { parseArgs, SCRAPE_ARG_SPEC } from '../src/core/args.mjs'
import { EXIT, ScrapeError } from '../src/core/errors.mjs'
import { readOverride } from '../src/core/calibrationStore.mjs'
import { getSite, SOURCES, ALIASES } from '../src/sites/index.mjs'
import { runScrape } from '../src/run.mjs'
import {
  ROOT,
  launchBrowser,
  adaptContext,
  fileFailureSink,
  fileEvidenceStore,
  writeOutput,
  tools,
} from '../src/runtime/playwright.mjs'

const [, , siteName, ...rest] = process.argv

function usage() {
  console.error('使い方: scrape.mjs <site> --since YYYY-MM-DD --until YYYY-MM-DD --out FILE [--evidence]')
  console.error(`  site: ${Object.keys(ALIASES).join(' | ')}`)
  console.error(`  （source 名でも可: ${SOURCES.join(' | ')}）`)
}

const site = siteName ? getSite(siteName) : null
if (!site) {
  usage()
  process.exit(EXIT.FAIL)
}

const args = (() => {
  try {
    return parseArgs(['node', 'scrape', ...rest], SCRAPE_ARG_SPEC)
  } catch (e) {
    console.error(`✖ ${e.message}`)
    usage()
    process.exit(EXIT.FAIL)
  }
})()

const dataDir = process.env.DATA_DIR?.trim() || path.join(ROOT, 'data')

let context = null
try {
  const override = readOverride(dataDir, site.SOURCE)
  if (override) console.log(`※ 上書き較正を使用: ${dataDir}/acquisition/selectors/${site.SOURCE}.json`)

  const pwContext = await launchBrowser()
  context = pwContext
  const result = await runScrape({
    site,
    context: adaptContext(pwContext),
    args,
    selectorsOverride: override,
    evidence: fileEvidenceStore(site.EVIDENCE_KEY, args.evidence),
    sink: fileFailureSink(site.SOURCE),
    tools,
  })

  const { exitCode, ...output } = result
  writeOutput(args.out, output)
  console.log(`→ ${args.out}`)
  if (output.warnings?.length) console.log(`⚠ ${output.warnings.join(' / ')}`)
  await context.close().catch(() => {})
  process.exit(exitCode)
} catch (e) {
  await context?.close().catch(() => {})
  if (!e?.dumped)
    console.error(`✖ ${site.SOURCE}: ${e instanceof ScrapeError ? e.message : (e?.stack ?? e)}`)
  process.exit(e?.exitCode ?? EXIT.FAIL)
}
