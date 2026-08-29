import { describe, it, expect, beforeEach } from 'vitest'
import { createElectronContext } from '../runtime/electron.mjs'
import { makeRunner } from '../core/runner.mjs'
import { makeFakeElectron } from './helpers/fakeElectron.mjs'
import { nullEvidence } from './helpers/fakeBrowser.mjs'
import * as mufg from '../sites/mufg.mjs'
import * as shinsei from '../sites/shinsei.mjs'
import * as ufjvisa from '../sites/ufjvisa.mjs'
import * as amazon from '../sites/amazon.mjs'
import * as rakuten from '../sites/rakuten.mjs'

/**
 * sites × Electron 殻の結合ゴールデンテスト（issue #172）。
 *
 * Electron 殻の evaluate は `fn.toString()` で関数を文字列化してページへ注入する
 * （runtime/electron.mjs）。**外側スコープを参照するコールバックはこの殻でだけ落ちる**が、
 * Playwright 殻と fakeBrowser は関数をそのまま呼ぶので検出できない。
 * ここでは各サイトの scrape を丸ごと Electron 殻（jsdom）へ通し、代表 HTML から
 * 期待の件数・検算が返ることを固定する＝閉包キャプチャの回帰が自動で捕まる。
 *
 * SEL は**同梱の DEFAULT_SEL をそのまま**使う（出荷している較正が動くことも検証対象）。
 */

let electron
beforeEach(() => {
  electron = makeFakeElectron()
})

/**
 * 待ち時間だけを短縮した context（意味論は不変・実測 1500ms 級の settle を 30ms に圧縮）。
 * ポーリングは回数が増えるだけで、待つ/待たないの契約は変わらない。
 */
function fastContext(context) {
  const wrapPage = (p) =>
    p &&
    new Proxy(p, {
      get(target, key) {
        if (key === 'waitForTimeout') return (ms) => target.waitForTimeout(Math.min(ms, 30))
        const v = target[key]
        return typeof v === 'function' ? v.bind(target) : v
      },
    })
  return {
    pages: () => context.pages().map(wrapPage),
    newPage: async () => wrapPage(await context.newPage()),
    waitForEvent: async (event, opts) => wrapPage(await context.waitForEvent(event, opts)),
    close: () => context.close(),
    fetchBinary: (url) => context.fetchBinary(url),
  }
}

/** サイト scrape を run.mjs 相当の道具立てで駆動する（分類・POST・watermark は関与しない）。 */
function drive(site, { args, tools } = {}) {
  const run = makeRunner(site.SOURCE, { log: () => {} })
  const context = fastContext(createElectronContext({ electron }))
  return site.scrape({
    context,
    sel: site.DEFAULT_SEL,
    args: { loginTimeout: '5', ...args },
    run,
    log: () => {},
    evidence: nullEvidence,
    tools,
    onWaiting: async () => {},
    isAborted: () => false,
  })
}

// ---------------------------------------------------------------------------
// mufg（銀行・単一画面に全要素が同居する近似。期間指定→照会→テーブル抽出→残高チェーン検算）

const MUFG_PAGE = `<html><body>
<header><a href="#">ログアウト</a></header>
<nav><a href="#">入出金明細</a></nav>
<section>
  <select id="sl-period"><option value="1">当月</option><option value="5">期間指定</option></select>
  <input id="tx-start-date" type="date">
  <input id="tx-end-date" type="date">
  <select id="sl-filter-type"><option value="1">全取引</option></select>
  <select id="sl-filter-number"><option value="100">100件</option></select>
  <button id="bt-inquiry">条件を変更</button>
</section>
<table>
  <tr><th>日付</th><th>取引内容</th><th>お支払い金額</th><th>お預かり金額</th><th>残高</th></tr>
  <tr><td>2026年4月20日</td><td>振込 テスト</td><td>2,000</td><td></td><td>9,000</td></tr>
  <tr><td>2026年4月10日</td><td>入金 テスト</td><td></td><td>5,000</td><td>11,000</td></tr>
  <tr><td>2026年4月1日</td><td>期首入金</td><td></td><td>6,000</td><td>6,000</td></tr>
</table>
</body></html>`

