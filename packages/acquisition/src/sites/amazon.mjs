// Amazon.co.jp 注文履歴の巡回手順。
// 取得・正規化・突合（Σ lineAmount + shipping − pointsUsed == orderTotal）のみ。分類・POSTはしない。
// 金額は 2ソース併用（SKILL.md）: 商品別純額=適格請求書PDF（同梱 pdf.js で抽出）/ ポイント・送料・請求額=注文詳細HTML。
// 突合NGの注文は failedOrders に落として PARTIAL。スキル/MCP がその注文だけ補完する。
import { failedOrder, finishEcResult, reconcileOrder, withLineNumbers } from '../core/ecOrder.mjs'
import { yen, isoDate } from '../core/normalize.mjs'
import { clickThrough, settle, waitFor } from '../core/page.mjs'
import { compileSel, firstPage, openAndSettle, waitLoginStep, throwIfAborted, saveShot } from '../core/steps.mjs'

export const SOURCE = 'amazon'
export const KIND = 'ec'
export const EVIDENCE_KEY = 'amazon'
// v2: 請求書PDFの商品名は価格行+後続折返しで組立(ヘッダ税抜税込を除外)・配送料明細行はshippingへ分離(HTML二重計上回避)
// v3: 巡回コアを packages/acquisition へ切り出し（URL はテンプレート化＝較正をデータのみにする）
// v4: PDF 抽出を同梱 pdf.js へ（poppler 依存を外す）・値引行を商品へ反映・領収書ポップオーバーを明示的待機へ
// v5: 突合・結果組み立てを core/ecOrder へ抽出（挙動は同一・単体テスト対象化）
// v6: 巡回骨格を core/steps へ抽出・領収書リトライの回数/待ちを SEL 化（既定値は従来と同一）
export const SCRIPT = 'amazon@v6'

/**
 * 失敗の粒度（acquisition spec「部分成功を成功と見分けられるようにする」・issue #171）。
 * 'order'＝注文単位で failedOrders に積み、1件でもあれば partial（EXIT.PARTIAL）。
 * partial/exitCode の判定は run.mjs がこの宣言から一元的に行う。
 */
export const FAILURE_GRANULARITY = 'order'

// ▼ サイト較正ポイント（壊れたらまずここを疑う）
// URL は**関数ではなくテンプレート**で持つ。較正としてプログラムを受け取らないため（design D3）。
/** `page.goto` へ渡る較正キー。 */
export const NAVIGABLE_KEYS = ['ordersUrlTemplate', 'detailUrlTemplate']

export const DEFAULT_SEL = {
  ordersUrlTemplate:
    'https://www.amazon.co.jp/your-orders/orders?timeFilter=year-{year}&startIndex={startIndex}',
  detailUrlTemplate: 'https://www.amazon.co.jp/your-orders/order-details?orderID={orderId}',
  orderCard: '.order-card, .order, .js-order-card', // 注文一覧のカード
  orderIdRe: '(\\d{3}-\\d{7}-\\d{7})',
  receiptLink: '領収書等|領収書/購入明細書', // 詳細ページのポップオーバー
  invoicePdfHref: '/documents/download/[^"\']+\\.pdf', // 適格請求書PDF（大小文字無視で照合）
  // 注文詳細の金額ブロック（innerText 正規表現）
  totalRe: 'ご請求額[:：]?\\s*[￥¥]\\s*([\\d,，]+)',
  shippingRe: '配送料・?手数料[:：]?\\s*[￥¥]\\s*([\\d,，]+)',
  pointsRe: 'ポイント[:：]?\\s*[-−－]\\s*[￥¥]?\\s*([\\d,，]+)',
  pageSize: 10, // 一覧の1ページ件数（startIndex の増分）
  maxStartIndex: 1000,
  // 領収書ポップオーバーのリトライ（tasks 10.4a）。既定は実測で最も良かった組み合わせ
  // （3回 × 出現待ち5s ＋ リンク待ち3s）。⚠ 根拠のない微調整はしないこと — 振るなら
  // update_site_calibration（実機計測）で。Electron 殻の 14/22 問題の一次調整点。
  receiptRetries: 3,
  receiptWaitMs: 5000,
  pdfLinksWaitMs: 3000,
}

/** テンプレートの `{key}` を値で埋める。较正がデータであることを保つための素朴な置換。 */
export function fillTemplate(template, values) {
  return String(template).replace(/\{(\w+)\}/g, (whole, key) =>
    key in values ? encodeURIComponent(String(values[key])) : whole
  )
}

