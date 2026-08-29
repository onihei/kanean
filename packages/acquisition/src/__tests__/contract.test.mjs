// サイトスクリプトが**巡回契約の外へ手を伸ばしていない**ことを確かめる（tasks 1.2）。
// これが通る限り、殻を差し替えても巡回手順を書き直さずに済む。
import { describe, it, expect } from 'vitest'
import { SITES } from '../sites/index.mjs'
import { runScrape } from '../run.mjs'
import { ScrapeError } from '../core/errors.mjs'
import { BROWSER_API } from '../core/page.mjs'
import { makeFakeBrowser, nullEvidence, nullTools, ContractViolation } from './helpers/fakeBrowser.mjs'

const args = { since: '2026-01-01', until: '2026-06-30', loginTimeout: '1' }

// ログイン済みに見えるページテキスト（各サイトの isLoggedIn を満たす最小の集合）
const LOGGED_IN_TEXT = 'ログアウト 購入履歴 注文履歴'

describe.each(Object.entries(SITES))('%s', (source, site) => {
  it('契約外の API を使わない', async () => {
    const { context, seen } = makeFakeBrowser({ innerText: LOGGED_IN_TEXT })
    let thrown = null
    try {
      await runScrape({
        site,
        context,
        args,
        evidence: nullEvidence,
        tools: nullTools,
        log: () => {},
      })
    } catch (e) {
      thrown = e
    }
    // 偽ブラウザでは当然どこかで詰まるが、それは「契約外の API」であってはならない
    expect(thrown, `${source}: ${thrown?.message}`).not.toBeInstanceOf(ContractViolation)
    if (thrown) expect(thrown).toBeInstanceOf(ScrapeError)
    // 触れた API は全て契約の中にある
    for (const name of seen) {
      const [kind, prop] = name.split('.')
      expect(BROWSER_API[kind], name).toContain(prop)
    }
  })

  it('取得結果に、どの較正で取ったかが載る', async () => {
    const { context } = makeFakeBrowser({ innerText: LOGGED_IN_TEXT })
    const promise = runScrape({
      site,
      context,
      args,
      evidence: nullEvidence,
      tools: nullTools,
      log: () => {},
    }).catch((e) => e)
    const r = await promise
    // 成功しても失敗しても、較正の解決自体は巡回の前に済んでいる
    if (!(r instanceof Error)) {
      expect(r.calibration.source).toBe(source)
      expect(r.calibration.origin).toBe('bundled')
      expect(r.script).toBe(site.SCRIPT)
    }
  })

  it('site モジュールが必要な口を全て備える', () => {
    expect(typeof site.SOURCE).toBe('string')
    expect(['bank', 'card', 'ec']).toContain(site.KIND)
    expect(typeof site.SCRIPT).toBe('string')
    expect(typeof site.scrape).toBe('function')
    expect(site.DEFAULT_SEL).toBeTypeOf('object')
    // 失敗の粒度は宣言必須（issue #171）: 銀行・カード=全件必須 / EC=注文単位。
    expect(['all', 'order']).toContain(site.FAILURE_GRANULARITY)
    expect(site.FAILURE_GRANULARITY).toBe(site.KIND === 'ec' ? 'order' : 'all')
  })
})

describe('登録簿', () => {
  it('5サイトが揃っている', () => {
    expect(Object.keys(SITES).sort()).toEqual(
      ['amazon', 'bank_shinsei', 'bank_ufj', 'card_mufg_visa', 'rakuten'].sort()
    )
  })

  it('契約は14種の page/locator API に収まっている', () => {
    // 「共通 API は14種しかない」という設計の前提を、増えたら気づける形で置いておく
    expect(BROWSER_API.page.length).toBeLessThanOrEqual(14)
    expect(BROWSER_API.locator.length).toBeLessThanOrEqual(14)
  })
})
