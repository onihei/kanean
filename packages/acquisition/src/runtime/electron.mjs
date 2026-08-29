// 実行殻B: Electron（アプリ内巡回）。
//
// Chromium はアプリが既に持っているので、Chrome の導入も Playwright の同梱も要らない。
// この殻がやることは3つだけ。
//   1. **人が見える**巡回ウィンドウを、アプリ内 API に到達できない区画で開く（acquisition spec）
//   2. Playwright の locator の意味論（見つかるまで待つ）をポーリングで再現する（design D2）
//   3. ログイン状態を `userData` 側の区画に置き、会計データ（`$DATA_DIR`）と分ける（design D7）
//
// `electron` は**引数で受け取る**。素の Node（テスト）から読み込めるようにするため。
import { ScrapeError } from '../core/errors.mjs'
import { POPUP_TIMEOUT_MS } from '../core/page.mjs'
import { callInPage, RESOLVER_SOURCE } from './pageScript.mjs'

/** 巡回セッションの置き場所。会計データとは別（`userData/Partitions/kanean-acquisition`）。 */
export const ACQUISITION_PARTITION = 'persist:kanean-acquisition'

/** 自動待機の既定。Playwright の locator と同じく「見つかる/操作できるまで待つ」ための上限。 */
export const DEFAULT_ACTION_TIMEOUT_MS = 15_000
const POLL_MS = 100
/** CDP の指定が返ってこないとき（遷移前は解決しない）に待ちを打ち切るまで。 */
const CDP_SEND_TIMEOUT_MS = 1500

/**
 * Electron/Chromium 由来のトークンを落とし、ふつうの Chrome に見える UA を作る（tasks 3.7）。
 * 反自動化に「自動化ツールだから」という理由で弾かれる余地を減らすのが目的で、
 * 素性を偽って別人に成り済ますものではない（自分のデータを自分で取りに行く前提）。
 */
export function normalizeUserAgent(rawUserAgent) {
  return String(rawUserAgent)
    .replace(/\s*Electron\/[^\s]+/g, '')
    .replace(/\s*Kanean\/[^\s]+/gi, '')
    .replace(/\s{2,}/g, ' ')
    .trim()
}

/**
 * Client Hints を UA 文字列に合わせる（tasks 10.4a / electron#34762・#30201）。
 *
 * Electron は `setUserAgent()` で **UA 文字列しか変えず**、User-Agent Client Hints の
 * メタデータを更新しない。さらに高エントロピーのヒント（`sec-ch-ua-full-version-list` 等）は
 * サーバが `Accept-CH` で要求しても**一切返さない**（2022年から open のバグ）。結果:
 *
 *   UA 文字列 … `Chrome/150` と名乗る（3.7 の正規化）
 *   brands   … `Google Chrome` が無い＝「Chrome ではない Chromium」
 *
 * という**不整合**が残る。機微な内容を出し渋るサイトがあり、Amazon の適格請求書リンクが
 * Electron 殻でだけ出てこない件の有力な原因（殻A の実 Chrome では 22/22）。
 *
 * ここでやるのは **アプリが既に名乗っている UA と辻褄を合わせる**ことだけ。新たに素性を
 * 偽るのではなく、Electron のバグで答えられていない標準の問い合わせに答えられるようにする。
 *
 * `debugger` はメインプロセス側の口で、ページからは触れない（窓の隔離は変わらない）。
 * 失敗しても巡回は続ける（ヒントが揃わないだけで、取得そのものは動く）。
 */
export async function applyClientHints(win, userAgent) {
  const major = /Chrome\/(\d+)/.exec(userAgent)?.[1]
  const full = /Chrome\/([\d.]+)/.exec(userAgent)?.[1]
  if (!major) return false

  const wc = win.webContents
  try {
    wc.debugger.attach('1.3')
  } catch {
    return false // 既に attach 済み（devtools 等）。巡回は続行する
  }

  // GREASE ブランドはこの Chromium が自然に出す値をそのまま使い、**足りない
  // `Google Chrome` だけを足す**（作り込みを最小にする）。
  const brands = [
    { brand: 'Not;A=Brand', version: '8' },
    { brand: 'Chromium', version: major },
    { brand: 'Google Chrome', version: major },
  ]
  const metadata = {
    brands,
    fullVersionList: brands.map((b) => ({ brand: b.brand, version: full ?? b.version })),
    fullVersion: full ?? major,
    platform: 'macOS',
    platformVersion:
      typeof process.getSystemVersion === 'function' ? process.getSystemVersion() : '',
    architecture: process.arch === 'arm64' ? 'arm' : 'x86',
    bitness: '64',
    model: '',
    mobile: false,
    wow64: false,
  }

  // ⚠ **遷移前のウィンドウでは `sendCommand` が解決しない**（実測: 15 秒待っても返らない）。
  //   レンダラがまだ無いため。ただし**指定自体は効く**（この直後に開いたページの
  //   `navigator.userAgentData.brands` に `Google Chrome` が入ることを確認済み）。
  //   解決を待ち続けると巡回が止まるので、待ちを打ち切って先へ進む。
  //   `userAgent` を空にすると "Empty userAgent invalid with userAgentMetadata provided" で落ちる。
  try {
    await Promise.race([
      wc.debugger.sendCommand('Emulation.setUserAgentOverride', {
        userAgent,
        userAgentMetadata: metadata,
      }),
      new Promise((resolve) => setTimeout(resolve, CDP_SEND_TIMEOUT_MS)),
    ])
    return true
  } catch {
    return false // ヒントが揃わなくても巡回自体は動く
  }
}