// 請求書テキスト（`core/pdfText.mjs` の `layoutFromItems` が組んだ行）から商品行を読む。
// 例: `Anker … USB-C ケーブル  1  ￥1,264  10%  ￥1,390  ￥1,390`（数量/税抜/税率/税込/小計）
// ⚠ Amazonの請求書は「商品名の1行目に数量/価格カラム」が入り、商品名は価格行の"後"に折り返す。
//    よって価格行で商品を開始し、続く非価格行を商品名に追記する（ヘッダ「税抜 税込 税込」は捨てる）。
// ⚠ **値引は独立行で来る**（小計に織り込み済みではない）。実物22注文のうち4注文がこの形で、
//    落とすと Σline が過大になり突合で弾かれる＝注文ごと取りこぼす。直前の商品へ差し引く。
//      `値引        -￥243      -￥263    -￥263`（税抜/税込/小計。最終カラムが lineAmount への差分）
//    数量も税率%も持たないので商品行の正規表現には当たらない＝抽出器を替えても拾えない性質のもの。
export function parseInvoiceItems(text) {
  const items = []
  let cur = null
  const flush = () => {
    if (!cur) return
    items.push({
      itemName: cur.parts.join(' ').replace(/\s+/g, ' ').trim(),
      quantity: cur.quantity,
      lineAmount: cur.lineAmount,
    })
    cur = null
  }
  for (const raw of text.split('\n')) {
    const line = raw.trim()
    if (!line) continue
    // セクション境界（小計/合計 等）で商品を確定。ヘッダのみの行（内容/数量/価格/税率/税抜/税込）は捨てる
    if (/小計|合計|消費税|請求|お支払|登録番号|ページ/.test(line)) {
      flush()
      continue
    }
    if (/^(?:内容|数量|価格|税率|税抜|税込)+$/.test(line.replace(/\s+/g, ''))) continue
    const m = /^(.*?)\s+(\d+)\s+[￥¥]([\d,，]+)\s+(\d+)%\s+[￥¥]([\d,，]+)\s+[￥¥]([\d,，]+)\s*$/.exec(line)
    if (m) {
      flush() // 直前の商品を確定して新商品を開始
      cur = { parts: [m[1].trim()], quantity: parseInt(m[2], 10), lineAmount: yen(m[6]) }
      continue
    }
    // 値引行 → 直前の商品から差し引く（最終カラム＝小計への差分）。
    // 当てる相手が無ければ何もしない（どこへ効かせるか決められないものを推測で当てない）。
    // `\b` は使わない（JS の語境界は英数字基準なので「引」の後ろでは成立しない）。
    // 負の金額を伴うことも条件にするので、商品名が「値引」で始まっても誤爆しない。
    const d = /^値引/.test(line) ? [...line.matchAll(/[-−]\s*[￥¥]([\d,，]+)/g)] : []
    if (d.length) {
      if (cur) cur.lineAmount -= yen(d[d.length - 1][1])
      continue
    }
    if (cur && !/[￥¥]/.test(line)) cur.parts.push(line) // 商品名の折返し（価格行の後に続く）
  }
  flush()
  return items
}

/** 配送料・手数料として扱う明細行。 */
const SHIPPING_LINE = /^(配送料|送料|手数料)/

/**
 * 配送料/手数料はPDFに明細行として現れることがある → 商品行から分離し shipping に回す
 * （HTML の配送料と二重計上しない。PDFに行があればそちらを優先）。
 *
 * ⚠ 採否は **PDF に配送料行があるかどうか**で決める。金額が 0 かどうかで決めてはいけない。
 *   送料は値引で相殺されて正味 0 になることがあり（配送料 +100 / 値引 −100）、
 *   `pdfShipping || htmlShipping` と書くとそれを「PDFに行が無い」と取り違えて
 *   HTML 側の**値引前**の額へ落ち、突合が壊れる（実物の 22 注文中 1 件がこの形）。
 *
 * @param {{itemName:string, quantity:number, lineAmount:number}[]} lines
 * @param {number} htmlShipping 注文詳細HTMLから読んだ配送料
 */
export function splitShipping(lines, htmlShipping) {
  const shipLines = lines.filter((l) => SHIPPING_LINE.test(l.itemName))
  return {
    productLines: lines.filter((l) => !SHIPPING_LINE.test(l.itemName)),
    shipping: shipLines.length ? shipLines.reduce((a, l) => a + l.lineAmount, 0) : htmlShipping,
  }
}

