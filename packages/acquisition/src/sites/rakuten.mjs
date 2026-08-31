// 楽天市場 購入履歴の巡回手順。
// 取得・正規化・突合（Σ lineAmount + shipping − pointsUsed == orderTotal）のみ。分類・POSTはしない。
// 商品別の確定ソース（AmazonのPDF相当）は無く、注文詳細ページの内訳が一次ソース（SKILL.md）。
// 注文全体クーポンで商品に紐づけられない場合は合わせ込まず failedOrders へ（按分しない）。
import { ScrapeError } from '../core/errors.mjs'
import { failedOrder, finishEcResult, reconcileOrder, withLineNumbers } from '../core/ecOrder.mjs'
import { yen, isoDate } from '../core/normalize.mjs'
import { settle } from '../core/page.mjs'
import { compileSel, firstPage, openAndSettle, waitLoginStep, throwIfAborted, saveShot, visibleNextLink } from '../core/steps.mjs'

export const SOURCE = 'rakuten'
export const KIND = 'ec'
export const EVIDENCE_KEY = 'rakuten'
// v2: 新購入履歴SPA対応(注文日は注文番号YYYYMMDD・total=「支払い金額」お任意・points=ポイント利用限定・価格はnumber-display祖先探索)
// v3: 巡回コアを packages/acquisition へ切り出し（挙動は同一）
// v4: 突合・結果組み立てを core/ecOrder へ抽出（挙動は同一・単体テスト対象化）
// v5: 巡回骨格（ログイン待ち・ページ送り・中断/証跡）を core/steps へ抽出（挙動は同一）
// v6: 数量は「数量：N」ラベル優先（商品名中の「140g×10個」等の×Nを誤読していた）・
//     lineAmount=単価×数量（number-display は単価。数量≥2 の注文は突合が必ず落ちていた）
export const SCRIPT = 'rakuten@v6'

/**
 * 失敗の粒度（acquisition spec「部分成功を成功と見分けられるようにする」・issue #171）。
 * 'order'＝注文単位で failedOrders に積み、1件でもあれば partial（EXIT.PARTIAL）。
 * partial/exitCode の判定は run.mjs がこの宣言から一元的に行う。
 */
export const FAILURE_GRANULARITY = 'order'

// ▼ サイト較正ポイント（壊れたらまずここを疑う）
/** `page.goto` へ渡る較正キー。注文詳細の URL はページの DOM 由来なので較正には含まれない。 */
export const NAVIGABLE_KEYS = ['historyUrl']

export const DEFAULT_SEL = {
  historyUrl: 'https://order.my.rakuten.co.jp/',
  loggedInCheck: '購入履歴',
  loggedOutCheck: 'ログイン(し|ID)',
  orderNoRe: '(\\d{6}-\\d{8}-\\d{8,10})', // 注文番号（店舗ごとに別注文）
  detailLinkHref: 'order_number=', // 注文詳細への導線
  nextPage: '次へ|次の',
  // 注文詳細の内訳（innerText 正規表現）
  totalRe: '(?:お?支払い?金額|合計金額|請求金額)[\\s:：]*[￥¥]?\\s*([\\d,，]+)', // 「支払い金額」(お無)＋次行金額
  shippingRe: '送料[\\s:：]*[￥¥]?\\s*([\\d,，]+)', // 「送料無料」は数字でないので 0 扱い
  feeRe: '手数料[\\s:：]*[￥¥]?\\s*([\\d,，]+)',
  pointsRe: 'ポイント利用[\\s:：]*[-−－]?\\s*([\\d,，]+)', // 「利用可能ポイント」を誤マッチしないよう限定
  couponRe: 'クーポン[\\s:：]*[-−－]?\\s*([\\d,，]+)',
  itemLink: 'a[href*="item.rakuten.co.jp"]', // 商品行の同定（リンク内spanが商品名）
  priceContainer: '[class*="number-display"]', // 価格はリンクの兄弟ブロック側の number-display 要素
  maxPages: 50,
}