class ElectronLocator {
  constructor(page, chain) {
    this.page = page
    this.chain = chain
  }

  locator(selector) {
    return new ElectronLocator(this.page, [...this.chain, { kind: 'css', selector }])
  }
  getByRole(role, opts) {
    return new ElectronLocator(this.page, [
      ...this.chain,
      { kind: 'role', role, name: serializeMatcher(opts?.name) },
    ])
  }
  getByText(text) {
    return new ElectronLocator(this.page, [...this.chain, { kind: 'text', text: serializeMatcher(text) }])
  }
  first() {
    return new ElectronLocator(this.page, [...this.chain, { kind: 'first' }])
  }

  /** Playwright の count() と同じく**待たない**（0 件も正当な答え）。 */
  async count() {
    return await this.page._eval(callInPage(this.chain, 'return els.length'))
  }

  /** Playwright の isVisible() と同じく**待たない**。 */
  async isVisible() {
    return await this.page._eval(
      callInPage(this.chain, 'return els.length ? window.__kaneanVisible(els[0]) : false')
    )
  }

  async innerText() {
    await this._waitFor('present')
    return await this.page._eval(
      callInPage(this.chain, "return (els[0].innerText || els[0].textContent || '')")
    )
  }

  async click({ timeout = DEFAULT_ACTION_TIMEOUT_MS } = {}) {
    await this._waitFor('visible', timeout)
    // 人と同じ経路（実入力イベント）で押す。座標が取れない場合だけページ内 click に落とす。
    //
    // ⚠ **スクロールと座標の取得は分ける**（tasks 10.4a）。`scrollIntoView` の既定
    //   `behavior:'auto'` はページの CSS `scroll-behavior: smooth` に従うため、同じ評価の中で
    //   `getBoundingClientRect()` を読むと**スクロール前の座標**が返りうる。座標がずれると
    //   ヒット判定が外れて信頼できない `click()` に落ちるか、運悪く通ると**別の場所を実クリック**する。
    //   `behavior:'instant'` を明示し、評価を分けて次のレイアウト後に測り直す。
    await this.page._eval(
      callInPage(
        this.chain,
        `els[0].scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' })
         return true`
      )
    )
    const box = await this.page._eval(
      callInPage(
        this.chain,
        `const el = els[0]
         const r = el.getBoundingClientRect()
         const cx = Math.round(r.left + r.width / 2)
         const cy = Math.round(r.top + r.height / 2)
         if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) return null
         const hit = document.elementFromPoint(cx, cy)
         return { x: cx, y: cy, hit: !!hit && (hit === el || el.contains(hit)) }`
      )
    )
    if (box?.hit) {
      await this.page._sendMouseClick(box.x, box.y)
      return
    }
    await this.page._eval(callInPage(this.chain, 'els[0].click()'))
  }

  async fill(value) {
    await this._waitFor('visible')
    await this.page._eval(
      callInPage(
        this.chain,
        `els[0].focus(); window.__kaneanSetValue(els[0], ${JSON.stringify(String(value))})`
      )
    )
  }

  async selectOption(value) {
    await this._waitFor('present')
    const ok = await this.page._eval(
      callInPage(
        this.chain,
        `const el = els[0]
         const v = ${JSON.stringify(String(value))}
         const opt = Array.from(el.options || []).find((o) => o.value === v || o.text === v)
         if (!opt) return false
         window.__kaneanSetValue(el, opt.value)
         return true`
      )
    )
    if (!ok) throw new ScrapeError('selectOption', `選択肢が見つからない: ${value}`)
  }

  async press(key) {
    await this._waitFor('visible')
    await this.page._eval(callInPage(this.chain, 'els[0].focus()'))
    await this.page._sendKey(key)
  }

  async pressSequentially(value, { delay = 0 } = {}) {
    await this._waitFor('visible')
    await this.page._eval(callInPage(this.chain, 'els[0].focus()'))
    for (const ch of String(value)) {
      await this.page._sendKey(ch)
      if (delay) await this.page.waitForTimeout(delay)
    }
  }

