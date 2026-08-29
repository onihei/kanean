// 三菱UFJ銀行（三菱UFJダイレクト）入出金明細の巡回手順。
// 取得・正規化・残高チェーン検算のみ（分類・POSTはしない＝再実行安全）。
// セレクタが古くなったら**この SEL を較正データとして差し替える**（アプリの更新は要らない）。
//
// 三菱UFJダイレクトは Angular SPA（ログイン後 directg.s.bk.mufg.jp）。formcontrolname ベースの id で同定。
import { ScrapeError } from '../core/errors.mjs'
import { bankColumns, buildBankTxns, verifyAndClamp } from '../core/bankRows.mjs'
import { settle, dismissOverlays, clickThrough, findTable, waitFor } from '../core/page.mjs'
import {
  compileSel,
  firstPage,
  openAndSettle,
  waitLoginStep,
  throwIfAborted,
  saveShot,
  visibleNextLink,
} from '../core/steps.mjs'

export const SOURCE = 'bank_ufj'
export const KIND = 'bank'
export const EVIDENCE_KEY = 'mufg'
// v2: 新Angular SPA(directg)対応＝期間指定selectOption＋input[type=date]＋#bt-inquiry、KARTEモーダル除去、結果テーブル即ポーリング
// v3: 巡回コアを packages/acquisition へ切り出し（挙動は同一）
// v4: 正規化・検算を core/bankRows へ抽出（挙動は同一・単体テスト対象化）
// v5: 巡回骨格（ログイン待ち・ページ送り・中断/証跡）を core/steps へ抽出（挙動は同一）
// v6: 結果テーブル待ち（12s×300ms）を SEL 化（既定値は従来と同値。update_site_calibration で振れる）
export const SCRIPT = 'mufg@v6'

/**
 * 失敗の粒度（acquisition spec「取得結果の自己検算」・issue #171）。
 * 'all'＝1箇所でも検算が崩れたらその回は全件不成立（throw。部分成功は存在しない）。
 * 銀行は残高チェーンが生命線＝欠けた明細を黙って混ぜられない。
 */
export const FAILURE_GRANULARITY = 'all'

// ▼ サイト較正ポイント（壊れたらまずここを疑う）
/** `page.goto` へ渡る較正キー。 */
export const NAVIGABLE_KEYS = ['loginUrl']

export const DEFAULT_SEL = {
  loginUrl: 'https://entry11.bk.mufg.jp/ibg/dfw/APLIN/loginib/login?_TRANID=AA000_001', // ログイン後 directg へ遷移
  loggedInText: 'ログアウト', // ログイン済み判定（ページ内テキスト）
  meisaiLink: '入出金明細', // 明細照会への導線リンク
  periodSelect: '#sl-period', // 期間区分(formcontrolname=inquireKikanKubun)
  periodSpecifyValue: '5', // 期間指定（これを選ぶと日付欄が出現）
  startDate: '#tx-start-date', // input[type=date] kaishiBi（値=YYYY-MM-DD）
  endDate: '#tx-end-date', // input[type=date] syuuryouBi
  filterTypeSelect: '#sl-filter-type', // 取引種類(torihikiShurui) 1=全取引
  filterTypeAll: '1',
  countSelect: '#sl-filter-number', // 表示件数(hyoujiKensuu) 100=最大
  countMax: '100',
  inquireBtn: '#bt-inquiry', // 照会/適用ボタン（ラベルは「条件を変更」だが id=inquiry）
  nextPage: '次の|次へ', // ページ送り
  // 明細テーブルの必須ヘッダ（新Angular: 日付/お支払い/お預かり/取引内容/残高）
  tableHeaders: ['日付', '残高'],
  colDate: '日付|取引日|年月日',
  colOut: '支払|出金|引出',
  colIn: '預|入金',
  colBalance: '残高',
  colDesc: '摘要|取引内容',
  maxPages: 50,
  // 照会結果（Angular 非同期描画）のテーブル出現待ち。既定は従来の 40×300ms と同値。
  // ⚠ 根拠のない微調整はしないこと — 振るなら update_site_calibration（実機計測）で。
  tableWaitMs: 12000,
  tablePollMs: 300,
}

