import { describe, it, expect, beforeEach } from 'vitest'
import {
  createElectronContext,
  normalizeUserAgent,
  clearAcquisitionSession,
  ACQUISITION_PARTITION,
} from '../runtime/electron.mjs'
import { ScrapeError } from '../core/errors.mjs'
import { BROWSER_API } from '../core/page.mjs'
import { makeFakeElectron, FakeBrowserWindow } from './helpers/fakeElectron.mjs'

let electron
beforeEach(() => {
  electron = makeFakeElectron()
})

async function openPage(html, opts) {
  const context = createElectronContext({ electron, ...opts })
  const page = await context.newPage()
  await page.goto('https://bank.example/')
  page.win.setHtml(html)
  return { context, page }
}

describe('UA の正規化', () => {
  it('Electron / Kanean のトークンを落とす', () => {
    const ua = normalizeUserAgent(
      'Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Kanean/0.0.0 Chrome/140.0.0.0 Electron/43.4.0 Safari/537.36'
    )
    expect(ua).not.toMatch(/Electron/)
    expect(ua).not.toMatch(/Kanean/i)
    expect(ua).toMatch(/Chrome\/140\.0\.0\.0/)
    expect(ua).not.toMatch(/ {2}/)
  })

  it('文脈を作った時点で区画の UA に反映される', () => {
    createElectronContext({ electron })
    expect(electron.session.fromPartition(ACQUISITION_PARTITION).getUserAgent()).not.toMatch(
      /Electron/
    )
  })
})

describe('巡回ウィンドウの隔離', () => {
  it('アプリ内 API へ到達しうる設定を持たない', async () => {
    const context = createElectronContext({ electron })
    await context.newPage()
    const [win] = FakeBrowserWindow.created
    const wp = win.options.webPreferences
    expect(wp.nodeIntegration).toBe(false)
    expect(wp.contextIsolation).toBe(true)
    expect(wp.sandbox).toBe(true)
    expect(wp.preload).toBeUndefined() // アプリの機能をページへ露出しない
  })

  it('会計データと別の永続区画を使う（既定セッションではない）', async () => {
    const context = createElectronContext({ electron })
    await context.newPage()
    expect(FakeBrowserWindow.created[0].options.webPreferences.partition).toBe(
      ACQUISITION_PARTITION
    )
    expect(ACQUISITION_PARTITION.startsWith('persist:')).toBe(true)
  })

  it('人が見える状態で開く', async () => {
    const context = createElectronContext({ electron })
    await context.newPage()
    expect(FakeBrowserWindow.created[0].options.show).toBe(true)
  })

  it('閉じるとウィンドウが残らない', async () => {
    const context = createElectronContext({ electron })
    await context.newPage()
    await context.newPage()
    await context.close()
    expect(FakeBrowserWindow.created.every((w) => w.isDestroyed())).toBe(true)
    expect(context.pages()).toHaveLength(0)
  })
})

describe('locator の解決', () => {
  it('CSS セレクタで数えられる（待たない）', async () => {
    const { page } = await openPage('<table></table><table></table>')
    expect(await page.locator('table').count()).toBe(2)
    expect(await page.locator('.nope').count()).toBe(0)
  })

  it('getByRole(link) を名前の正規表現で絞る', async () => {
    const { page } = await openPage(
      '<a href="/a">入出金明細</a><a href="/b">お知らせ</a><span>入出金明細</span>'
    )
    expect(await page.getByRole('link', { name: /入出金明細/ }).count()).toBe(1)
    expect(await page.getByRole('link', { name: /存在しない/ }).count()).toBe(0)
  })

  it('getByText は最も内側の一致だけを返す（first() が親を掴まない）', async () => {
    const { page } = await openPage('<div><section><b>期間を指定する</b></section></div>')
    const loc = page.getByText(/期間を指定する/)
    expect(await loc.count()).toBe(1)
  })

  it('連鎖して絞り込める', async () => {
    const { page } = await openPage(
      '<div id="x"><a href="/1">次へ</a></div><a href="/2">次へ</a>'
    )
    expect(await page.locator('#x').getByRole('link', { name: /次へ/ }).count()).toBe(1)
    expect(await page.getByRole('link', { name: /次へ/ }).count()).toBe(2)
  })

  it('innerText を読める', async () => {
    const { page } = await openPage('<body>ログアウト メニュー</body>')
    expect(await page.locator('body').innerText()).toContain('ログアウト')
  })

  it('isVisible は display:none を偽にする（待たない）', async () => {
    const { page } = await openPage('<b id="a">見える</b><b id="b" style="display:none">隠れ</b>')
    expect(await page.locator('#a').isVisible()).toBe(true)
    expect(await page.locator('#b').isVisible()).toBe(false)
    expect(await page.locator('#none').isVisible()).toBe(false)
  })
})

