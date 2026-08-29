// 巡回ページの共通操作。**実行殻の契約（BROWSER_API）だけ**に依存するので、
// Playwright 殻でも Electron 殻でも同じコードが動く（design D2）。

import { ScrapeError } from './errors.mjs'

/**
 * サイトスクリプトが使ってよい API の全量。殻を足すときはこれを満たせばよい。
 * 実装漏れを型ではなくテストで縛るため、名前をデータとして持つ。
 */
export const BROWSER_API = {
  context: ['pages', 'newPage', 'waitForEvent', 'close', 'fetchBinary'],
  page: [
    'goto',
    'evaluate',
    'locator',
    'getByRole',
    'getByText',
    'screenshot',
    'waitForTimeout',
    'waitForLoadState',
    'url',
    'content',
    'context',
  ],
  locator: [
    'first',
    'locator',
    'getByRole',
    'getByText',
    'click',
    'count',
    'innerText',
    'isVisible',
    'fill',
    'selectOption',
    'press',
    'pressSequentially',
    'dispatchEvent',
  ],
}

// ナビゲーション後の落ち着き待ち（networkidle はポーリングで永久に来ないサイトがあるので使わない）
export async function settle(page, ms = 1500) {
  await page.waitForLoadState('load').catch(() => {})
  await page.waitForTimeout(ms)
}

// KARTE 等のキャンペーンモーダル/オーバーレイがクリックを奪う（pointer events を横取り）ことがある。
// 閉じるボタンを試し、残ったオーバーレイは非表示＋pointer-events無効化してクリックを下へ通す。
// 間欠的に出るのでクリック前に都度呼ぶ想定（オーバーレイ無しなら何もしない・安全）。
const OVERLAY_SEL =
  '#karte-c, [id^="karte"], [class*="karte"], .modal-overlay, .overlay-bg, [class*="campaign" i]'
export async function dismissOverlays(page) {
  try {
    for (const sel of [
      '#karte-c [class*="close" i]',
      '#karte-c [aria-label*="閉じる"]',
      '#karte-c [aria-label*="close" i]',
      '[id^="karte"] [class*="close" i]',
    ]) {
      const btn = page.locator(sel).first()
      if ((await btn.count()) && (await btn.isVisible().catch(() => false))) {
        await btn.click({ timeout: 2000 }).catch(() => {})
        await page.waitForTimeout(300)
      }
    }
    await page.evaluate((sel) => {
      for (const el of document.querySelectorAll(sel + ', iframe[src*="karte" i]')) {
        el.style.pointerEvents = 'none'
        el.style.display = 'none'
      }
    }, OVERLAY_SEL)
  } catch {
    // オーバーレイ無し or 評価不可なら無視
  }
}

// オーバーレイ（KARTE等）が pointer events を奪っても確実に押すクリック。
// 通常クリック→ダメなら要素へ直接 click を dispatch（座標ヒットテストを経由しないので
// モーダルが上に乗っていても下の要素のハンドラ/遷移が発火する）。Angular の (click) にも有効。
export async function clickThrough(page, locator, { timeout = 3000 } = {}) {
  await dismissOverlays(page).catch(() => {})
  try {
    await locator.click({ timeout })
  } catch {
    await locator.dispatchEvent('click')
  }
}

/**
 * 「別タブが開くのを待つ」共通タイムアウト（issue #164 で 15s/20s/20s の不揃いを統一）。
 * 開かなければ null＝同一タブ遷移だった、という扱いに落ちるだけなので長め側に揃える。
 */
export const POPUP_TIMEOUT_MS = 20_000

/**
 * `probe()` が中身のある値を返すまで待ち、その値を返す（時間切れなら最後の値）。
 *
 * **固定スリープの代わりに使う。** 殻によって描画が間に合う速さが違う（design D2）。
 * Playwright 殻で足りていた `waitForTimeout(N)` が Electron 殻では足りない、という形の
 * 取りこぼしを実際に踏んだ（Amazon の領収書ポップオーバー: 22注文中19注文が空振り）。
 * 「N ミリ秒待つ」ではなく「欲しいものが出るまで待つ」と書けば、殻の速さに依らなくなる。
 *
 * @template T
 * @param {object} page
 * @param {() => Promise<T>} probe
 * @returns {Promise<T>}
 */
export async function waitFor(page, probe, { timeout = 8000, interval = 250 } = {}) {
  const deadline = Date.now() + timeout
  for (;;) {
    const value = await probe()
    if (Array.isArray(value) ? value.length > 0 : value) return value
    if (Date.now() >= deadline) return value
    await page.waitForTimeout(interval)
  }
}

// ログイン/2FA は人がヘッドフル窓で行う。スクリプトは isLoggedIn() が真になるまで待つだけ。
// **認証情報はこの関数を含めどこにも渡らない**（人がブラウザへ直接入力する。acquisition spec）。
export async function waitForHumanLogin(
  page,
  { isLoggedIn, message, timeoutSec = 480, log = console.log, onWaiting, isAborted }
) {
  if (await isLoggedIn(page).catch(() => false)) return
  log(`⏸ ${message}（完了すると自動で続行します。最大 ${timeoutSec} 秒待ちます）`)
  await onWaiting?.(message)
  const deadline = Date.now() + timeoutSec * 1000
  while (Date.now() < deadline) {
    await page.waitForTimeout(3000)
    if (isAborted?.()) throw new ScrapeError('login', '人の操作で中断された')
    if (await isLoggedIn(page).catch(() => false)) {
      log('✔ ログインを確認。続行します')
      return
    }
  }
  throw new ScrapeError('login', `ログイン待ちタイムアウト（${timeoutSec}秒）`)
}

// ---------- テーブル抽出（ヘッダ名でカラム同定＝レイアウト微変更に強い） ----------

// requiredHeaders: 正規表現ソース文字列の配列。全部を満たす最初の <table> を返す。
// 戻り値: { tableIndex, header: string[], rows: string[][] } | null
export async function findTable(page, requiredHeaders) {
  return await page.evaluate((reqs) => {
    const regs = reqs.map((s) => new RegExp(s))
    const tables = Array.from(document.querySelectorAll('table'))
    for (let ti = 0; ti < tables.length; ti++) {
      const rows = Array.from(tables[ti].rows).map((r) =>
        Array.from(r.cells).map((c) => (c.innerText || '').replace(/\s+/g, ' ').trim())
      )
      if (!rows.length) continue
      // ヘッダ行 = 必須ヘッダを最も多く含む行（先頭5行から探す）
      let hi = -1
      let best = 0
      for (let i = 0; i < Math.min(rows.length, 5); i++) {
        const hit = regs.filter((re) => rows[i].some((c) => re.test(c))).length
        if (hit > best) {
          best = hit
          hi = i
        }
      }
      if (hi < 0 || best < regs.length) continue
      return { tableIndex: ti, header: rows[hi], rows: rows.slice(hi + 1) }
    }
    return null
  }, requiredHeaders)
}

export function colIndex(header, pattern) {
  const re = new RegExp(pattern)
  return header.findIndex((h) => re.test(h))
}
