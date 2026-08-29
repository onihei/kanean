// 三菱UFJ-VISA（NEWS+PLUS → My Digital Connect）カード利用明細の巡回手順。
// 取得・正規化・「Σ利用＝新規ご利用額」検算のみ（分類・POST・付替え判断はしない＝再実行安全）。
// 規約（SKILL.md）: 確定請求月のみ。各明細の最古利用日が since 以下に達するまで請求月をさかのぼる。
//
// **実体はここ1箇所だけ**。Playwright 殻（スキル経路）と Electron 殻（アプリ内）の両方がこれを呼ぶ。
import { ScrapeError } from '../core/errors.mjs'
import { yen, isoDate } from '../core/normalize.mjs'
import { settle, findTable, colIndex, POPUP_TIMEOUT_MS } from '../core/page.mjs'
import { compileSel, firstPage, openAndSettle, waitLoginStep, throwIfAborted, saveShot } from '../core/steps.mjs'

export const SOURCE = 'card_mufg_visa'
export const KIND = 'card'
export const EVIDENCE_KEY = 'ufjvisa'
// v2: 新My Digital Connect対応(PC幅強制で.spラベル除去・未確定はH1で除外・新規ご利用額は列index合計)
// v3: 巡回コアを packages/acquisition へ切り出し（挙動は同一）
// v4: 巡回骨格（ログイン待ち・中断/証跡・別タブ待ち定数）を core/steps へ抽出（挙動は同一）
export const SCRIPT = 'ufjvisa@v4'

/**
 * 失敗の粒度（acquisition spec「取得結果の自己検算」・issue #171）。
 * 'all'＝1請求月でも検算が崩れたらその回は全件不成立（throw）。
 * 検算の単位は請求月だが、月単位の部分成功（partial）へ落とすのは spec 変更
 * （「合わなければ投入せず人へ報告する」）が要るため未実施。
 */
export const FAILURE_GRANULARITY = 'all'

// ▼ サイト較正ポイント（壊れたらまずここを疑う）
// 同梱の既定。`$DATA_DIR/acquisition/selectors/card_mufg_visa.json` があればそちらが優先される。
/** `page.goto` へ渡る較正キー。ここに挙げたものだけ http/https を強制する（design D3）。 */
export const NAVIGABLE_KEYS = ['loginUrl']

export const DEFAULT_SEL = {
  loginUrl: 'https://www2.cr.mufg.jp/newsplus/',
  loggedInText: 'ログアウト',
  meisaiLink: 'ご請求額・利用明細照会', // My Digital Connect へ別タブ遷移
  billingLinkHref: 'selectdt=', // 請求月詳細リンク（detail.html?tag=…&selectdt=YYYYMM）
  tableHeaders: ['利用日', '利用金額'],
  colDate: '利用日',
  colDesc: '利用店名|店名|商品名',
  colAmount: '利用金額',
  newUsageLabel: '新規ご利用額', // 月内検算の右辺
  maxMonthsBack: 24, // 暴走ガード
}