export async function scrape({ context, sel, args, run, log, evidence, onWaiting, isAborted }) {
  const warnings = []
  const { loggedInCheck, loggedOutCheck, nextPage, totalRe, shippingRe, feeRe, pointsRe, couponRe } =
    compileSel(sel, ['loggedInCheck', 'loggedOutCheck', 'nextPage', 'totalRe', 'shippingRe', 'feeRe', 'pointsRe', 'couponRe'])

  const page = await firstPage(context, run)
  await openAndSettle(run, page, sel.historyUrl, 'open-history')
  await waitLoginStep(run, page, {
    isLoggedIn: async (p) => {
      const body = await p.locator('body').innerText()
      return loggedInCheck.test(body) && !loggedOutCheck.test(body)
    },
    message: '楽天にログインしてください（パスワード/2FA/SPC認証は人が入力）',
    args,
    log,
    onWaiting,
    isAborted,
  })

  // 一覧から期間内の注文（注文番号＋詳細URL＋注文日）を収集（年切替 × ページ送り）
  const orderHeads = await run.step('list-orders', async () => {
    const heads = new Map()
    const y0 = parseInt(args.since.slice(0, 4), 10)
    const y1 = parseInt(args.until.slice(0, 4), 10)
    for (let year = y1; year >= y0; year--) {
      // 期間（年）セレクトがあれば切替（最新年は初期表示のままで良い）
      const switched = await page.evaluate((y) => {
        for (const el of document.querySelectorAll('select')) {
          const o = Array.from(el.options).find(
            (opt) => opt.text.includes(String(y)) || opt.value === String(y)
          )
          if (o) {
            if (el.value !== o.value) {
              el.value = o.value
              el.dispatchEvent(new Event('change', { bubbles: true }))
            }
            return true
          }
        }
        return false
      }, year)
      if (!switched && year !== y1) {
        warnings.push(`${year}年の期間切替セレクトが見つからない（表示中の年のみ取得）`)
        break
      }
      await settle(page, 2500)
      for (let pageNo = 1; pageNo <= sel.maxPages; pageNo++) {
        const found = await page.evaluate(
          ({ noRe, hrefKey }) => {
            const re = new RegExp(noRe)
            const out = []
            for (const a of document.querySelectorAll('a[href*="' + hrefKey + '"]')) {
              const scope = a.closest('li, tr, section, div[class]') ?? a
              const txt = scope.innerText || ''
              const no = re.exec(txt + ' ' + a.href)
              const d = /(20\d\d)[年/](\d{1,2})[月/](\d{1,2})/.exec(txt)
              if (no) out.push({ orderId: no[1], href: a.href, dateRaw: d ? `${d[1]}/${d[2]}/${d[3]}` : null })
            }
            return out
          },
          { noRe: sel.orderNoRe, hrefKey: sel.detailLinkHref }
        )
        for (const f of found) {
          // 注文番号 店舗-YYYYMMDD-連番 から注文日を取る（表示日付より堅牢）。無ければ表示日付。
          const md = /\d{6}-(\d{4})(\d{2})(\d{2})-/.exec(f.orderId)
          const orderDate = md ? `${md[1]}-${md[2]}-${md[3]}` : isoDate(f.dateRaw)
          if (!heads.has(f.orderId)) heads.set(f.orderId, { orderId: f.orderId, orderDate, href: f.href })
        }
        const next = await visibleNextLink(page, nextPage)
        if (!next) break
        await next.click()
        await settle(page)
      }
    }
    if (!heads.size)
      throw new ScrapeError(
        'list-orders',
        '注文が1件も見つからない（導線・注文番号形式の変化？）',
        'page.html で注文カード構造を確認して SEL を較正する'
      )
    const list = [...heads.values()]
      .filter((h) => h.orderDate && h.orderDate >= args.since && h.orderDate <= args.until)
      .sort((a, b) => a.orderDate.localeCompare(b.orderDate)) // 古い順（watermark 規約）
    log(`  期間内 ${list.length} 件`)
    return list
  })

  // 各注文詳細: 商品行＋内訳 → 純額化 → 突合
  const orders = []
  const failedOrders = []
  for (const head of orderHeads) {
    throwIfAborted(isAborted, 'order-detail')
    await run.step(`order-${head.orderId}`, async () => {
      await page.goto(head.href, { waitUntil: 'domcontentloaded' })
      await settle(page)
      const body = await page.locator('body').innerText()
      const orderTotal = yen(totalRe.exec(body)?.[1])
      const shipping = (yen(shippingRe.exec(body)?.[1]) ?? 0) + (yen(feeRe.exec(body)?.[1]) ?? 0)
      const pointsUsed = yen(pointsRe.exec(body)?.[1]) ?? 0
      const coupon = yen(couponRe.exec(body)?.[1]) ?? 0
      if (orderTotal == null) {
        // 失敗時の自己修復ヒント: 金額関連行をログ（SEL.totalRe 等の較正材料）
        const moneyLines = await page.evaluate(() =>
          (document.body.innerText || '')
            .split('\n')
            .map((l) => l.trim())
            .filter((l) => /円|金額|合計|お支払|送料|ポイント|クーポン/.test(l))
            .slice(0, 20)
        )
        log(`  ${head.orderId}: お支払い金額が読めない。金額関連行:\n    ${moneyLines.join('\n    ')}`)
        failedOrders.push(failedOrder(head, 'お支払い金額が読めない（詳細ページ構造変化？）'))
        return
      }
      // 商品行: item.rakuten.co.jp リンク（商品名）から上位へ辿り、number-display(価格)を含む
      // 最小の祖先ブロックを商品行とみなして 品名/数量/価格 を取る。
      const items = await page.evaluate(
        ({ itemSel, priceSel }) => {
          const out = []
          const seen = new Set()
          const usedPrice = new Set()
          for (const a of document.querySelectorAll(itemSel)) {
            const name = (a.innerText || '').replace(/\s+/g, ' ').trim()
            if (!name || name.length < 2) continue // 画像のみリンク等
            const key = name.slice(0, 50)
            if (seen.has(key)) continue
            seen.add(key)
            // 価格を含む最小の祖先ブロックを探す（この商品の number-display を拾う）
            let block = a
            let priceEl = null
            for (let up = 0; up < 6 && block; up++) {
              const cands = block.querySelectorAll(priceSel)
              // この商品ブロック内で未使用の number-display を採用（複数商品の取り違え回避）
              priceEl = [...cands].find((e) => !usedPrice.has(e)) ?? null
              if (priceEl) break
              block = block.parentElement
            }
            if (priceEl) usedPrice.add(priceEl)
            const priceRaw = priceEl ? (priceEl.innerText.match(/[\d,，]+/)?.[0] ?? null) : null
            const blkTxt = (block?.innerText || '').replace(/\s+/g, ' ')
            // 商品名に「140g×10個」等の ×N 表記が多く、最左マッチでは数量ラベルより先に当たる。
            // 「数量：N」を先に探し、×N はラベルが無いページの最終手段に格下げ。
            const qty = /数量[\s:：]*(\d+)/.exec(blkTxt) ?? /[×x]\s*(\d+)/.exec(blkTxt)
            out.push({ itemName: name, quantity: qty ? parseInt(qty[1], 10) : 1, priceRaw })
          }
          return out
        },
        { itemSel: sel.itemLink, priceSel: sel.priceContainer }
      )
      // number-display の金額は単価（行合計ではない）。lineAmount は Amazon と同じ
      // 「数量込みの行合計」に揃える。単価でないレイアウトが混ざっても突合が弾く。
      const lines = items
        .map((it) => {
          const unit = yen(it.priceRaw)
          return {
            itemName: it.itemName,
            quantity: it.quantity,
            lineAmount: unit == null ? null : unit * it.quantity,
          }
        })
        .filter((l) => l.lineAmount != null && l.lineAmount > 0)
      if (!lines.length) {
        failedOrders.push(failedOrder(head, '商品行を抽出できない（SEL.itemLink の較正要）'))
        return
      }
      const evidenceRef = evidence.ref(head.orderId, head.href)
      await saveShot(evidence, page, `${head.orderId}/order.png`)
      // 突合: 合わなければ合わせ込まない（注文全体クーポンの按分はしない＝MCP/人へ）
      const r = reconcileOrder({ lines, shipping, pointsUsed, orderTotal })
      if (!r.ok) {
        failedOrders.push(
          failedOrder(head, r.reason + (coupon ? `（クーポン ${coupon} 円の商品紐づけ要確認）` : ''))
        )
        return
      }
      orders.push({
        orderId: head.orderId,
        orderDate: head.orderDate,
        orderTotal,
        shipping,
        pointsUsed,
        lines: withLineNumbers(lines, evidenceRef),
      })
      log(`  ${head.orderId} (${head.orderDate}): ${lines.length}行 突合OK`)
    })
  }

  // orders は突合OKのみ / failedOrders はスキルが MCP で個別補完する対象
  return finishEcResult(orders, failedOrders, warnings, log)
}
