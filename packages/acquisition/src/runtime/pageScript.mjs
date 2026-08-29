// Electron 殻がページ内で実行する解決器。**文字列として注入する**ので、外側のスコープを参照しないこと。
//
// Playwright の locator は「セレクタの連鎖」＋「見つかるまで待つ」で成り立っている。
// 前半（連鎖の解決）をこのページ内スクリプトが、後半（待つ）を殻のポーリングが担う（design D2）。

/**
 * ページ内に定義する関数の本体。`window.__kaneanResolve(chain)` で要素配列を返す。
 * chain の要素:
 *   { kind: 'css',  selector }
 *   { kind: 'role', role, name?: {source, flags} }
 *   { kind: 'text', text: {source, flags} }
 *   { kind: 'first' }
 */
export const RESOLVER_SOURCE = `
(function () {
  if (window.__kaneanResolve) return
  const ROLE_SELECTOR = {
    link: 'a[href], [role="link"]',
    button: 'button, input[type="button"], input[type="submit"], input[type="reset"], [role="button"]',
  }
  const textOf = (el) => (el.innerText || el.textContent || '').replace(/\\s+/g, ' ').trim()
  const nameOf = (el) =>
    (el.getAttribute('aria-label') || el.getAttribute('title') || textOf(el) || el.value || '').trim()
  const toRe = (r) => (r ? new RegExp(r.source, r.flags) : null)

  function step(scope, s) {
    if (s.kind === 'css') {
      const out = []
      for (const root of scope) for (const el of root.querySelectorAll(s.selector)) out.push(el)
      return [...new Set(out)]
    }
    if (s.kind === 'role') {
      const sel = ROLE_SELECTOR[s.role] || '[role="' + s.role + '"]'
      const re = toRe(s.name)
      const out = []
      for (const root of scope)
        for (const el of root.querySelectorAll(sel)) if (!re || re.test(nameOf(el))) out.push(el)
      return [...new Set(out)]
    }
    if (s.kind === 'text') {
      const re = toRe(s.text)
      const hits = []
      for (const root of scope)
        for (const el of root.querySelectorAll('*')) if (re.test(textOf(el))) hits.push(el)
      const set = new Set(hits)
      // Playwright と同じく「最も内側の一致」を採る（親まで全部拾うと first() が壊れる）
      return [...set].filter((el) => ![...el.querySelectorAll('*')].some((c) => set.has(c)))
    }
    if (s.kind === 'first') return scope.slice(0, 1)
    throw new Error('unknown locator step: ' + s.kind)
  }

  window.__kaneanResolve = function (chain) {
    let scope = [document]
    for (const s of chain) scope = step(scope, s)
    return scope.filter((el) => el !== document)
  }

  window.__kaneanVisible = function (el) {
    if (!el || !el.getClientRects) return false
    const r = el.getBoundingClientRect()
    if (!r.width && !r.height) return false
    const st = window.getComputedStyle(el)
    return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0'
  }

  // React/Angular は value の setter を差し替えているので、native setter で書いてから input/change を出す
  window.__kaneanSetValue = function (el, value) {
    const proto = el instanceof window.HTMLTextAreaElement
      ? window.HTMLTextAreaElement.prototype
      : el instanceof window.HTMLSelectElement
        ? window.HTMLSelectElement.prototype
        : window.HTMLInputElement.prototype
    const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set
    if (setter) setter.call(el, value)
    else el.value = value
    el.dispatchEvent(new Event('input', { bubbles: true }))
    el.dispatchEvent(new Event('change', { bubbles: true }))
  }
})()
`

/** ページ内で `chain` を解決し、`index` 番目の要素に対して `op` を行う式を組み立てる。 */
export function callInPage(chain, body) {
  return `${RESOLVER_SOURCE};(function(){
    const els = window.__kaneanResolve(${JSON.stringify(chain)});
    ${body}
  })()`
}
