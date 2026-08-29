// 巡回契約（core/page.mjs の BROWSER_API）だけを備えた偽ブラウザ。
//
// 目的は2つ。
//   1. サイトスクリプトが**契約の外へ手を伸ばしていない**ことを機械で確かめる
//      （契約外のプロパティに触れた瞬間 ContractViolation を投げる）
//   2. Electron 殻を実装するとき、「これだけ実装すればよい」の基準になる
import { BROWSER_API } from '../../core/page.mjs'

export class ContractViolation extends Error {
  constructor(kind, prop) {
    super(`契約外の API: ${kind}.${String(prop)}`)
    this.name = 'ContractViolation'
  }
}

function strict(kind, impl, seen) {
  const allowed = new Set(BROWSER_API[kind])
  return new Proxy(impl, {
    get(target, prop) {
      if (typeof prop === 'symbol' || prop === 'then' || prop === 'constructor') return undefined
      if (!allowed.has(prop)) throw new ContractViolation(kind, prop)
      seen.add(`${kind}.${prop}`)
      return target[prop]
    },
  })
}

/**
 * @param {object} [opts]
 * @param {(fn: Function, arg: unknown) => unknown} [opts.evaluate] ページ内評価の戻り値
 * @param {string} [opts.innerText] `locator.innerText()` の戻り値
 * @param {number} [opts.count]     `locator.count()` の戻り値
 * @param {string} [opts.url]
 */
export function makeFakeBrowser(opts = {}) {
  const seen = new Set()
  const calls = []
  const record = (name, args) => calls.push({ name, args })

  const makeLocator = (desc) => {
    const impl = {
      first: () => makeLocator(desc + '.first'),
      locator: (s) => makeLocator(`${desc} ${s}`),
      getByRole: (r, o) => makeLocator(`${desc} role=${r} ${o?.name ?? ''}`),
      getByText: (t) => makeLocator(`${desc} text=${t}`),
      click: async (o) => record('click', [desc, o]),
      count: async () => opts.count ?? 0,
      innerText: async () => opts.innerText ?? '',
      isVisible: async () => opts.visible ?? false,
      fill: async (v) => record('fill', [desc, v]),
      selectOption: async (v) => record('selectOption', [desc, v]),
      press: async (k) => record('press', [desc, k]),
      pressSequentially: async (v) => record('pressSequentially', [desc, v]),
      dispatchEvent: async (e) => record('dispatchEvent', [desc, e]),
    }
    return strict('locator', impl, seen)
  }

  const page = strict(
    'page',
    {
      goto: async (u) => record('goto', [u]),
      evaluate: async (fn, arg) => (opts.evaluate ? opts.evaluate(fn, arg) : []),
      locator: (s) => makeLocator(s),
      getByRole: (r, o) => makeLocator(`role=${r} ${o?.name ?? ''}`),
      getByText: (t) => makeLocator(`text=${t}`),
      screenshot: async () => Buffer.from('fake-png'),
      waitForTimeout: async () => {},
      waitForLoadState: async () => {},
      url: () => opts.url ?? 'https://example.test/',
      content: async () => opts.html ?? '<html></html>',
      context: () => context,
    },
    seen
  )

  const context = strict(
    'context',
    {
      pages: () => [page],
      newPage: async () => page,
      waitForEvent: async () => null,
      close: async () => {},
      fetchBinary: async () => ({ ok: false, status: 404, body: Buffer.alloc(0) }),
    },
    seen
  )

  return { context, page, seen, calls }
}

/** 巡回中の副作用（証跡・診断）を捨てる殻。 */
export const nullEvidence = {
  enabled: false,
  async save() {
    return null
  },
  ref(_relPath, fallback) {
    return fallback
  },
}

export const nullTools = {
  pdfToText: () => '',
}