describe('自動待機の意味論（design D2 の要）', () => {
  it('後から現れる要素を待って掴む', async () => {
    const { page } = await openPage('<div id="host"></div>')
    setTimeout(() => {
      const doc = page.win._dom.window.document
      doc.getElementById('host').innerHTML = '<button id="go">照会</button>'
    }, 250)
    await page.locator('#go').click() // 待たなければ落ちる
    expect(await page.locator('#go').count()).toBe(1)
  })

  /**
   * `scrollIntoView` の既定 `behavior:'auto'` はページの CSS `scroll-behavior: smooth` に従う。
   * スムーススクロール中に座標を測ると**スクロール前の値**が返り、実クリックが別の場所へ飛ぶ。
   * Amazon の領収書ポップオーバーが殻Bでだけ開かない件の本命（tasks 10.4a）。
   */
  it('クリック前のスクロールはスムーススクロールを頼まない（座標が古いまま測られる）', async () => {
    const { page } = await openPage('<button id="go">照会</button>')
    await page.locator('#go').click()
    const calls = page.win._dom.window.__scrollIntoViewCalls ?? []
    expect(calls.length).toBeGreaterThan(0)
    for (const c of calls) expect(c?.behavior).toBe('instant')
  })

  it('現れなければ「どのセレクタを待ったか」を添えて失敗する', async () => {
    const { page } = await openPage('<div></div>')
    const err = await page
      .locator('#never')
      .click({ timeout: 300 })
      .catch((e) => e)
    expect(err).toBeInstanceOf(ScrapeError)
    expect(err.message).toContain('#never')
    expect(err.hint).toMatch(/較正/)
  })

  it('count() は待たない（0 件も正当な答え）', async () => {
    const { page } = await openPage('<div></div>')
    const t0 = Date.now()
    expect(await page.locator('#never').count()).toBe(0)
    expect(Date.now() - t0).toBeLessThan(300)
  })
})

describe('入力', () => {
  it('fill は native setter で書いて input/change を出す（SPA のモデルへ入る）', async () => {
    const { page } = await openPage('<input id="d" type="date">')
    const win = page.win._dom.window
    const seen = []
    win.document.getElementById('d').addEventListener('input', () => seen.push('input'))
    win.document.getElementById('d').addEventListener('change', () => seen.push('change'))
    await page.locator('#d').fill('2026-01-01')
    expect(win.document.getElementById('d').value).toBe('2026-01-01')
    expect(seen).toEqual(['input', 'change'])
  })

  it('selectOption は値でもラベルでも選べる', async () => {
    const { page } = await openPage('<select id="s"><option value="5">期間指定</option></select>')
    await page.locator('#s').selectOption('5')
    expect(page.win._dom.window.document.getElementById('s').value).toBe('5')
    await page.locator('#s').selectOption('期間指定')
    expect(page.win._dom.window.document.getElementById('s').value).toBe('5')
  })

  it('選択肢が無ければ黙って進まない', async () => {
    const { page } = await openPage('<select id="s"><option value="1">全部</option></select>')
    await expect(page.locator('#s').selectOption('9')).rejects.toThrow(ScrapeError)
  })

  it('pressSequentially は1文字ずつ実キー入力を送る（.fill が効かない画面のため）', async () => {
    const { page } = await openPage('<input id="d">')
    await page.locator('#d').pressSequentially('2026', { delay: 0 })
    const keys = page.win.webContents.inputEvents.filter((e) => e.type === 'char').map((e) => e.keyCode)
    expect(keys).toEqual(['2', '0', '2', '6'])
  })

  it('dispatchEvent はハンドラを直接叩く（オーバーレイ貫通の逃げ道）', async () => {
    const { page } = await openPage('<button id="b">押す</button>')
    const win = page.win._dom.window
    let clicked = 0
    win.document.getElementById('b').addEventListener('click', () => clicked++)
    await page.locator('#b').dispatchEvent('click')
    expect(clicked).toBe(1)
  })
})

