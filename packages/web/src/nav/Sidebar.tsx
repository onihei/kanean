/** 左サイドナビ（グループ見出し付き）。 */
import { COLORS } from '../lib/styles.js'
import type { AppMode, BookInfo, FiscalYearView } from '../api.js'
import { NAV, type TabKey } from './nav.js'
import { formatHash } from './route.js'

/** "2025-01-01" → "2025年1月1日"（先頭ゼロを落として表記）。 */
function jpDate(iso: string): string {
  const [y, m, d] = iso.split('-')
  return `${y}年${Number(m)}月${Number(d)}日`
}

/** 会計期間の短い表記。同一年なら終端の年を省く: "2025年1月1日〜12月31日"。 */
function fiscalRangeLabel(start: string, end: string): string {
  const [, em, ed] = end.split('-')
  const endStr = start.slice(0, 4) === end.slice(0, 4) ? `${Number(em)}月${Number(ed)}日` : jpDate(end)
  return `${jpDate(start)}〜${endStr}`
}

const GROUP_LABEL: React.CSSProperties = {
  fontSize: 11,
  color: COLORS.muted,
  fontWeight: 600,
  letterSpacing: '0.04em',
  padding: '0 14px',
  margin: '14px 0 4px',
}

export function Sidebar({
  tab,
  mode,
  book,
  onCloseBook,
  fiscalYear,
}: {
  tab: TabKey
  /** アプリモード。じぶんの帳簿では帳簿の切替・作成を出さない（アクティブは常に1冊）。 */
  mode: AppMode
  /** 現在対象の帳簿。 */
  book: BookInfo
  /** 事務所モードのみ。帳簿選択画面へ戻る（切替もこの経路を通る＝黙って切り替わらない）。 */
  onCloseBook?: () => void
  /** 現在開いている会計年度（未取得・未設定なら表示しない）。 */
  fiscalYear: FiscalYearView | null
}) {
  return (
    <aside
      style={{
        width: 220,
        flexShrink: 0,
        background: COLORS.bgSubtle,
        borderRight: `1px solid ${COLORS.border}`,
        display: 'flex',
        flexDirection: 'column',
        position: 'sticky',
        top: 0,
        alignSelf: 'flex-start',
        height: '100vh',
        overflowY: 'auto',
      }}
    >
      <div style={{ padding: '16px 14px 2px', fontWeight: 700, fontSize: 20, color: COLORS.ok }}>Kanean</div>
      {fiscalYear && (
        <div style={{ padding: '0 14px 8px', fontSize: 11, lineHeight: 1.4, color: COLORS.muted }}>
          会計年度 {fiscalYear.startDate.slice(0, 4)}年
          <br />
          <span style={{ color: COLORS.muted }}>{fiscalRangeLabel(fiscalYear.startDate, fiscalYear.endDate)}</span>
        </div>
      )}
      <nav style={{ flex: 1, paddingBottom: 12 }}>
        {NAV.map((g) => (
          <div key={g.group || '_home'}>
            {g.group && <div style={GROUP_LABEL}>{g.group}</div>}
            {g.items.map((it) => (
              // 実アンカー（issue #248）。セグメントを付けない `#<tab>` へ飛ぶ＝タブ遷移で元帳等を閉じる。
              <a key={it.key} href={formatHash({ tab: it.key })} className={tab === it.key ? 'nav-item active' : 'nav-item'}>
                {it.label}
              </a>
            ))}
          </div>
        ))}
      </nav>
      <div style={{ padding: '10px 14px', borderTop: `1px solid ${COLORS.border}`, fontSize: 13, color: COLORS.muted }}>
        <div style={{ marginBottom: 4, color: COLORS.muted, fontSize: 11 }}>帳簿</div>
        <div style={{ color: COLORS.sub, fontWeight: mode === 'office' ? 600 : 400 }}>{book.name}</div>
        {/* 事務所モードのみ切替を出す。select で黙って切り替えるのではなく帳簿選択画面へ戻す
            ＝どの顧問先を開いているかを毎回意識させる（web-app spec）。 */}
        {mode === 'office' && onCloseBook && (
          <button
            onClick={onCloseBook}
            className="btn"
            style={{ borderColor: COLORS.border, marginTop: 6, width: '100%', fontSize: 13, padding: '3px 4px' }}
          >
            帳簿を切り替える
          </button>
        )}
      </div>
    </aside>
  )
}