  async dispatchEvent(type) {
    await this._waitFor('present')
    await this.page._eval(
      callInPage(
        this.chain,
        `els[0].dispatchEvent(new MouseEvent(${JSON.stringify(String(type))}, { bubbles: true, cancelable: true }))`
      )
    )
  }

  /** locator の要「見つかる／操作できるまで待つ」。尽きたら診断の材料になる形で失敗させる。 */
  async _waitFor(state, timeout = DEFAULT_ACTION_TIMEOUT_MS) {
    const deadline = Date.now() + timeout
    let last = 0
    for (;;) {
      const r = await this.page._eval(
        callInPage(
          this.chain,
          `if (!els.length) return { n: 0 }
           return { n: els.length, visible: window.__kaneanVisible(els[0]) }`
        )
      )
      last = r.n
      if (r.n > 0 && (state === 'present' || r.visible)) return
      if (Date.now() >= deadline) {
        throw new ScrapeError(
          'locator',
          `要素を待てませんでした（${describeChain(this.chain)}・${state}・${timeout}ms）: 一致 ${last} 件`,
          '較正（セレクタ・ラベル）が実画面と合っているかを確認する'
        )
      }
      await this.page.waitForTimeout(POLL_MS)
    }
  }
}

function serializeMatcher(m) {
  if (m == null) return null
  if (m instanceof RegExp) return { source: m.source, flags: m.flags }
  // 文字列は Playwright の getByText と同じく部分一致で扱う
  return { source: escapeRe(String(m)), flags: '' }
}

function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

function describeChain(chain) {
  return chain
    .map((s) =>
      s.kind === 'css'
        ? s.selector
        : s.kind === 'role'
          ? `role=${s.role}${s.name ? `[${s.name.source}]` : ''}`
          : s.kind === 'text'
            ? `text=${s.text.source}`
            : 'first'
    )
    .join(' » ')
}

class ElectronPage {
  constructor(win, ctx) {
    this.win = win
    this._ctx = ctx
  }

  get _wc() {
    if (this.win.isDestroyed()) throw new ScrapeError('window', '巡回ウィンドウが閉じられました')
    return this.win.webContents
  }

  async _eval(code) {
    return await this._wc.executeJavaScript(code, true)
  }

  async _sendMouseClick(x, y) {
    const wc = this._wc
    wc.sendInputEvent({ type: 'mouseMove', x, y })
    wc.sendInputEvent({ type: 'mouseDown', x, y, button: 'left', clickCount: 1 })
    wc.sendInputEvent({ type: 'mouseUp', x, y, button: 'left', clickCount: 1 })
    await this.waitForTimeout(60)
  }

  async _sendKey(key) {
    const wc = this._wc
    wc.sendInputEvent({ type: 'keyDown', keyCode: key })
    if (key.length === 1) wc.sendInputEvent({ type: 'char', keyCode: key })
    wc.sendInputEvent({ type: 'keyUp', keyCode: key })
    await this.waitForTimeout(10)
  }

  async goto(url) {
    try {
      await this.win.loadURL(url)
    } catch (e) {
      // リダイレクトや遷移の打ち切りは Playwright でも成功扱い。それ以外は診断に載せる
      const code = String(e?.code ?? e?.message ?? '')
      if (!/ERR_ABORTED/.test(code)) throw new ScrapeError('goto', `遷移に失敗: ${url}（${code}）`)
    }
    await this._eval(RESOLVER_SOURCE)
  }

  async evaluate(fn, arg) {
    const code = `${RESOLVER_SOURCE};(${fn.toString()})(${JSON.stringify(arg ?? null)})`
    return await this._eval(code)
  }

  locator(selector) {
    return new ElectronLocator(this, [{ kind: 'css', selector }])
  }
  getByRole(role, opts) {
    return new ElectronLocator(this, [{ kind: 'role', role, name: serializeMatcher(opts?.name) }])
  }
  getByText(text) {
    return new ElectronLocator(this, [{ kind: 'text', text: serializeMatcher(text) }])
  }

  /**
   * ページ全体ではなく**表示領域**の画像になる（Chromium の capturePage の制約）。
   * 診断・証跡としては「そのとき人に見えていたもの」で足りるので、この差は受け入れる。
   */
  async screenshot() {
    const image = await this._wc.capturePage()
    return image.toPNG()
  }

  async waitForTimeout(ms) {
    await new Promise((r) => setTimeout(r, ms))
  }

  async waitForLoadState() {
    if (!this._wc.isLoading()) return
    await new Promise((resolve) => {
      const wc = this._wc
      const done = () => {
        wc.off('did-stop-loading', done)
        resolve()
      }
      wc.on('did-stop-loading', done)
    })
  }