export async function scrape({ context, sel, args, run, log, evidence, onWaiting, isAborted }) {
  const warnings = []
  const { loggedInText, meisaiLink } = compileSel(sel, ['loggedInText', 'meisaiLink'])

  let page = await firstPage(context, run)
  await openAndSettle(run, page, sel.loginUrl)
  await waitLoginStep(run, page, {
    loggedInRe: loggedInText,
    message: 'NEWS+PLUS にログインしてください（ID/パスワード/ワンタイムパスワードは人が入力）',
    args,
    log,
    onWaiting,
    isAborted,
  })

  await run.step('open-meisai', async () => {
    // 「ご請求額・利用明細照会」→ My Digital Connect（別タブ）。開いたらそちらを操作対象に。
    const popup = context.waitForEvent('page', { timeout: POPUP_TIMEOUT_MS }).catch(() => null)
    await page.getByRole('link', { name: meisaiLink }).first().click()
    const opened = await popup
    if (opened) {
      page = opened
      run.setPage(page)
    }
    await settle(page, 2500)
  })

  // 請求月一覧を収集。リンクは最新2ヶ月のみ＝古い月は「ご請求月」セレクタ(select[name=selectdt])で辿る。
  // リンクから tag/base を取り、セレクタの全 YYYYMM で selectdt= 直URL を構築する（未確定は詳細ページH1で除外）。
  const months = await run.step('list-billing-months', async () => {
    const links = await page.evaluate((hrefKey) => {
      const out = []
      for (const a of document.querySelectorAll('a[href*="' + hrefKey + '"]')) {
        const m = /selectdt=(\d{6})/.exec(a.href)
        if (m) out.push({ ym: m[1], href: a.href })
      }
      return out
    }, sel.billingLinkHref)
    if (!links.length)
      throw new ScrapeError(
        'list-billing-months',
        '請求月リンク（selectdt=）が見つからない',
        '請求額一覧の page.html で導線を確認して SEL を較正する'
      )
    // 最新リンク月の詳細へ行き、ご請求月セレクタから全月を取得（古い月はリンクが無い）
    const newest = links.sort((a, b) => b.ym.localeCompare(a.ym))[0]
    await page.goto(newest.href, { waitUntil: 'domcontentloaded' })
    await settle(page)
    const allYm = await page.evaluate(() => {
      const set = new Set()
      for (const s of document.querySelectorAll('select')) {
        if (s.name === 'selectdt' || /selectdt/i.test(s.id))
          for (const o of s.options) if (/^\d{6}$/.test(o.value)) set.add(o.value)
      }
      return [...set]
    })
    const base = newest.href.replace(/selectdt=\d{6}.*$/, 'selectdt=')
    const ymList = [...new Set(allYm.length ? allYm : links.map((l) => l.ym))].sort((a, b) =>
      b.localeCompare(a)
    )
    log(`  請求月候補 ${ymList.length}ヶ月（${ymList[ymList.length - 1]}〜${ymList[0]}）`)
    return ymList.slice(0, sel.maxMonthsBack).map((ym) => ({ ym, href: base + ym }))
  })

  // 各請求月: 明細抽出 + 「Σ利用＝新規ご利用額」検算。最古利用日が since に届くまでさかのぼる
  const billingMonths = []
  const txns = []
  await run.step('extract-months', async () => {
    let oldestSeen = null
    for (const m of months) {
      throwIfAborted(isAborted, 'extract-months')
      await page.goto(m.href, { waitUntil: 'domcontentloaded' }) // selectdt 直URL遷移は可（SKILL.md）
      await settle(page)
      // 未確定（締め前）月は確定後に取り込む規約 → 詳細ページ見出し「(未確定分)」で確実に除外
      // （querySelector('h1') は先頭のサイトヘッダ h1 を拾うことがあるので全見出しを textContent で判定）
      const unconfirmed = await page.evaluate(() =>
        Array.from(document.querySelectorAll('h1, h2, h3, title')).some((e) =>
          /未確定/.test(e.textContent || '')
        )
      )
      if (unconfirmed) {
        log(`  ${m.ym}: 未確定分のためスキップ（確定後の再実行で入る）`)
        continue
      }
      const t = await findTable(page, sel.tableHeaders)
      if (!t)
        throw new ScrapeError(
          'extract-months',
          `請求月 ${m.ym}: 明細テーブルが見つからない`,
          'page.html でテーブル構造を確認して SEL.tableHeaders を較正する'
        )
      await saveShot(evidence, page, `${args.until}/${m.ym}.png`)
      const ci = {
        date: colIndex(t.header, sel.colDate),
        desc: colIndex(t.header, sel.colDesc),
        amount: colIndex(t.header, sel.colAmount),
      }
      if (ci.date < 0 || ci.amount < 0)
        throw new ScrapeError(
          'extract-months',
          `請求月 ${m.ym}: カラム同定失敗 ${JSON.stringify(t.header)}`,
          'SEL.col* を実ヘッダに合わせる'
        )
      const monthTxns = []
      for (const cells of t.rows) {
        const txnDate = isoDate(cells[ci.date])
        if (!txnDate) continue // 注記行（海外手数料・内消費税＝日付なし）は本体に内包済み → skip（二重計上回避）
        const amount = yen(cells[ci.amount])
        if (amount == null || amount === 0) continue
        monthTxns.push({
          txnDate,
          amount: Math.abs(amount),
          direction: amount < 0 ? 'in' : 'out', // 返金/キャンセルは in
          description: (cells[ci.desc] ?? '').trim(),
        })
      }
      // 検算: Σ明細（返金は減算）＝ ご利用区分クロス集計表の「新規ご利用額（円）」列の合計。
      // 列ヘッダにラベルがあり値は別行（区分ごと）なので、列indexを特定して縦に合計する。
      const newUsage = await page.evaluate((labelSrc) => {
        const label = new RegExp(labelSrc)
        for (const table of document.querySelectorAll('table')) {
          const rows = Array.from(table.rows).map((r) =>
            Array.from(r.cells).map((c) => (c.innerText || '').replace(/\s+/g, ''))
          )
          if (!rows.length) continue
          const col = rows[0].findIndex((c) => label.test(c))
          if (col < 0) continue // この表のヘッダに新規ご利用額が無い
          let sum = 0
          let found = false
          for (let i = 1; i < rows.length; i++) {
            const n = (rows[i][col] ?? '').replace(/[,，円]/g, '')
            if (/^-?\d+$/.test(n)) {
              sum += parseInt(n, 10)
              found = true
            }
          }
          if (found) return String(sum)
        }
        return null
      }, sel.newUsageLabel)
      const sum = monthTxns.reduce((a, t2) => a + (t2.direction === 'in' ? -t2.amount : t2.amount), 0)
      const expected = yen(newUsage)
      if (expected == null)
        throw new ScrapeError(
          'extract-months',
          `請求月 ${m.ym}: 「新規ご利用額」が見つからない（検算不能）`,
          'ご利用区分テーブルの構造を確認して SEL.newUsageLabel を較正する'
        )
      if (sum !== expected)
        throw new ScrapeError(
          'extract-months',
          `請求月 ${m.ym}: 検算不一致 Σ明細=${sum} ≠ 新規ご利用額=${expected}（取りこぼし/重複/未確定混入を疑う）`,
          '投入はしない。明細ページを人が確認'
        )
      billingMonths.push({ month: m.ym, newUsageTotal: expected, txnCount: monthTxns.length })
      txns.push(...monthTxns)
      const monthOldest = monthTxns.reduce((a, t2) => (a && a < t2.txnDate ? a : t2.txnDate), null)
      oldestSeen = oldestSeen && oldestSeen < monthOldest ? oldestSeen : monthOldest
      log(`  ${m.ym}: ${monthTxns.length}件 Σ=${sum}（検算OK） 最古利用日=${monthOldest ?? '-'}`)
      if (monthOldest && monthOldest <= args.since) break // since まで遡れた
    }
    if (oldestSeen && oldestSeen > args.since)
      warnings.push(
        `確定請求月をさかのぼっても最古利用日 ${oldestSeen} > 要求開始 ${args.since}。それ以前は照会不能か未確定`
      )
  })

  // 利用日の古い順で出力（期間ゲート・dedup は本体が権威適用。範囲は広めに取ってよい規約）
  const inRange = txns
    .filter((t) => t.txnDate >= args.since && t.txnDate <= args.until)
    .sort((a, b) => a.txnDate.localeCompare(b.txnDate))

  log(`OK ${inRange.length}件 / ${billingMonths.length}請求月（月次検算済）`)
  return {
    billingMonths,
    transactions: inRange, // balance なし（カードに残高列はない）
    verification: { monthlyTotalsOk: true, extractedRows: txns.length },
    warnings,
  }
}
