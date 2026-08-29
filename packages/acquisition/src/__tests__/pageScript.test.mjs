// @vitest-environment jsdom
import { describe, it, expect, beforeEach } from 'vitest'
import { RESOLVER_SOURCE } from '../runtime/pageScript.mjs'

/**
 * Electron 殻がページ内へ文字列注入する解決器（issue #174）。
 * jsdom で実際に eval し、window.__kaneanResolve のセレクタ連鎖解決を検証する
 * （外側スコープを参照しない前提＝eval で動くこと自体も契約）。
 */

function resolve(chain) {
  return window.__kaneanResolve(chain)
}

beforeEach(() => {
  document.body.innerHTML = `
    <nav>
      <a href="/meisai">入出金明細</a>
      <a href="/logout" aria-label="ログアウト">出口</a>
    </nav>
    <div class="panel">
      <button>照会</button>
      <span>照会結果はまだありません</span>
    </div>
  `
  delete window.__kaneanResolve
  // 文字列としての注入と同じ経路（外側スコープ非依存の契約を eval で確かめる）
  window.eval(RESOLVER_SOURCE)
})

describe('__kaneanResolve', () => {
  it('css: querySelectorAll の連鎖（document 起点）', () => {
    const els = resolve([{ kind: 'css', selector: 'nav a' }])
    expect(els).toHaveLength(2)
  })

  it('role=link: href 付き a を name 正規表現で絞る（aria-label も名前に使う）', () => {
    const meisai = resolve([{ kind: 'role', role: 'link', name: { source: '入出金明細', flags: '' } }])
    expect(meisai).toHaveLength(1)
    expect(meisai[0].getAttribute('href')).toBe('/meisai')
    const byAria = resolve([{ kind: 'role', role: 'link', name: { source: 'ログアウト', flags: '' } }])
    expect(byAria).toHaveLength(1)
    expect(byAria[0].getAttribute('href')).toBe('/logout')
  })

  it('text: 最も内側の一致だけを返す（親まで拾うと first が壊れる）', () => {
    const els = resolve([{ kind: 'text', text: { source: '照会結果', flags: '' } }])
    expect(els).toHaveLength(1)
    expect(els[0].tagName).toBe('SPAN')
  })

  it('first: 連鎖の先頭1件へ絞る', () => {
    const els = resolve([{ kind: 'css', selector: 'a' }, { kind: 'first' }])
    expect(els).toHaveLength(1)
    expect(els[0].getAttribute('href')).toBe('/meisai')
  })

  it('未知の step は throw（黙って空配列にしない）', () => {
    expect(() => resolve([{ kind: 'xpath' }])).toThrow(/unknown locator step/)
  })

  it('__kaneanSetValue: native setter 経由で input/change を発火する', () => {
    document.body.innerHTML = '<input id="d" type="text">'
    const el = document.getElementById('d')
    const events = []
    el.addEventListener('input', () => events.push('input'))
    el.addEventListener('change', () => events.push('change'))
    window.__kaneanSetValue(el, '2026-01-01')
    expect(el.value).toBe('2026-01-01')
    expect(events).toEqual(['input', 'change'])
  })
})
