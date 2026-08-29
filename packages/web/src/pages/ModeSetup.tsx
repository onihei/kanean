/**
 * アプリモードの初回選択（app-mode spec「アプリモードの初回選択」）。
 * 役割（「あなたは税理士ですか」）ではなく**行為**で聞く。起動直後の、まだ何も知らない状態で
 * 一番答えやすい問いにする。あとから設定で変えられることも明示する（選び間違いの救済）。
 */
import { COLORS } from '../lib/styles.js'
import { useState } from 'react'
import { api, type AppMode } from '../api.js'
import { APP_MODE_CHOICES } from '../lib/labels.js'

export function ModeSetup({ onDone }: { onDone: (mode: AppMode) => void }) {
  const [busy, setBusy] = useState<AppMode | null>(null)
  const [error, setError] = useState<string | null>(null)

  const choose = (mode: AppMode) => {
    setBusy(mode)
    setError(null)
    api
      .setAppMode(mode)
      .then(onDone)
      .catch((e: Error) => {
        setError(e.message)
        setBusy(null)
      })
  }

  return (
    <main style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ color: COLORS.ok, margin: '0 0 4px' }}>Kanean</h1>
      <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>どちらの使い方をしますか？</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 0 }}>
        起動したときの画面と、表示するメニューが変わります。あとから「各種設定 → アプリモード」でいつでも変更できます。
      </p>
      {error && <p style={{ color: COLORS.error, fontSize: 13 }}>{error}</p>}

      <div style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 20 }}>
        {APP_MODE_CHOICES.map((c) => (
          <button
            key={c.mode}
            onClick={() => choose(c.mode)}
            disabled={busy !== null}
            style={{
              textAlign: 'left',
              border: `1px solid ${COLORS.border}`,
              borderRadius: 8,
              background: COLORS.surface,
              padding: '14px 16px',
              cursor: busy ? 'default' : 'pointer',
              opacity: busy && busy !== c.mode ? 0.5 : 1,
            }}
          >
            <div style={{ fontWeight: 600, fontSize: 15, marginBottom: 4 }}>
              {c.action}
              {busy === c.mode && <span style={{ color: COLORS.muted, fontWeight: 400, marginLeft: 8 }}>設定中…</span>}
            </div>
            <div style={{ color: COLORS.sub, fontSize: 13, lineHeight: 1.6 }}>{c.detail}</div>
          </button>
        ))}
      </div>
    </main>
  )
}