export async function scrape({
  context,
  sel,
  args,
  run,
  log,
  evidence,
  tools,
  onWaiting,
  isAborted,
}) {
  const warnings = []
  const { receiptLink, totalRe, shippingRe, pointsRe } = compileSel(sel, ['receiptLink', 'totalRe', 'shippingRe', 'pointsRe'])
  const detailUrl = (orderId) => fillTemplate(sel.detailUrlTemplate, { orderId })

  // PDF のテキスト化は同梱の pdf.js で行う＝**外部コマンドの事前検査は不要**（tasks 10.2a）
  const page = await firstPage(context, run)
  await openAndSettle(run, page, fillTemplate(sel.ordersUrlTemplate, { year: args.until.slice(0, 4), startIndex: 0 }), 'open-orders')
  await waitLoginStep(run, page, {
    isLoggedIn: async (p) => {
      const body = await p.locator('body').innerText()
      return /注文履歴|注文内容/.test(body) && !/パスワード/.test(body)
    },
    message: 'Amazon にサインインしてください（パスワード/2FA/CAPTCHA は人が入力）',
    args,
    log,
    onWaiting,
    isAborted,
  })

  // 一覧から期間内の orderId を収集（年フィルタ × ページ送り）
  const orderHeads = await run.step('list-orders', async () => {
    const heads = new Map() // orderId → {orderId, orderDate}
    const y0 = parseInt(args.since.slice(0, 4), 10)
    const y1 = parseInt(args.until.slice(0, 4), 10)
    for (let year = y0; year <= y1; year++) {
      for (let startIndex = 0; startIndex < sel.maxStartIndex; startIndex += sel.pageSize) {
        await page.goto(fillTemplate(sel.ordersUrlTemplate, { year, startIndex }), {
          waitUntil: 'domcontentloaded',
        })
        await settle(page)
        const cards = await page.evaluate(
          ({ cardSel, idRe }) => {
            const re = new RegExp(idRe)
            return Array.from(document.querySelectorAll(cardSel)).map((el) => {
              const txt = el.innerText || ''
              const id = re.exec(txt + ' ' + (el.querySelector('a[href*="orderID="]')?.href ?? ''))
              const d = /(20\d\d)年(\d{1,2})月(\d{1,2})日/.exec(txt)
              return { orderId: id?.[1] ?? null, dateRaw: d ? `${d[1]}-${d[2]}-${d[3]}` : null }
            })
          },
          { cardSel: sel.orderCard, idRe: sel.orderIdRe }
        )
        if (!cards.length) break
        for (const c of cards) {
          const orderDate = isoDate(c.dateRaw?.replace(/-/g, '/'))
          if (c.orderId && orderDate) heads.set(c.orderId, { orderId: c.orderId, orderDate })
        }
      }
    }
    const list = [...heads.values()]
      .filter((h) => h.orderDate >= args.since && h.orderDate <= args.until)
      .sort((a, b) => a.orderDate.localeCompare(b.orderDate)) // 古い順（watermark 規約）
    if (!list.length) warnings.push('期間内の注文0件（注文が無いのが正なら問題なし）')
    log(`  期間内 ${list.length} 件`)
    return list
  })

  // 各注文: 詳細HTML（請求額/送料/ポイント）＋ 適格請求書PDF（商品別純額）→ 突合
  const orders = []
  const failedOrders = []
  for (const head of orderHeads) {
    throwIfAborted(isAborted, 'order-detail')
    await run.step(`order-${head.orderId}`, async () => {
      await page.goto(detailUrl(head.orderId), { waitUntil: 'domcontentloaded' })
      await settle(page)
      const body = await page.locator('body').innerText()
      const orderTotal = yen(totalRe.exec(body)?.[1])
      const shipping = yen(shippingRe.exec(body)?.[1]) ?? 0
      const pointsUsed = yen(pointsRe.exec(body)?.[1]) ?? 0
      if (orderTotal == null) {
        failedOrders.push(failedOrder(head, 'ご請求額が読めない（detail ページ構造変化？）'))
        return
      }
      // 領収書等ポップオーバー → 適格請求書PDFリンク収集（発送ごとに複数）。
      // ⚠ **固定スリープにしない**。以前は click → `waitForTimeout(1200)` → 一度だけ走査、で
      //   Playwright 殻では足りていたが Electron 殻ではクリック経路が違って間に合わず、
      //   22注文中19注文が「PDFリンクが見つからない」で落ちた（tasks 4.4）。
      //   「リンクが現れるまで待つ」に直し、押し損ねに備えて数回試す。
      const collectPdfUrls = () =>
        page.evaluate((hrefRe) => {
          const re = new RegExp(hrefRe, 'i')
          return [
            ...new Set(
              Array.from(document.querySelectorAll('a[href]'))
                .map((a) => a.href)
                .filter((h) => re.test(h))
            ),
          ]
        }, sel.invoicePdfHref)

      // トリガ（領収書等）自体の出現も待つ。押せなかったのか、押したが中身が出ないのかは
      // 直し方が違う（前者は詳細ページの構造/描画、後者はポップオーバーの導線）ので、
      // **失敗の理由を分けて返す**。握り潰すと較正のどこを見ればよいか分からなくなる。
      const receipt = page.getByText(receiptLink).first()
      let pdfUrls = []
      let receiptSeen = false
      // ⚠ Electron 殻ではここが**安定しない**（tasks 10.4a）。Playwright 殻は 22/22 通るが、
      //   Electron 殻は同じ手順で 14/22 までしか行けていない。押す回数・待ち時間を振っても
      //   単調に良くならず（3回×3秒=14 / 2回×8秒=5 / 5回×2.5秒=1）、原因は未特定。
      //   下の値は実測で最も良かった組み合わせ。**根拠のない微調整はしないこと**（実サイトを
      //   叩くほど結果が悪化する傾向があり、計測自体が汚れる）。
      for (let attempt = 0; attempt < sel.receiptRetries && !pdfUrls.length; attempt++) {
        receiptSeen = await waitFor(page, () => receipt.isVisible().catch(() => false), {
          timeout: sel.receiptWaitMs,
        })
        if (!receiptSeen) continue
        await clickThrough(page, receipt).catch(() => {})
        pdfUrls = await waitFor(page, collectPdfUrls, { timeout: sel.pdfLinksWaitMs })
      }
      if (!pdfUrls.length) {
        failedOrders.push(
          failedOrder(
            head,
            receiptSeen
              ? '「領収書等」は見えているが適格請求書PDFリンクが現れない（ポップオーバー導線変化？）'
              : '「領収書等」が見つからない（詳細ページの構造変化？描画待ち不足？）'
          )
        )
        return
      }
      const lines = []
      for (let i = 0; i < pdfUrls.length; i++) {
        const res = await context.fetchBinary(pdfUrls[i]) // cookie 認証で取得
        if (!res.ok) {
          failedOrders.push(failedOrder(head, `PDF取得失敗 HTTP ${res.status}`))
          return
        }
        if (evidence.enabled) await evidence.save(`${head.orderId}/inv${i + 1}.pdf`, res.body)
        lines.push(...parseInvoiceItems(await tools.pdfToText(res.body)))
      }
      if (!lines.length) {
        failedOrders.push(failedOrder(head, 'PDFから商品行を抽出できない（parseInvoiceItems の較正要）'))
        return
      }
      const { productLines, shipping: effShipping } = splitShipping(lines, shipping)
      if (!productLines.length) {
        failedOrders.push(failedOrder(head, 'PDFから商品行を抽出できない（配送料行のみ）'))
        return
      }
      // 突合（必須）: 合わなければ verified に入れない（合わせ込みはしない）
      const r = reconcileOrder({ lines: productLines, shipping: effShipping, pointsUsed, orderTotal })
      if (!r.ok) {
        failedOrders.push(failedOrder(head, r.reason))
        return
      }
      const evidenceRef = evidence.ref(head.orderId, detailUrl(head.orderId))
      await saveShot(evidence, page, `${head.orderId}/order.png`)
      orders.push({
        orderId: head.orderId,
        orderDate: head.orderDate,
        orderTotal,
        shipping: effShipping,
        pointsUsed,
        lines: withLineNumbers(productLines, evidenceRef),
      })
      log(`  ${head.orderId} (${head.orderDate}): ${productLines.length}行 突合OK`)
    })
  }

  // orders は突合OKのみ（lines は税込純額）/ failedOrders はスキルが MCP で個別補完する対象
  return finishEcResult(orders, failedOrders, warnings, log)
}
