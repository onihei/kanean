// 巡回の実行手順（殻に依らない）。
// 殻がやるのは「ブラウザ文脈を作る」「証跡・診断の置き場所を渡す」だけで、
// 較正の解決・診断の形・出力の組み立てはここに一本化する（経路が違っても結果が同じ、を保つ）。
import { EXIT, ScrapeError } from './core/errors.mjs'
import { makeRunner } from './core/runner.mjs'
import { mergeSelectors } from './core/selectors.mjs'

/** 証跡を保存しない殻・設定のための既定（何もしない）。 */
export const NO_EVIDENCE = {
  enabled: false,
  async save() {
    return null
  },
  ref(_relPath, fallback) {
    return fallback
  },
}

/**
 * @param {object} p
 * @param {object} p.site      `sites/*.mjs` のモジュール
 * @param {object} p.context   巡回契約を満たすブラウザ文脈
 * @param {{since:string, until:string, loginTimeout?:string}} p.args
 * @param {object|null} [p.selectorsOverride] `$DATA_DIR` 側の上書き較正（無ければ同梱を使う）
 */
export async function runScrape({
  site,
  context,
  args,
  selectorsOverride = null,
  evidence = NO_EVIDENCE,
  sink = null,
  tools = {},
  log = console.log,
  onWaiting,
  isAborted,
}) {
  const { sel, calibration } = mergeSelectors(
    site.SOURCE,
    site.DEFAULT_SEL,
    selectorsOverride,
    site.NAVIGABLE_KEYS
  )
  const run = makeRunner(site.SOURCE, { sink, log })
  const started = new Date().toISOString()

  const payload = await site.scrape({
    context,
    sel,
    args,
    run,
    log,
    evidence,
    tools,
    onWaiting,
    isAborted,
  })

  // 部分成功の判定はサイトの宣言（FAILURE_GRANULARITY）から一元的に行う（issue #171）。
  // 'all' のサイトは検算が崩れた時点で scrape が throw 済み＝ここに failedOrders が来たら契約違反。
  const partial = failurePolicy(site, payload)

  return {
    source: site.SOURCE,
    kind: site.KIND,
    script: site.SCRIPT,
    // どの較正で取ったかを結果に残す（投入した仕訳の policyRef と同じ発想。design D3）
    calibration,
    scrapedAt: started,
    range: { since: args.since, until: args.until },
    ...payload,
    partial,
    exitCode: partial ? EXIT.PARTIAL : EXIT.OK,
  }
}

/** 失敗の粒度の宣言 → partial 判定。宣言と実際の返し方の食い違いは黙認しない。 */
function failurePolicy(site, payload) {
  if (site.FAILURE_GRANULARITY === 'order') return (payload.failedOrders?.length ?? 0) > 0
  if (payload.failedOrders?.length) {
    throw new ScrapeError(
      'run',
      `${site.SOURCE} は FAILURE_GRANULARITY='all'（部分成功なし）なのに failedOrders を返した`,
      'サイトの宣言か返し方のどちらかが誤り。sites/*.mjs を確認する'
    )
  }
  return false
}
