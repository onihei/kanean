// sites 5本で字面一致していた巡回骨格の共通ステップ（issue #164）。
// ここに置くのは「どのサイトでも同じでなければならない定型」だけで、
// サイト固有の判断（遷移経路・待ち方の特殊条件・検算）は各 sites/*.mjs に残す。
import { ScrapeError } from './errors.mjs'
import { settle, waitForHumanLogin } from './page.mjs'

/** ログイン待ちの既定タイムアウト（秒）。args.loginTimeout で上書き（6箇所に散っていた '480'）。 */
export const DEFAULT_LOGIN_TIMEOUT_SEC = 480

/** args.loginTimeout（文字列）→ 秒数。 */
export function loginTimeoutSec(args) {
  return parseInt(args.loginTimeout ?? String(DEFAULT_LOGIN_TIMEOUT_SEC), 10)
}

/**
 * SEL の正規表現キーを一括コンパイル（`new RegExp(sel.x)` の定型を畳む）。
 * @param {Record<string, unknown>} sel
 * @param {string[]} keys
 * @returns {Record<string, RegExp>}
 */
export function compileSel(sel, keys) {
  return Object.fromEntries(keys.map((k) => [k, new RegExp(sel[k])]))
}

/** 既存の先頭タブ（無ければ新規タブ）を診断対象として登録して返す。 */
export async function firstPage(context, run) {
  const page = context.pages()[0] ?? (await context.newPage())
  run.setPage(page)
  return page
}

/** 「URL を開いて落ち着くまで待つ」ステップ（open-login / open-orders / open-history の定型）。 */
export async function openAndSettle(run, page, url, stepName = 'open-login') {
  await run.step(stepName, async () => {
    await page.goto(url, { waitUntil: 'domcontentloaded' })
    await settle(page)
  })
}

/**
 * 人のログインを待つステップ（10行中9行が同一だった定型）。
 * 判定は `loggedInRe`（本文テキストの正規表現）か、複合条件なら `isLoggedIn` コールバックで渡す。
 */
export async function waitLoginStep(run, page, { loggedInRe, isLoggedIn, message, args, log, onWaiting, isAborted }) {
  const check = isLoggedIn ?? (async (p) => loggedInRe.test(await p.locator('body').innerText()))
  await run.step('wait-login', () =>
    waitForHumanLogin(page, {
      isLoggedIn: check,
      message,
      timeoutSec: loginTimeoutSec(args),
      log,
      onWaiting,
      isAborted,
    })
  )
}

/** 人の操作による中断をループ先頭で検査する（5箇所同一だった定型）。 */
export function throwIfAborted(isAborted, step) {
  if (isAborted?.()) throw new ScrapeError(step, '人の操作で中断された')
}

/** 証跡スクリーンショット（有効時のみ・fullPage。5ファイルに散っていた定型）。 */
export async function saveShot(evidence, page, name) {
  if (!evidence.enabled) return
  await evidence.save(name, await page.screenshot({ fullPage: true }))
}

/**
 * ページ送りリンク（role=link・可視のみ）。無ければ null。
 * 進め方（clickThrough＋settle / click のみ 等）はサイト固有なので呼び出し側が行う。
 */
export async function visibleNextLink(page, nextRe) {
  const next = page.getByRole('link', { name: nextRe }).first()
  if (!(await next.count()) || !(await next.isVisible().catch(() => false))) return null
  return next
}
