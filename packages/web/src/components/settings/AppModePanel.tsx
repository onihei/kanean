import { useState } from 'react'
import { api, ApiError, type AppMode } from '../../api.js'
import { COLORS, SECTION, selectableRow } from '../../lib/styles.js'
import { APP_MODE_CHOICES } from '../../lib/labels.js'
import { formatHash } from '../../nav/route.js'

/**
 * アプリモード（app-mode spec）。SettingsTab から分割（issue #153）。
 * 変更は表示と導線の切替であって、データには何もしない。
 * `office → personal` はアクティブが2冊以上だと 409 になるので、帳簿管理へ誘導する。
 */
export function AppModePanel({
  mode,
  onChanged,
}: {
  mode: AppMode
  onChanged: (mode: AppMode) => void
}) {
  const [error, setError] = useState<string | null>(null)
  const [blocked, setBlocked] = useState(false)
  const [busy, setBusy] = useState(false)

  const change = (next: AppMode) => {
    setBusy(true)
    setError(null)
    setBlocked(false)
    api
      .setAppMode(next)
      .then(onChanged)
      .catch((e: unknown) => {
        setError(e instanceof Error ? e.message : String(e))
        if (e instanceof ApiError && e.code === 'books_not_single') setBlocked(true)
      })
      .finally(() => setBusy(false))
  }

  return (
    <section style={SECTION}>
      <h3 style={{ margin: '0 0 8px' }}>アプリモード</h3>
      <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 0 }}>
        起動したときの画面と、表示するメニューが変わります。会計データ・計算結果には影響しません
        （切り替えで帳簿が消えることはありません）。
      </p>
      {error && <p style={{ color: COLORS.error, fontSize: 13 }}>{error}</p>}
      {blocked && (
        <p style={{ fontSize: 13 }}>
          {/* 実アンカー（issue #248）。設定内の帳簿セクションへの単純遷移なので中継プロップは持たない。 */}
          <a href={formatHash({ tab: 'settings', settingsSection: 'books' })} style={{ color: COLORS.accent }}>
            帳簿の管理へ
          </a>
          <span style={{ color: COLORS.sub, marginLeft: 8 }}>
            1冊だけ残して他をアーカイブすると切り替えられます（データは削除されません）。
          </span>
        </p>
      )}
      <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
        {APP_MODE_CHOICES.map((c) => {
          const current = c.mode === mode
          return (
            <label
              key={c.mode}
              style={{ ...selectableRow(current), alignItems: 'flex-start', cursor: busy ? 'default' : 'pointer' }}
            >
              <input
                type="radio"
                name="appMode"
                checked={current}
                disabled={busy}
                onChange={() => change(c.mode)}
                style={{ marginTop: 3 }}
              />
              <span>
                <span style={{ fontWeight: 600, fontSize: 15 }}>{c.label}</span>
                {current && <span style={{ color: COLORS.ok, fontSize: 13, marginLeft: 8 }}>現在のモード</span>}
                <br />
                <span style={{ color: COLORS.sub, fontSize: 13, lineHeight: 1.6 }}>{c.detail}</span>
              </span>
            </label>
          )
        })}
      </div>
    </section>
  )
}