describe('ページの基本操作', () => {
  it('url / content / screenshot が取れる（診断の材料）', async () => {
    const { page } = await openPage('<body><h1>明細</h1></body>')
    expect(page.url()).toBe('https://bank.example/')
    expect(await page.content()).toContain('明細')
    expect(await page.screenshot()).toBeInstanceOf(Buffer)
  })

  it('evaluate はページ内で評価される', async () => {
    const { page } = await openPage('<table><tr><th>取引日</th></tr></table>')
    const heads = await page.evaluate(() =>
      Array.from(document.querySelectorAll('th')).map((e) => e.textContent)
    )
    expect(heads).toEqual(['取引日'])
  })

  it('evaluate に引数を渡せる', async () => {
    const { page } = await openPage('<a href="?selectdt=202601">1月</a>')
    const got = await page.evaluate(
      (key) => Array.from(document.querySelectorAll('a[href*="' + key + '"]')).length,
      'selectdt='
    )
    expect(got).toBe(1)
  })

  it('ウィンドウを閉じられたら、その旨を返して止まる', async () => {
    const { page } = await openPage('<div></div>')
    page.win.destroy()
    await expect(page.content()).rejects.toThrow(/巡回ウィンドウが閉じられました/)
  })
})

describe('別タブ遷移', () => {
  it('開かなければ null（同一タブ遷移だったという扱い）', async () => {
    const context = createElectronContext({ electron })
    await context.newPage()
    expect(await context.waitForEvent('page', { timeout: 30 })).toBeNull()
  })

  it('開いた子ウィンドウを page として受け取れる', async () => {
    const context = createElectronContext({ electron })
    const page = await context.newPage()
    const waiting = context.waitForEvent('page', { timeout: 1000 })
    const child = new FakeBrowserWindow({ webPreferences: {} })
    page.win.webContents.emit('did-create-window', child)
    const opened = await waiting
    expect(opened.win).toBe(child)
    expect(context.pages()).toHaveLength(2)
  })

  it('page 以外のイベントは受け付けない', async () => {
    const context = createElectronContext({ electron })
    await expect(context.waitForEvent('download')).rejects.toThrow(ScrapeError)
  })
})

describe('cookie 認証つきの取得', () => {
  it('巡回と同じ区画で引く', async () => {
    const context = createElectronContext({ electron })
    const r = await context.fetchBinary('https://amazon.example/invoice.pdf')
    expect(r.ok).toBe(true)
    expect(r.body.toString()).toContain('%PDF')
  })
})

describe('ログイン状態の破棄', () => {
  it('保存領域・キャッシュ・認証キャッシュを消す', async () => {
    await clearAcquisitionSession(electron)
    expect(electron.session.fromPartition(ACQUISITION_PARTITION).cleared).toEqual([
      'storage',
      'cache',
      'auth',
    ])
  })
})

describe('契約の充足', () => {
  it('Electron 殻は巡回契約の口を全て備える', async () => {
    const context = createElectronContext({ electron })
    const page = await context.newPage()
    for (const name of BROWSER_API.context) expect(typeof context[name], name).toBe('function')
    for (const name of BROWSER_API.page) expect(typeof page[name], name).toBe('function')
    const loc = page.locator('body')
    for (const name of BROWSER_API.locator) expect(typeof loc[name], name).toBe('function')
  })
})
