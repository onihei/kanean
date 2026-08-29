// SBI新生銀行（新生パワーダイレクト）入出金明細の巡回手順。
// 取得・正規化・残高チェーン検算のみ（分類・POSTはしない＝再実行安全）。
// ⚠ パワーダイレクトは AngularJS SPA。直URL遷移は CME0042 でセッションが切れる → 必ずクリック遷移。
// ⚠ 表示は新しい順・同一日内も逆時系列 → DOM 行をそのまま .reverse()（日付ソート禁止）。
import { ScrapeError } from '../core/errors.mjs'
import { bankColumns, buildBankTxns, verifyAndClamp } from '../core/bankRows.mjs'
import { settle, findTable, POPUP_TIMEOUT_MS } from '../core/page.mjs'
import { compileSel, firstPage, waitLoginStep, throwIfAborted, saveShot, visibleNextLink } from '../core/steps.mjs'

export const SOURCE = 'bank_shinsei'
export const KIND = 'bank'
export const EVIDENCE_KEY = 'shinsei'
// v4: 日付はキー入力(.fill不可)＋照会後は即ポーリング(settle禁止=安定条件)＋稀なTOPバウンス時のみ再照会(最大4回)＋ページ送り対応
// v5: 巡回コアを packages/acquisition へ切り出し（挙動は同一）
// v6: 正規化・検算を core/bankRows へ抽出（挙動は同一・単体テスト対象化）
// v7: 巡回骨格を core/steps へ抽出・別タブ待ちを POPUP_TIMEOUT_MS(20s) に統一（従来15s）
// v8: 照会結果ポーリング（50×200ms・安定待ち250ms）を SEL 化（既定値は従来と同値。update_site_calibration で振れる）
export const SCRIPT = 'shinsei@v8'

/**
 * 失敗の粒度（acquisition spec「取得結果の自己検算」・issue #171）。
 * 'all'＝1箇所でも検算が崩れたらその回は全件不成立（throw。部分成功は存在しない）。
 * 銀行は残高チェーンが生命線＝欠けた明細を黙って混ぜられない。
 */
export const FAILURE_GRANULARITY = 'all'

// ▼ サイト較正ポイント（壊れたらまずここを疑う）
/** `page.goto` へ渡る較正キー。`activityUrl` は URL の照合にしか使わないので含めない。 */
export const NAVIGABLE_KEYS = ['topUrl']

export const DEFAULT_SEL = {
  topUrl: 'https://www.sbishinseibank.co.jp/',
  loginLink: 'ログイン',
  loggedInText: 'ログアウト',
  meisaiLink: '入出金明細', // ログイン後TOPからクリック遷移（直URL禁止）
  activityUrl: '/account/activity', // 入出金明細ページのURL（TOPバウンス検出に使う）
  pastInquiry: '過去の入出金明細を照会',
  periodChoice: '期間を指定する',
  beginDate: '#beginDate', // YYYY/MM/DD
  endDate: '#endDate',
  inquireButton: '照会',
  nextPage: '次へ|次の|>',
  tableHeaders: ['取引日', '摘要', '残高'],
  colDate: '取引日',
  colOut: '出金',
  colIn: '入金',
  colBalance: '残高',
  colDesc: '摘要',
  colMemo: 'メモ',
  maxPages: 50,
  maxInquiryRetries: 4,
  // 照会結果のポーリング（waitTableReplaced）。既定は検証済みの従来値（50回×200ms・安定待ち250ms）。
  // ⚠ 根拠のない微調整はしないこと — 振るなら update_site_calibration（実機計測）で。
  resultPollTries: 50,
  resultPollMs: 200,
  resultSettleMs: 250,
}

// 照会結果が prevSig（照会前の表示）から変化し、行数が安定するまで待って返す。
// 照会直後から settle を挟まず即ポーリングするのが安定の条件（検証済み）。
// 稀にパワーダイレクトが結果表示後ダッシュボードへ自動遷移する（非決定的）。その時は url が
// /account/activity から外れるので { bounced:true } を即返し、呼び出し側が照会をやり直す。
// 戻り値: { table } | { bounced:true } | { timeout:true }
async function waitTableReplaced(page, sel, prevSig, activityRe) {
  for (let i = 0; i < sel.resultPollTries; i++) {
    if (!activityRe.test(page.url())) return { bounced: true }
    const t = await findTable(page, sel.tableHeaders).catch(() => null)
    if (t && JSON.stringify(t.rows) !== prevSig) {
      await page.waitForTimeout(sel.resultSettleMs) // 描画途中を掴まないよう一拍おいて安定側を採用
      if (!activityRe.test(page.url())) return { bounced: true }
      const t2 = await findTable(page, sel.tableHeaders).catch(() => null)
      return { table: t2 && t2.rows.length >= t.rows.length ? t2 : t }
    }
    await page.waitForTimeout(sel.resultPollMs)
  }
  return { timeout: true }
}

