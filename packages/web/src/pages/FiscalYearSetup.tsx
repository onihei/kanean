/** 初回セットアップ: 対象の会計年度を明示的に選んでもらう全画面ゲート。
 *  年度がまだ無いユーザーにだけ表示し、確定するまで本体に入れない。 */
import { COLORS } from '../lib/styles.js'
import { useEffect, useState } from 'react'
import { api } from '../api.js'

const SHELL: React.CSSProperties = { padding: 32, maxWidth: 640, margin: '0 auto' }
const CARD: React.CSSProperties = { border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '20px 22px' }
const HINT: React.CSSProperties = { background: COLORS.bgSubtle, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '10px 12px', color: COLORS.sub, fontSize: 13, margin: '0 0 16px' }
const NOTE: React.CSSProperties = { color: COLORS.muted, fontSize: 13, margin: '14px 0 0' }
const PRIMARY: React.CSSProperties = { border: `1px solid ${COLORS.ok}`, borderRadius: 'var(--rad-m)', background: COLORS.ok, color: '#fff', padding: '8px 16px', cursor: 'pointer', fontSize: 13 }
const SELECT: React.CSSProperties = { padding: '6px 8px', fontSize: 13, marginLeft: 8 }

export function FiscalYearSetup({ onDone }: { onDone: () => void }) {
  const [year, setYear] = useState<number | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState<string | null>(null)

  useEffect(() => {
    api.suggestedFiscalYear()
      .then(setYear)
      .catch(() => setYear(new Date().getFullYear()))
  }, [])

  const submit = async () => {
    if (year == null) return
    setBusy(true)
    setErr(null)
    try {
      await api.createInitialFiscalYear(year)
      onDone()
    } catch (e) {
      setErr((e as Error).message)
      setBusy(false)
    }
  }

  // 推奨年を中心に前後を選べるように（早めに当年から始めたい人向けに +1 も用意）。
  const choices = year == null ? [] : [year + 1, year, year - 1, year - 2, year - 3]

  return (
    <main style={SHELL}>
      <h1>Kanean</h1>
      <section style={CARD}>
        <h2 style={{ margin: '0 0 10px' }}>会計年度の設定</h2>
        <p style={{ margin: '0 0 12px' }}>
          最初に処理する <b>対象年度</b> を選んでください。個人事業の会計は暦年（1/1〜12/31）です。
        </p>
        <p style={HINT}>
          確定申告は前年分を翌年（2〜3月）に提出します。たとえば <b>2026年の申告期</b> に始めるなら、対象年度は <b>2025年</b> です。
        </p>

        <label style={{ display: 'block', margin: '0 0 4px' }}>
          対象年度：
          <select
            value={year ?? ''}
            onChange={(e) => setYear(Number(e.target.value))}
            disabled={year == null || busy}
            style={SELECT}
          >
            {choices.map((y) => (
              <option key={y} value={y}>
                {y}年（{y}/1/1〜{y}/12/31）
              </option>
            ))}
          </select>
        </label>

        {err && <p style={{ color: COLORS.error, fontSize: 13 }}>⚠ {err}</p>}

        <div style={{ marginTop: 16 }}>
          <button onClick={submit} disabled={year == null || busy} style={PRIMARY}>
            {busy ? '設定中…' : 'この年度で始める'}
          </button>
        </div>

        <p style={NOTE}>
          ※ 翌年度への通常の繰越は「決算・繰越」から行えます。別の年度に変えてやり直したい場合は、ユーザーデータを初期化します。
        </p>
      </section>
    </main>
  )
}
