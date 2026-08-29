/** 金額・割合・サイズ・期間の表示フォーマットユーティリティ。 */
import { COLORS } from './styles.js'
import type { FiscalYearView } from '../api.js'

export const yen = (n: number) => `¥${n.toLocaleString()}`

export const fmtPct = (p: number | null) => (p == null ? '—' : `${p > 0 ? '+' : ''}${p}%`)
export const deltaColor = (n: number) => (n > 0 ? COLORS.ok : n < 0 ? COLORS.error : COLORS.muted)
export const signedYen = (n: number) => `${n > 0 ? '+' : ''}${yen(n)}`

export const fmtSize = (n: number | null) =>
  n == null ? '' : n < 1024 ? `${n}B` : n < 1024 * 1024 ? `${(n / 1024).toFixed(1)}KB` : `${(n / 1024 / 1024).toFixed(1)}MB`

/** 月（YYYY-MM）→ その月の初日/末日。 */
export function monthBounds(ym: string): { from: string; to: string } {
  const [y, m] = ym.split('-').map(Number)
  const last = new Date(y, m, 0).getDate()
  return { from: `${ym}-01`, to: `${ym}-${String(last).padStart(2, '0')}` }
}

export const fyLabel = (y: FiscalYearView) =>
  `${y.startDate.slice(0, 4)}年度（${y.startDate}〜${y.endDate}）${y.status === 'open' ? ' ※当期' : ''}`

/** 一覧行の日付整形が参照する会計年度（範囲だけあればよい）。 */
export type DateScope = Pick<FiscalYearView, 'startDate' | 'endDate'> | null

/**
 * 日付が開いている会計年度に属するか（ISO 日付の辞書順比較。サーバの会計期間ゲートと同じ方式）。
 * 会計年度が未取得なら false（属すると言い切らない）。
 *
 * 表示（年を省くか）と操作の可否（過年度の行は復帰できない・[[web-app]]「取込明細の年スコープ」）の
 * 両方がこの判定を使う。式が2つあると片方だけ直る。
 */
export function inScope(iso: string, fy: DateScope): boolean {
  return fy != null && iso >= fy.startDate && iso <= fy.endDate
}

/**
 * 一覧行の日付（[[web-app]]「一覧行の表記規則」）。
 *
 * 開いている会計年度の範囲内なら年を省いて `MM-DD`、範囲外なら年付き `YYYY-MM-DD` を返す。
 * 仕訳帳・確認待ちはサーバが会計年度1つに閉じている（withOpenYear）ので常に `MM-DD` になり、
 * 取込明細では「過年度も表示」したときに過年度の行だけが年付きで浮かび上がる。**年を消した結果として
 * 例外が目立つ**のが狙いで、画面ごとに年の要否を固定しないのはこのため。
 *
 * 会計年度が未取得のときは省略せず全部出す（省いて嘘をつくより長い方に倒す）。
 */
export function listDate(iso: string, fy: DateScope): string {
  return inScope(iso, fy) ? iso.slice(5) : iso
}
