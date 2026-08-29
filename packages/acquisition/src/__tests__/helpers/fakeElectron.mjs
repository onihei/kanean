// jsdom を Chromium の代わりに据えた偽 Electron。
//
// これで確かめられるのは「殻の意味論」＝ locator の解決と自動待機、値の入力、遷移の扱い。
// 実ブラウザでしか確かめられないもの（実入力イベント・反自動化・描画）は task 4 で実サイトで見る。
import { JSDOM } from 'jsdom'

class FakeWebContents {
  constructor(win) {
    this.win = win
    this.inputEvents = []
    this._listeners = new Map()
    this._loading = false
  }
  async executeJavaScript(code) {
    return this.win._dom.window.eval(code)
  }
  sendInputEvent(e) {
    this.inputEvents.push(e)
  }
  capturePage() {
    return Promise.resolve({ toPNG: () => Buffer.from('fake-png') })
  }
  getURL() {
    return this.win._url
  }
  isLoading() {
    return this._loading
  }
  on(name, fn) {
    this._listeners.set(name, [...(this._listeners.get(name) ?? []), fn])
  }
  off(name, fn) {
    this._listeners.set(name, (this._listeners.get(name) ?? []).filter((f) => f !== fn))
  }
  emit(name, ...args) {
    for (const fn of this._listeners.get(name) ?? []) fn(...args)
  }
  setWindowOpenHandler(fn) {
    this._openHandler = fn
  }
}

export class FakeBrowserWindow {
  static created = []
  /** URL → HTML の対応（結合テスト用）。{ pattern: string|RegExp, html: string } の先勝ち。 */
  static routes = []
  constructor(options) {
    this.options = options
    this._destroyed = false
    this._url = 'about:blank'
    this._dom = new JSDOM('<html><body></body></html>', { runScripts: 'outside-only' })
    this.webContents = new FakeWebContents(this)
    this._closeListeners = []
    FakeBrowserWindow.created.push(this)
    patchLayout(this._dom.window)
  }
  async loadURL(url) {
    this._url = url
    const hit = FakeBrowserWindow.routes.find((r) =>
      typeof r.pattern === 'string' ? url.includes(r.pattern) : r.pattern.test(url)
    )
    if (hit) this.setHtml(hit.html)
    else if (this._html != null) this.setHtml(this._html)
  }
  /** テストから「このページはこう見えている」を差し込む。 */
  setHtml(html) {
    this._dom = new JSDOM(html, { runScripts: 'outside-only', url: this._url.startsWith('http') ? this._url : undefined })
    patchLayout(this._dom.window)
    this.webContents.win = this
    this._emulateNavigation()
  }
  /**
   * アンカーの遷移意味論（結合テスト用）。jsdom は navigation を実装しないので、
   * `a[href]` クリック → loadURL（routes で HTML が差し替わる）を近似する。
   * `target="_blank"` は実 Chromium と同じく `did-create-window` を発火して別窓を開く。
   */
  _emulateNavigation() {
    this._dom.window.document.addEventListener('click', (e) => {
      const a = e.target && e.target.closest ? e.target.closest('a[href]') : null
      if (!a) return
      const href = a.getAttribute('href')
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) return
      e.preventDefault()
      const url = new URL(href, this._url).toString()
      if (a.target === '_blank') {
        const child = new FakeBrowserWindow({ webPreferences: {} })
        void child.loadURL(url)
        this.webContents.emit('did-create-window', child)
        return
      }
      // クリックの評価が終わってから遷移する（評価中に DOM を差し替えない）
      setTimeout(() => {
        if (!this._destroyed) void this.loadURL(url)
      }, 0)
    })
  }
  isDestroyed() {
    return this._destroyed
  }
  destroy() {
    this._destroyed = true
    for (const fn of this._closeListeners) fn()
  }
  on(name, fn) {
    if (name === 'closed') this._closeListeners.push(fn)
  }
}

/**
 * jsdom はレイアウトを持たないので `getBoundingClientRect` が常に 0 を返す。
 * それでは「見えている」判定が全て偽になり、自動待機の意味論を確かめられない。
 * DOM に居て `display:none` でない要素は見えている、という近似を入れる。
 */
function patchLayout(window) {
  const { Element } = window
  // jsdom 25 は innerText を実装しない（レイアウト依存のため）。sites の page.evaluate 内は
  // `el.innerText || ''` の形で読むので、無いと空文字＝抽出が全滅する。textContent で近似する
  // （改行・可視性の差は残るが、殻の意味論＝「本文が読める」ことの検証には足りる）。
  if (!('innerText' in window.HTMLElement.prototype)) {
    Object.defineProperty(window.HTMLElement.prototype, 'innerText', {
      configurable: true,
      get() {
        return this.textContent
      },
      set(v) {
        this.textContent = v
      },
    })
  }
  Element.prototype.getBoundingClientRect = function () {
    const st = window.getComputedStyle(this)
    const hidden = st.display === 'none' || st.visibility === 'hidden'
    const w = hidden ? 0 : 100
    return { x: 0, y: 0, top: 0, left: 0, width: w, height: hidden ? 0 : 20, right: w, bottom: 20 }
  }
  Element.prototype.getClientRects = function () {
    return [this.getBoundingClientRect()]
  }
  // 呼ばれ方を残す（スムーススクロールを頼んでいないことをテストで見るため。tasks 10.4a）
  Element.prototype.scrollIntoView = function (options) {
    ;(window.__scrollIntoViewCalls ??= []).push(options ?? null)
  }
  window.document.elementFromPoint = () => null // 実入力の当たり判定は実ブラウザでしか出せない
}

export function makeFakeElectron() {
  FakeBrowserWindow.created = []
  FakeBrowserWindow.routes = []
  const sessions = new Map()
  const session = {
    fromPartition(partition) {
      if (!sessions.has(partition)) {
        sessions.set(partition, {
          partition,
          userAgent:
            'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Kanean/0.0.0 Chrome/140.0.0.0 Electron/43.4.0 Safari/537.36',
          cleared: [],
          getUserAgent() {
            return this.userAgent
          },
          setUserAgent(ua) {
            this.userAgent = ua
          },
          async clearStorageData() {
            this.cleared.push('storage')
          },
          async clearCache() {
            this.cleared.push('cache')
          },
          async clearAuthCache() {
            this.cleared.push('auth')
          },
          async fetch(url) {
            return {
              ok: true,
              status: 200,
              url,
              async arrayBuffer() {
                return new TextEncoder().encode('%PDF-1.4').buffer
              },
            }
          },
        })
      }
      return sessions.get(partition)
    },
  }
  return {
    BrowserWindow: FakeBrowserWindow,
    session,
    sessions,
    /** URL（部分一致 or 正規表現）→ HTML を登録する。先に登録したものが勝つ。 */
    route(pattern, html) {
      FakeBrowserWindow.routes.push({ pattern, html })
    },
  }
}
