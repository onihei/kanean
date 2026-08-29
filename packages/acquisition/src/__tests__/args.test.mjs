import { describe, it, expect } from 'vitest'
import { parseArgs, SCRAPE_ARG_SPEC } from '../core/args.mjs'
import { ScrapeError } from '../core/errors.mjs'

/** CLI 引数の解釈（issue #174 のテスト空白充足）。 */

const argv = (...rest) => ['node', 'scrape.mjs', ...rest]

describe('parseArgs', () => {
  it('required/optional/flag を解釈し、kebab-case は camelCase へ', () => {
    const args = parseArgs(
      argv('--since', '2026-01-01', '--until', '2026-06-30', '--out', '/tmp/x.json', '--evidence', '--login-timeout', '60'),
      SCRAPE_ARG_SPEC,
    )
    expect(args).toEqual({ since: '2026-01-01', until: '2026-06-30', out: '/tmp/x.json', evidence: true, loginTimeout: '60' })
  })

  it('flag は省略で false（未定義のまま残さない）', () => {
    const args = parseArgs(argv('--since', 'a', '--until', 'b', '--out', 'c'), SCRAPE_ARG_SPEC)
    expect(args.evidence).toBe(false)
    expect('loginTimeout' in args).toBe(false)
  })

  it('required の欠落・未知のオプション・`--` 無しの引数は ScrapeError', () => {
    expect(() => parseArgs(argv('--since', 'a'), SCRAPE_ARG_SPEC)).toThrow(ScrapeError)
    expect(() => parseArgs(argv('--since', 'a'), SCRAPE_ARG_SPEC)).toThrow(/--until は必須/)
    expect(() => parseArgs(argv('--nope', 'x'), SCRAPE_ARG_SPEC)).toThrow(/不明なオプション/)
    expect(() => parseArgs(argv('positional'), SCRAPE_ARG_SPEC)).toThrow(/不明な引数/)
  })
})