  url() {
    return this.win.isDestroyed() ? '' : this.win.webContents.getURL()
  }

  async content() {
    return await this._eval('document.documentElement.outerHTML')
  }

  context() {
    return this._ctx
  }
}

/**
 * 巡回用のブラウザ文脈を作る。
 * @param {object} p
 * @param {object} p.electron `{ BrowserWindow, session }`（テストでは差し替える）
 * @param {string} [p.partition] 永続セッション区画
 * @param {(win: object) => void} [p.onWindow] 開いたウィンドウを外から扱いたいとき
 */
export function createElectronContext({
  electron,
  partition = ACQUISITION_PARTITION,
  onWindow,
  windowOptions = {},
} = {}) {
  const { BrowserWindow, session } = electron
  const ses = session.fromPartition(partition)
  // Electron であることを隠さないと反自動化に引っかかる余地がある（tasks 3.7）
  ses.setUserAgent(normalizeUserAgent(ses.getUserAgent()))

  const pages = []
  const pageWaiters = []
  let closed = false

  function newWindow() {
    const win = new BrowserWindow({
      width: 1440,
      height: 1024,
      show: true, // **人が見える**こと自体が仕様（acquisition spec）
      title: 'Kanean — 取込（このウィンドウでログインしてください）',
      ...windowOptions,
      webPreferences: {
        // 外部サイトを開く窓なので、アプリ内 API へ到達しうる要素を一切与えない。
        // 既定セッションを使わない＝`kanean://` のハンドラもこの窓からは見えない。
        partition,
        nodeIntegration: false,
        contextIsolation: true,
        sandbox: true,
        webSecurity: true,
        // preload を渡さない（アプリの機能をページへ露出しない）
      },
    })
    const page = new ElectronPage(win, context)
    pages.push(page)
    onWindow?.(win)

    // target=_blank（別タブ遷移するサイトがある）。同じ区画・同じ制約で開く。
    win.webContents.setWindowOpenHandler(() => ({
      action: 'allow',
      overrideBrowserWindowOptions: {
        width: 1440,
        height: 1024,
        webPreferences: { partition, nodeIntegration: false, contextIsolation: true, sandbox: true },
      },
    }))
    win.webContents.on('did-create-window', (childWin) => {
      const child = new ElectronPage(childWin, context)
      pages.push(child)
      // 別タブも同じ素性で開く（親と食い違うと、そこだけ弾かれうる）
      void applyClientHints(childWin, ses.getUserAgent()).catch(() => {})
      onWindow?.(childWin)
      while (pageWaiters.length) pageWaiters.shift().resolve(child)
    })
    win.on('closed', () => {
      const i = pages.indexOf(page)
      if (i >= 0) pages.splice(i, 1)
    })
    return page
  }

  const context = {
    pages: () => pages.slice(),
    async newPage() {
      const page = newWindow()
      // **遷移の前に**揃える（最初の要求からヒントを載せるため）
      await applyClientHints(page.win, ses.getUserAgent())
      return page
    },
    /** 別タブが開くのを待つ（開かなければ null＝同一タブ遷移だった、という扱い）。 */
    async waitForEvent(event, { timeout = POPUP_TIMEOUT_MS } = {}) {
      if (event !== 'page') throw new ScrapeError('waitForEvent', `未対応のイベント: ${event}`)
      return await new Promise((resolve) => {
        const waiter = { resolve }
        pageWaiters.push(waiter)
        setTimeout(() => {
          const i = pageWaiters.indexOf(waiter)
          if (i >= 0) {
            pageWaiters.splice(i, 1)
            resolve(null)
          }
        }, timeout)
      })
    },
    async close() {
      if (closed) return
      closed = true
      for (const p of pages.slice()) if (!p.win.isDestroyed()) p.win.destroy()
      pages.length = 0
    },
    /** cookie 認証つきの取得（Amazon の適格請求書 PDF）。巡回と同じ区画で引く。 */
    async fetchBinary(url) {
      const res = await ses.fetch(url)
      return { ok: res.ok, status: res.status, body: Buffer.from(await res.arrayBuffer()) }
    },
  }

  // 最初のウィンドウは実際に巡回が始まるまで作らない。
  // サイト側が `context.pages()[0] ?? await context.newPage()` で開くので、ここでは作らない。
  return context
}

/** ログイン状態（巡回セッション）を捨てる（acquisition spec「ログイン状態を破棄できる」）。 */
export async function clearAcquisitionSession(electron, partition = ACQUISITION_PARTITION) {
  const ses = electron.session.fromPartition(partition)
  await ses.clearStorageData()
  await ses.clearCache()
  await ses.clearAuthCache()
}