export async function scrape({ context, sel, args, run, log, evidence, onWaiting, isAborted }) {
  const warnings = []
  const { loggedInText, loginLink, meisaiLink, activityUrl, pastInquiry, periodChoice, inquireButton, nextPage } =
    compileSel(sel, ['loggedInText', 'loginLink', 'meisaiLink', 'activityUrl', 'pastInquiry', 'periodChoice', 'inquireButton', 'nextPage'])

  let page = await firstPage(context, run)

  await run.step('open-login', async () => {
    await page.goto(sel.topUrl, { waitUntil: 'domcontentloaded' })
    await settle(page)
    // すでにログイン済み（保存プロファイル）でなければ、人にログインリンクから入ってもらう
    if (!loggedInText.test(await page.locator('body').innerText())) {
      const popup = context.waitForEvent('page', { timeout: POPUP_TIMEOUT_MS }).catch(() => null)
      await page
        .getByRole('link', { name: loginLink })
        .first()
        .click()
        .catch(() => {})
      const opened = await popup
      if (opened) {
        page = opened
        run.setPage(page)
        await settle(page)
      }
    }
  })

  await waitLoginStep(run, page, {
    loggedInRe: loggedInText,
    message: '新生パワーダイレクトにログインしてください（暗証番号/セキュリティカード等は人が入力）',
    args,
    log,
    onWaiting,
    isAborted,
  })

  await run.step('open-meisai', async () => {
    // SPA: クリック遷移のみ（browser back/直URLは CME0042）
    await page.getByRole('link', { name: meisaiLink }).first().click()
    await settle(page)
  })

  // 照会→即ポーリング取得。稀なTOPバウンス時のみ照会をやり直す（最大4回）。ページ送りも対応。
  const rawRows = []
  await run.step('inquire-extract', async () => {
    const since = args.since.replaceAll('-', '/')
    const until = args.until.replaceAll('-', '/')
    let done = false
    for (let attempt = 1; attempt <= sel.maxInquiryRetries && !done; attempt++) {
      throwIfAborted(isAborted, 'inquire-extract')
      rawRows.length = 0 // 再試行時は前回分を捨てる

      // (a) 入出金明細ページにいることを保証（バウンス後はTOPにいるのでメニューで戻る）
      if (!activityUrl.test(page.url())) {
        await page
          .getByRole('link', { name: meisaiLink })
          .first()
          .click()
          .catch(() => {})
        await settle(page)
      }

      // (b) 期間指定（人と同じ操作: ラジオは click で選択 → 日付はキー入力で ng-keyup を発火）
      const past = page.getByText(pastInquiry).first()
      if (await past.count()) {
        await past.click()
        await settle(page)
      }
      const choice = page.getByText(periodChoice).first()
      if (await choice.count()) await choice.click().catch(() => {})
      await settle(page, 600)
      const begin = page.locator(sel.beginDate)
      const end = page.locator(sel.endDate)
      if (!(await begin.count()) || !(await end.count()))
        throw new ScrapeError(
          'set-period',
          `日付欄が見つからない（${sel.beginDate}/${sel.endDate}）`,
          'page.html で実セレクタを確認して SEL を較正する'
        )
      // ⚠ 日付は必ずキー入力（pressSequentially）。.fill() は ng-keyup/入力フィルタを発火させない。
      for (const [loc, val] of [
        [begin, since],
        [end, until],
      ]) {
        await loc.click()
        await loc.fill('')
        await loc.pressSequentially(val, { delay: 40 })
        await loc.press('Tab')
      }

      // (c) 照会前の表示の指紋を控え、照会。⚠ 照会後は settle を挟まず即ポーリングするのが安定の条件（検証済み）。
      let prevSig = JSON.stringify(
        (await findTable(page, sel.tableHeaders).catch(() => null))?.rows ?? null
      )
      await page.getByRole('button', { name: inquireButton }).first().click()

      // (d) 結果を即ポーリングで取得（ページ送りがあれば全ページ）。途中TOPへバウンスしたら破棄して再照会。
      let bounced = false
      for (let pageNo = 1; pageNo <= sel.maxPages; pageNo++) {
        const r = await waitTableReplaced(page, sel, prevSig, activityUrl)
        if (r.bounced) {
          bounced = true
          break
        }
        if (!r.table) {
          // prevSig から変化せずタイムアウト。1ページ目なら照会未反映＝取り直し、2ページ目以降は末尾とみなす
          if (pageNo === 1) bounced = true
          break
        }
        const t = r.table
        prevSig = JSON.stringify(t.rows)
        await saveShot(evidence, page, `${args.until}/page-${pageNo}.png`)
        // メモ列は摘要へ連結（無ければ無視）。出金・入金は両列必須。
        const ci = bankColumns(t.header, sel, { memo: true, requireBoth: true })
        rawRows.push(...t.rows.map((cells) => ({ cells, ci })))
        const next = await visibleNextLink(page, nextPage)
        if (!next) break
        await next.click() // ページ送りもクリックのみ（次ページは prevSig 差分で待つ）
      }

      if (!bounced && rawRows.length) done = true
      else if (attempt < sel.maxInquiryRetries)
        log(
          `⏳ 照会結果表示後にダッシュボードへ戻りました（パワーダイレクトの非決定的挙動）。照会を再試行します（${attempt + 1}/${sel.maxInquiryRetries}）`
        )
    }
    if (!done)
      throw new ScrapeError(
        'inquire-extract',
        `照会結果を取得できず（TOPバウンスを${sel.maxInquiryRetries}回再試行）`,
        '時間をおいて再実行。続く場合は照会フロー/セレクタを確認'
      )
  })

  const result = await run.step('normalize-verify', async () => {
    const txns = buildBankTxns(rawRows)
    // 新生は新しい順表示＝DOM 行をそのまま反転（reverse:'always'。同一日内も逆時系列なので日付ソートは厳禁）
    return verifyAndClamp(txns, args, warnings, {
      reverse: 'always',
      chainHint: 'まず並び順（同日内逆順＝DOM反転）を疑う。投入はしない',
      clampSuffix: '（照会可能は前々年同月まで）。未照会期間は手動CSVで補完',
    })
  })

  log(`OK ${result.txns.length}件（検算済）`)
  return {
    transactions: result.txns,
    verification: { balanceChainOk: true, extractedRows: result.allCount },
    warnings,
  }
}
