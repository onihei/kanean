import { ScrapeError } from './errors.mjs'

// spec: { since: 'required', until: 'required', out: 'required', evidence: 'flag', ... }
export function parseArgs(argv, spec) {
  const args = {}
  const list = argv.slice(2)
  for (let i = 0; i < list.length; i++) {
    const m = /^--([a-z-]+)$/.exec(list[i])
    if (!m) throw new ScrapeError('args', `不明な引数: ${list[i]}`)
    const key = m[1].replace(/-([a-z])/g, (_, c) => c.toUpperCase())
    if (!(key in spec)) throw new ScrapeError('args', `不明なオプション: --${m[1]}`)
    if (spec[key] === 'flag') args[key] = true
    else args[key] = list[++i]
  }
  for (const [key, kind] of Object.entries(spec)) {
    if (kind === 'required' && !args[key]) throw new ScrapeError('args', `--${key} は必須`)
    if (kind === 'flag' && !(key in args)) args[key] = false
  }
  return args
}

/** サイトスクリプトが受け取る引数の形（殻によらず同一）。 */
export const SCRAPE_ARG_SPEC = {
  since: 'required',
  until: 'required',
  out: 'required',
  evidence: 'flag',
  loginTimeout: 'optional',
}
