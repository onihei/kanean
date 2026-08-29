/**
 * AI クライアント連携（web-app spec「設定画面」）。
 *
 * Claude Desktop から Kanean の会計データを問い合わせられるようにする導線。
 * やることは「同梱のバンドルを書き出して場所を示す」だけで、**クライアントの設定ファイルは触らない**。
 *
 * 書き出しは Finder での提示を伴うのでデスクトップ版にしか無い（`/api/desktop/*`）。
 * ブラウザ実行時はそのルート自体が存在せず 404 になるので、押せるのに何も起きない状態にはならない。
 */
import { useEffect, useState } from 'react'
import type { BundleStatus } from '@kanean/shared'
import { apiFetch } from '../api.js'
import { COLORS, SECTION } from '../lib/styles.js'

type State =
  | { kind: 'loading' }
  | { kind: 'unavailable' } // デスクトップ版でない（＝この経路では書き出せない）
  | { kind: 'ready'; status: BundleStatus }
  | { kind: 'exported'; status: BundleStatus; path: string }
  | { kind: 'failed'; status: BundleStatus; message: string }

export function AiLinkPanel() {
  const [state, setState] = useState<State>({ kind: 'loading' })

  useEffect(() => {
    apiFetch('/api/desktop/mcp-bundle')
      .then((res) => (res.ok ? (res.json() as Promise<BundleStatus>) : null))
      .then((status) =>
        setState(status?.available ? { kind: 'ready', status } : { kind: 'unavailable' }),
      )
      .catch(() => setState({ kind: 'unavailable' }))
  }, [])

  const exportBundle = async () => {
    if (state.kind === 'loading' || state.kind === 'unavailable') return
    try {
      const res = await apiFetch('/api/desktop/mcp-bundle/export', { method: 'POST' })
      const body = (await res.json()) as { path?: string; error?: string }
      if (!res.ok || !body.path) throw new Error(body.error ?? '書き出しに失敗しました')
      setState({ kind: 'exported', status: state.status, path: body.path })
    } catch (err) {
      setState({ kind: 'failed', status: state.status, message: (err as Error).message })
    }
  }

  return (
    <section>
      <h3 style={{ marginTop: 0 }}>Claude Desktop と連携</h3>

      <div style={SECTION}>
        <p style={{ marginTop: 0 }}>
          連携すると、Claude Desktop から会計データを尋ねられるようになります。
          「7月末の売掛金は？」「今月の状況は？」のような質問に、この帳簿の数字で答えます。
        </p>

        {/* できないことを先に書く。会計の確定を AI に委ねていないことが、導入前に分かるように。 */}
        <p style={{ margin: '0 0 8px', color: COLORS.sub }}>
          <strong>連携後もできないこと</strong>: 仕訳の確定・承認、勘定科目や期首残高の編集。
          これらは今までどおり、この画面で人が操作します。AI から実行することはできません。
        </p>
        <p style={{ margin: 0, color: COLORS.sub }}>
          通信は同じマシンの中だけで完結します（このアプリが起動している間だけ受け口が開きます）。
        </p>
      </div>

      {state.kind === 'loading' && <p>確認中…</p>}

      {state.kind === 'unavailable' && (
        <div style={SECTION}>
          <p style={{ margin: 0 }}>
            連携の設定は <strong>Kanean アプリ</strong>から行ってください（ブラウザからは書き出せません）。
          </p>
        </div>
      )}

      {state.kind !== 'loading' && state.kind !== 'unavailable' && (
        <div style={SECTION}>
          <h4 style={{ marginTop: 0 }}>手順</h4>
          <ol style={{ margin: '0 0 12px', paddingLeft: '1.2rem' }}>
            {state.status.steps.map((step) => (
              <li key={step} style={{ margin: '0 0 4px' }}>
                {step}
              </li>
            ))}
          </ol>

          <button onClick={exportBundle} className="btn btn-ok">連携ファイルを書き出す</button>

          {state.kind === 'exported' && (
            <p style={{ margin: '12px 0 0' }}>
              書き出しました: <code>{state.path}</code>
              <br />
              Finder で開いた場所から、<strong>Dock の Claude アイコン</strong>へドラッグしてください
              （ウィンドウの中に落とすとチャットへの添付になります）。
            </p>
          )}

          {state.kind === 'failed' && (
            <p style={{ margin: '12px 0 0', color: COLORS.error }}>{state.message}</p>
          )}
        </div>
      )}
    </section>
  )
}