describe('mufg × Electron 殻', () => {
  it('代表 HTML から 3 件を抽出し、新しい順表示を反転して残高チェーンが通る', { timeout: 30_000 }, async () => {
    electron.route(mufg.DEFAULT_SEL.loginUrl, MUFG_PAGE)
    const r = await drive(mufg, { args: { since: '2026-04-01', until: '2026-04-30' } })
    expect(r.transactions.map((t) => [t.txnDate, t.direction, t.amount, t.balance])).toEqual([
      ['2026-04-01', 'in', 6000, 6000],
      ['2026-04-10', 'in', 5000, 11000],
      ['2026-04-20', 'out', 2000, 9000],
    ])
    expect(r.verification).toEqual({ balanceChainOk: true, extractedRows: 3 })
    expect(r.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// shinsei（銀行・クリック遷移のみの SPA。照会アンカーで結果ページへ遷移し即ポーリングで掴む）

const SHINSEI_TOP = `<html><body>
<a href="#">ログアウト</a>
<a href="/account/activity">入出金明細</a>
</body></html>`

const SHINSEI_ACTIVITY = `<html><body>
<a href="#">ログアウト</a>
<span>過去の入出金明細を照会</span>
<span>期間を指定する</span>
<input id="beginDate"><input id="endDate">
<a role="button" href="/account/activity/result">照会</a>
</body></html>`

const SHINSEI_RESULT = `<html><body>
<a href="#">ログアウト</a>
<table>
  <tr><th>取引日</th><th>摘要</th><th>メモ</th><th>出金</th><th>入金</th><th>残高</th></tr>
  <tr><td>2026/04/15</td><td>カード引落</td><td>メモ1</td><td>1,200</td><td></td><td>8,800</td></tr>
  <tr><td>2026/04/05</td><td>給与</td><td></td><td></td><td>10,000</td><td>10,000</td></tr>
</table>
</body></html>`

describe('shinsei × Electron 殻', () => {
  it('TOP→明細→照会のクリック遷移で 2 件を抽出し、メモ列連結と残高チェーンが通る', { timeout: 30_000 }, async () => {
    electron.route('/account/activity/result', SHINSEI_RESULT) // 先勝ち＝より特定的な方を先に
    electron.route('/account/activity', SHINSEI_ACTIVITY)
    electron.route(shinsei.DEFAULT_SEL.topUrl, SHINSEI_TOP)
    const r = await drive(shinsei, { args: { since: '2026-04-05', until: '2026-04-30' } })
    expect(r.transactions.map((t) => [t.txnDate, t.direction, t.amount, t.description])).toEqual([
      ['2026-04-05', 'in', 10000, '給与'],
      ['2026-04-15', 'out', 1200, 'カード引落 メモ1'],
    ])
    expect(r.verification).toEqual({ balanceChainOk: true, extractedRows: 2 })
    expect(r.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// ufjvisa（カード・別タブ遷移＋請求月さかのぼり。未確定月の除外と「Σ明細＝新規ご利用額」検算）

const UFJVISA_TOP = `<html><body>
<a href="#">ログアウト</a>
<a href="https://mdc.example/summary" target="_blank">ご請求額・利用明細照会</a>
</body></html>`

const UFJVISA_SUMMARY = `<html><body>
<a href="https://mdc.example/detail.html?tag=abc&selectdt=202604">2026年4月分</a>
<a href="https://mdc.example/detail.html?tag=abc&selectdt=202603">2026年3月分</a>
</body></html>`

const MONTH_SELECT = `<select name="selectdt">
  <option value="202605">2026年5月</option>
  <option value="202604">2026年4月</option>
  <option value="202603">2026年3月</option>
</select>`

const UFJVISA_MAY = `<html><body><h2>2026年5月分(未確定分)</h2>${MONTH_SELECT}</body></html>`

const UFJVISA_APRIL = `<html><body>
<h2>2026年4月分</h2>
${MONTH_SELECT}
<table>
  <tr><th>利用日</th><th>利用店名</th><th>利用金額</th></tr>
  <tr><td>2026/4/12</td><td>店舗A</td><td>1,000</td></tr>
  <tr><td>2026/4/5</td><td>店舗B</td><td>2,500</td></tr>
  <tr><td></td><td>海外手数料（本体内包の注記行）</td><td>10</td></tr>
</table>
<table>
  <tr><th>ご利用区分</th><th>新規ご利用額（円）</th></tr>
  <tr><td>ショッピング</td><td>3,500</td></tr>
</table>
</body></html>`

const UFJVISA_MARCH = `<html><body>
<h2>2026年3月分</h2>
${MONTH_SELECT}
<table>
  <tr><th>利用日</th><th>利用店名</th><th>利用金額</th></tr>
  <tr><td>2026/3/10</td><td>店舗D（返金）</td><td>-200</td></tr>
  <tr><td>2026/3/3</td><td>店舗C</td><td>700</td></tr>
</table>
<table>
  <tr><th>ご利用区分</th><th>新規ご利用額（円）</th></tr>
  <tr><td>ショッピング</td><td>500</td></tr>
</table>
</body></html>`

describe('ufjvisa × Electron 殻', () => {
  it('別タブの請求月を since まで遡り、未確定月を除外して月次検算が通る', { timeout: 30_000 }, async () => {
    electron.route('selectdt=202605', UFJVISA_MAY)
    electron.route('selectdt=202604', UFJVISA_APRIL)
    electron.route('selectdt=202603', UFJVISA_MARCH)
    electron.route('mdc.example/summary', UFJVISA_SUMMARY)
    electron.route(ufjvisa.DEFAULT_SEL.loginUrl, UFJVISA_TOP)
    const r = await drive(ufjvisa, { args: { since: '2026-03-03', until: '2026-04-30' } })
    // 未確定の 202605 は billingMonths に入らない。注記行（日付なし）は捨てられ検算が合う
    expect(r.billingMonths).toEqual([
      { month: '202604', newUsageTotal: 3500, txnCount: 2 },
      { month: '202603', newUsageTotal: 500, txnCount: 2 },
    ])
    expect(r.transactions.map((t) => [t.txnDate, t.direction, t.amount])).toEqual([
      ['2026-03-03', 'out', 700],
      ['2026-03-10', 'in', 200],
      ['2026-04-05', 'out', 2500],
      ['2026-04-12', 'out', 1000],
    ])
    expect(r.verification).toEqual({ monthlyTotalsOk: true, extractedRows: 4 })
    expect(r.warnings).toEqual([])
  })
})

// ---------------------------------------------------------------------------
// amazon（EC・注文一覧→詳細→PDF突合。突合NGは注文単位で failedOrders へ＝取り違えない）

const AMAZON_ORDERS = `<html><body>
<h1>注文履歴</h1>
<div class="order-card">
  2026年4月10日
  <a href="https://www.amazon.co.jp/your-orders/order-details?orderID=249-1234567-1234567">注文の詳細</a>
</div>
<div class="order-card">
  2026年4月12日
  <a href="https://www.amazon.co.jp/your-orders/order-details?orderID=249-7654321-7654321">注文の詳細</a>
</div>
</body></html>`

const AMAZON_ORDERS_EMPTY = `<html><body><h1>注文履歴</h1><p>該当する注文はありません</p></body></html>`

const amazonDetail = (total) => `<html><body>
<h1>注文内容</h1>
<div>ご請求額： ￥${total}</div>
<div>配送料・手数料： ￥410</div>
<div>ポイント： −￥100</div>
<span>領収書等</span>
<a href="https://www.amazon.co.jp/documents/download/abc123.pdf">適格請求書</a>
</body></html>`

const AMAZON_INVOICE_TEXT = [
  '内容 数量 価格 税率 税抜 税込',
  'テスト商品A 1 ￥1,264 10% ￥1,390 ￥1,390',
  '小計 ￥1,390',
].join('\n')

describe('amazon × Electron 殻', () => {
  it('一覧→詳細→PDF の 2 注文を処理し、突合OKは orders・NGは failedOrders に分かれる', { timeout: 30_000 }, async () => {
    electron.route('orderID=249-1234567-1234567', amazonDetail('1,700')) // 1390+410−100=1700 → 突合OK
    electron.route('orderID=249-7654321-7654321', amazonDetail('9,999')) // → 突合NG
    electron.route('startIndex=0', AMAZON_ORDERS)
    electron.route('your-orders/orders', AMAZON_ORDERS_EMPTY) // 2ページ目以降は空＝打ち切り
    const r = await drive(amazon, {
      args: { since: '2026-04-01', until: '2026-04-30' },
      tools: { pdfToText: async () => AMAZON_INVOICE_TEXT },
    })
    expect(r.orders).toHaveLength(1)
    expect(r.orders[0]).toMatchObject({
      orderId: '249-1234567-1234567',
      orderDate: '2026-04-10',
      orderTotal: 1700,
      shipping: 410,
      pointsUsed: 100,
    })
    expect(r.orders[0].lines).toEqual([
      {
        lineNo: 1,
        itemName: 'テスト商品A',
        quantity: 1,
        lineAmount: 1390,
        evidenceRef: 'https://www.amazon.co.jp/your-orders/order-details?orderID=249-1234567-1234567',
      },
    ])
    expect(r.failedOrders).toHaveLength(1)
    expect(r.failedOrders[0].orderId).toBe('249-7654321-7654321')
    expect(r.failedOrders[0].reason).toMatch(/突合NG/)
  })
})

// ---------------------------------------------------------------------------
// rakuten（EC・一覧→詳細。注文日は注文番号由来・価格は number-display 祖先探索）

const RAKUTEN_LIST = `<html><body>
<h1>購入履歴</h1>
<li>
  2026/04/10 テストショップ
  <a href="https://order.my.rakuten.co.jp/purchase/detail?order_number=123456-20260410-00000001">注文詳細を見る</a>
</li>
</body></html>`

const RAKUTEN_DETAIL = `<html><body>
<h1>注文詳細</h1>
<div>支払い金額 2,000円</div>
<div>送料無料</div>
<div>ポイント利用 100</div>
<div class="item-block">
  <a href="https://item.rakuten.co.jp/testshop/item1/">テスト商品C 100ml</a>
  <div class="number-display">2,100円</div>
  <span>数量:1</span>
</div>
</body></html>`

describe('rakuten × Electron 殻', () => {
  it('一覧→詳細で 1 注文を抽出し、送料無料=0・ポイント利用込みで突合が通る', { timeout: 30_000 }, async () => {
    electron.route('order_number=123456-20260410-00000001', RAKUTEN_DETAIL) // 先勝ち
    electron.route(rakuten.DEFAULT_SEL.historyUrl, RAKUTEN_LIST)
    const r = await drive(rakuten, { args: { since: '2026-04-01', until: '2026-04-30' } })
    expect(r.failedOrders).toEqual([])
    expect(r.orders).toHaveLength(1)
    expect(r.orders[0]).toMatchObject({
      orderId: '123456-20260410-00000001',
      orderDate: '2026-04-10', // 表示日付ではなく注文番号の YYYYMMDD 由来
      orderTotal: 2000,
      shipping: 0,
      pointsUsed: 100,
    })
    expect(r.orders[0].lines).toEqual([
      {
        lineNo: 1,
        itemName: 'テスト商品C 100ml',
        quantity: 1,
        lineAmount: 2100,
        evidenceRef: 'https://order.my.rakuten.co.jp/purchase/detail?order_number=123456-20260410-00000001',
      },
    ])
    expect(r.warnings).toEqual([])
  })
})