export async function scrape({ context, sel, args, run, log, evidence, onWaiting, isAborted }) {
  const warnings = []
  const { loggedInText, meisaiLink, nextPage } = compileSel(sel, ['loggedInText', 'meisaiLink', 'nextPage'])

  const page = await firstPage(context, run)
  await openAndSettle(run, page, sel.loginUrl)
  await waitLoginStep(run, page, {
    loggedInRe: loggedInText,
    message: '三菱UFJダイレクトにログインしてください（ID/パスワード/ワンタイムパスワードは人が入力）',
    args,
    log,
    onWaiting,
    isAborted,
  })

  await run.step('open-meisai', async () => {
    // KARTE等のキャンペーンモーダルがクリックを奪う。clickThrough は閉じきれなくても下の要素を確実に押す。
    const link = page.getByRole('link', { name: meisaiLink }).first()
    const target = (await link.count()) ? link : page.getByText(meisaiLink).first()
    await clickThrough(page, target)
    await settle(page)
  })

  await run.step('set-period', async () => {
    await dismissOverlays(page)
    // 期間区分=期間指定（Angular: selectOption で input/change が正しく発火）→ 日付欄が出現
    await page.locator(sel.periodSelect).selectOption(sel.periodSpecifyValue)
    await settle(page, 600)
    await dismissOverlays(page)
    const start = page.locator(sel.startDate)
    const end = page.locator(sel.endDate)
    if (!(await start.count()) || !(await end.count()))
      throw new ScrapeError(
        'set-period',
        `日付欄が見つからない（${sel.startDate}/${sel.endDate}）`,
        '期間指定選択後のDOMを確認して SEL を較正する'
      )
    // input[type=date] は値が YYYY-MM-DD。fill で input が発火し Angular のモデルへ反映される。
    // 入力の min/max は実質無制限（0001-9999）＝期間はクランプされない。5.5ヶ月一括照会OKを確認済み。
    await start.fill(args.since)
    await end.fill(args.until)
    // 表示件数を最大(100)・取引種類を全取引(1)に
    await page.locator(sel.countSelect).selectOption(sel.countMax).catch(() => {})
    await page.locator(sel.filterTypeSelect).selectOption(sel.filterTypeAll).catch(() => {})
    await clickThrough(page, page.locator(sel.inquireBtn)) // オーバーレイ貫通
    await settle(page)
  })

  // 明細テーブル抽出（ページ送りしながら全件）
  const rawRows = []
  await run.step('extract-table', async () => {
    for (let pageNo = 1; pageNo <= sel.maxPages; pageNo++) {
      throwIfAborted(isAborted, 'extract-table')
      // 結果は Angular が非同期描画する → テーブル出現まで即ポーリング（固定 settle のレース回避）
      const t = await waitFor(page, () => findTable(page, sel.tableHeaders), { timeout: sel.tableWaitMs, interval: sel.tablePollMs })
      if (!t) {
        // 診断: 結果領域の構造をダンプして SEL.tableHeaders/col* 較正の材料にする
        const d = await page.evaluate(() => ({
          tables: Array.from(document.querySelectorAll('table')).map((tb, i) => ({
            i,
            cls: tb.className,
            head: tb.rows[0]
              ? Array.from(tb.rows[0].cells).map((c) =>
                  (c.innerText || '').replace(/\s+/g, ' ').trim()
                )
              : [],
            rows: tb.rows.length,
          })),
          grids: Array.from(
            document.querySelectorAll(
              '[role="table"],[role="grid"],[class*="meisai" i],[class*="meisaiList" i]'
            )
          )
            .slice(0, 4)
            .map((e) => ({
              tag: e.tagName.toLowerCase(),
              cls: e.className,
              txt: (e.innerText || '').replace(/\s+/g, ' ').slice(0, 240),
            })),
        }))
        log('result tables:\n' + JSON.stringify(d.tables, null, 1))
        log('result grids:\n' + JSON.stringify(d.grids, null, 1))
        throw new ScrapeError(
          'extract-table',
          '明細テーブルが見つからない（ヘッダ: 日付/残高）',
          '上のダンプを確認して SEL.tableHeaders/col* を実ヘッダに較正する'
        )
      }
      await saveShot(evidence, page, `${args.until}/page-${pageNo}.png`)
      const ci = bankColumns(t.header, sel) // 出金・入金はどちらか一方あればよい
      rawRows.push(...t.rows.map((cells) => ({ cells, ci })))
      const next = await visibleNextLink(page, nextPage)
      if (!next) break
      await clickThrough(page, next)
      await settle(page)
    }
  })

  // 正規化（年は「YYYY年」見出しから引き継ぎ）→ 古い順 → 残高チェーン検算 → 期間フィルタ
  const result = await run.step('normalize-verify', async () => {
    const txns = buildBankTxns(rawRows, { yearHint: true })
    // 表示順が新しい順なら DOM 順のまま反転（reverse:'auto'。日付ソートはしない＝同日内順序を保つ）
    return verifyAndClamp(txns, args, warnings, {
      reverse: 'auto',
      chainHint: '並び順（同日内逆順）か抽出漏れを疑う。投入はしない',
      clampSuffix: '。未照会期間は手動CSV等で補完',
    })
  })

  log(`OK ${result.txns.length}件（検算済）`)
  return {
    transactions: result.txns,
    verification: { balanceChainOk: true, extractedRows: result.allCount },
    warnings,
  }
}
