import { COLORS } from '../lib/styles.js'
import { useState } from 'react'
import { api } from '../api.js'

/**
 * 巡回のログイン状態の破棄（[acquisition spec]「巡回セッションの秘密としての扱い」）。
 *
 * 取込のために銀行・カード・EC のログイン状態をアプリが保持する。これは**パスワードに準じる秘密**で、
 * エクスポートにもバックアップにも含めない。だからこそ「消す」導線を必ず持たせる
 * ＝ 端末を手放すとき・共用するときに、人が自分で断ち切れるようにする。
 */
export function AcquisitionLoginsPanel() {
  const [state, setState] = useState<'idle' | 'confirming' | 'busy' | 'done' | 'unavailable'>('idle')
  const [error, setError] = useState<string | null>(null)

  const forget = async () => {
    setState('busy')
    setError(null)
    try {
      await api.forgetAcquisitionLogins()
      setState('done')
    } catch (e) {
      // デスクトップ版でなければこのルートは無い（開発時のブラウザ表示）
      setState(String(e).includes('404') ? 'unavailable' : 'idle')
      if (!String(e).includes('404')) setError(String(e))
    }
  }

  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h4 style={{ margin: '0 0 6px' }}>連携サービスのログイン状態</h4>
      <p style={{ color: COLORS.sub, margin: '0 0 8px', fontSize: 13 }}>
        取込のために、銀行・カード・EC のログイン状態をこのアプリが保持しています。
        パスワードそのものは保持していませんが、この状態は<strong>パスワードに準じる秘密</strong>として扱い、
        エクスポートにもバックアップにも含めていません。
      </p>

      {state === 'unavailable' ? (
        <p style={{ color: COLORS.warn }}>この操作は Kanean デスクトップアプリから行ってください。</p>
      ) : state === 'done' ? (
        <p style={{ color: COLORS.ok }}>
          ログイン状態を破棄しました。次回の取込では、あらためてログインが必要になります。
        </p>
      ) : state === 'confirming' ? (
        <div
          style={{
            background: COLORS.warnBg,
            border: `1px solid ${COLORS.warnBorder}`,
            borderRadius: 6,
            padding: '8px 10px',
          }}
        >
          <p style={{ margin: '0 0 8px' }}>
            保持しているログイン状態をすべて消します。会計データは消えません。
            次回の取込では、あらためてログインと2要素認証が必要になります。
          </p>
          <button onClick={forget} className="btn btn-danger">破棄する</button>{' '}
          <button onClick={() => setState('idle')} className="btn">やめる</button>
        </div>
      ) : (
        <button onClick={() => setState('confirming')} disabled={state === 'busy'} className="btn btn-danger">
          ログイン状態を破棄する
        </button>
      )}

      {error && <p style={{ color: COLORS.error }}>{error}</p>}
    </section>
  )
}
