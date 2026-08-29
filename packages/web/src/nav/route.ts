import { useMemo, useSyncExternalStore } from 'react'
import { NAV, type TabKey } from './nav.js'

/**
 * ハッシュルーティング（issue #129）。**URL がナビ状態の単一の真実源**。
 *
 * 形式は6つ（元帳はタブ表示に重ねるオーバーレイなので、どのタブから開いたかを
 * タブセグメントで保持する）:
 *   #<tab>
 *   #<tab>/ledger/<accountId>            … 総勘定元帳
 *   #<tab>/ledger/<accountId>/sub/<subId> … 補助元帳（issue #136）
 *   #settings/<section>                   … 設定タブのセクション（issue #136）
 *   #services/<subAccountId>              … 連携サービスの選択（issue #250）
 *   #assets/schedule/<assetId>            … 固定資産の償却スケジュール（issue #250）
 * react-router は使わない: この形数のアプリに宣言的ルータは過剰で、
 * 純関数のコーデック＋ hashchange 購読で足りる。
 *
 * 不正な hash は home へフォールバックする（壊れたリンクで白画面にしない）。
 */

export interface Route {
  tab: TabKey
  /** 総勘定元帳オーバーレイ。タブ内容に重ねて開く（`#<tab>/ledger/<id>`）。 */
  ledgerAccountId?: number
  /** 補助元帳。元帳にさらに重ねる二段目（`#<tab>/ledger/<id>/sub/<subId>`）。 */
  ledgerSubId?: number
  /**
   * 設定タブ内のセクション（`#settings/<section>`）。コーデックは中身を検証しない
   * （キー一覧は SettingsTab が持つ。未知の値はそちらが既定セクションへ倒す）。
   */
  settingsSection?: string
  /** 連携サービスの選択（`#services/<subAccountId>`）。無指定は「確認待ち（全件）」。 */
  serviceSubId?: number
  /** 固定資産の償却スケジュール（`#assets/schedule/<assetId>`）。 */
  assetScheduleId?: number
}

const TAB_KEYS: readonly TabKey[] = NAV.flatMap((group) => group.items.map((item) => item.key))

/** hash → Route。未知のタブは home、壊れた末尾セグメントは解釈できたところまで残して捨てる。 */
export function parseHash(hash: string): Route {
  const [tabPart, ...rest] = hash.replace(/^#/, '').split('/')
  const tab = TAB_KEYS.find((key) => key === tabPart)
  if (!tab) return { tab: 'home' }
  if (rest[0] === 'ledger' && /^[0-9]+$/.test(rest[1] ?? '')) {
    const route: Route = { tab, ledgerAccountId: Number(rest[1]) }
    if (rest[2] === 'sub' && /^[0-9]+$/.test(rest[3] ?? '')) route.ledgerSubId = Number(rest[3])
    return route
  }
  if (tab === 'settings' && rest[0]) return { tab, settingsSection: rest[0] }
  if (tab === 'services' && /^[0-9]+$/.test(rest[0] ?? '')) return { tab, serviceSubId: Number(rest[0]) }
  if (tab === 'assets' && rest[0] === 'schedule' && /^[0-9]+$/.test(rest[1] ?? ''))
    return { tab, assetScheduleId: Number(rest[1]) }
  return { tab }
}

export function formatHash(route: Route): string {
  if (route.ledgerAccountId != null) {
    const base = `#${route.tab}/ledger/${route.ledgerAccountId}`
    return route.ledgerSubId != null ? `${base}/sub/${route.ledgerSubId}` : base
  }
  if (route.tab === 'settings' && route.settingsSection) return `#settings/${route.settingsSection}`
  if (route.tab === 'services' && route.serviceSubId != null) return `#services/${route.serviceSubId}`
  if (route.tab === 'assets' && route.assetScheduleId != null) return `#assets/schedule/${route.assetScheduleId}`
  return `#${route.tab}`
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener('hashchange', onChange)
  return () => window.removeEventListener('hashchange', onChange)
}

/**
 * 現在のルート。getSnapshot は**生の hash 文字列**を返す（parse 結果を返すと毎回新しい
 * オブジェクトになり useSyncExternalStore が無限再描画に陥る）。parse は hash が変わったときだけ。
 */
export function useHashRoute(): Route {
  const hash = useSyncExternalStore(subscribe, () => window.location.hash)
  return useMemo(() => parseHash(hash), [hash])
}

/** 画面遷移。履歴に積む＝ブラウザバックで戻れる。同一ルートなら何も起きない。 */
export function navigate(route: Route): void {
  window.location.hash = formatHash(route)
}

/** 履歴に積まない置換（起動時の正規化・帳簿を閉じたときのリセット用）。search も消す。 */
export function replaceRoute(route: Route): void {
  history.replaceState(null, '', window.location.pathname + formatHash(route))
  // replaceState は hashchange を発火しないので、購読者（useHashRoute）へ自前で知らせる。
  window.dispatchEvent(new HashChangeEvent('hashchange'))
}

/**
 * 旧形式 `?tab=…`（#129 以前のディープリンク）を hash へ読み替える。描画前に1度だけ呼ぶ。
 * 履歴は汚さない（replaceState）。hash が既にあれば hash が勝つ＝新形式が正。
 */
export function normalizeLegacyTabParam(): void {
  const requested = new URLSearchParams(window.location.search).get('tab')
  if (requested === null) return
  replaceRoute(parseHash(window.location.hash || `#${requested}`))
}
