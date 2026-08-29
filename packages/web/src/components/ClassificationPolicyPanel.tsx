import { COLORS } from '../lib/styles.js'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { ClassificationPolicy } from '../api.js'

/**
 * 分類方針の編集（[acquisition spec]「分類方針の提示と編集」）。
 *
 * 科目の当て方は事業ごとに違う。ここに書いたことが、未確定の分類を頼んだときの判断基準になる
 * （Claude Desktop はファイルを読めないので、アプリが渡さない限り届かない）。
 *
 * **ここに書けるのは AI への指示だけ**。期間ゲート・冪等・科目検証といったアプリの動作は変わらない。
 */
export function ClassificationPolicyPanel() {
  const [policy, setPolicy] = useState<ClassificationPolicy | null>(null)
  const [text, setText] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<{ tone: 'ok' | 'err'; text: string } | null>(null)
  const [confirmReset, setConfirmReset] = useState(false)

  const load = () =>
    api
      .classificationPolicy()
      .then((p) => {
        setPolicy(p)
        setText(p.text)
      })
      .catch((e) => setMsg({ tone: 'err', text: String(e) }))

  useEffect(() => {
    void load()
  }, [])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const p = await api.saveClassificationPolicy(text)
      setPolicy(p)
      setMsg({ tone: 'ok', text: '分類方針を保存しました。次に分類を頼んだときから反映されます。' })
    } catch (e) {
      setMsg({ tone: 'err', text: String(e) })
    } finally {
      setBusy(false)
    }
  }

  const reset = async () => {
    setBusy(true)
    setMsg(null)
    try {
      const p = await api.resetClassificationPolicy()
      setPolicy(p)
      setText(p.text)
      setConfirmReset(false)
      setMsg({
        tone: 'ok',
        text: p.hadOverride ? '既定の方針に戻しました。' : 'もともと既定の方針で動いていました。',
      })
    } catch (e) {
      setMsg({ tone: 'err', text: String(e) })
    } finally {
      setBusy(false)
    }
  }

  if (!policy) return <p style={{ color: COLORS.muted }}>読み込み中…</p>

  const dirty = text !== policy.text

  return (
    <section style={{ marginTop: '1.5rem' }}>
      <h4 style={{ margin: '0 0 6px' }}>
        分類方針{' '}
        <span style={{ fontSize: 13, fontWeight: 400, color: COLORS.muted }}>
          （{policy.origin === 'override' ? '編集済み' : '既定のまま'}）
        </span>
      </h4>
      <p style={{ color: COLORS.sub, margin: '0 0 8px', fontSize: 13 }}>
        未確定の仕訳に科目を当てるときの判断基準です。Claude Desktop に「仕訳して」と頼むと、
        この文章と過去の確定履歴が渡されます。<strong>あなたの事業に合わせて例を足してください</strong>
        （「〇〇株式会社への支払いは外注費」など、具体的なものほど効きます）。
        <br />
        ここに書けるのは判断の指示だけで、会計期間のチェックや二重計上の防止といったアプリの動作は変わりません。
      </p>

      <textarea
        value={text}
        onChange={(e) => setText(e.target.value)}
        spellCheck={false}
        style={{
          width: '100%',
          minHeight: 320,
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace',
          fontSize: 13,
          lineHeight: 1.6,
          padding: 10,
          border: `1px solid ${COLORS.border}`,
          borderRadius: 6,
          boxSizing: 'border-box',
        }}
      />

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8, flexWrap: 'wrap' }}>
        <button onClick={save} disabled={busy || !dirty} className="btn btn-ok">
          {dirty ? '保存する' : '保存済み'}
        </button>
        {confirmReset ? (
          <>
            <span style={{ fontSize: 13, color: COLORS.warn }}>編集内容を捨てて既定に戻します。</span>
            <button onClick={reset} disabled={busy} className="btn btn-danger">
              戻す
            </button>
            <button onClick={() => setConfirmReset(false)} disabled={busy} className="btn">
              やめる
            </button>
          </>
        ) : (
          <button onClick={() => setConfirmReset(true)} disabled={busy} className="btn">
            既定に戻す
          </button>
        )}
        {dirty && <span style={{ fontSize: 13, color: COLORS.warn }}>未保存の変更があります</span>}
      </div>

      {msg && (
        <p style={{ marginTop: 8, color: msg.tone === 'ok' ? COLORS.ok : COLORS.error }}>{msg.text}</p>
      )}
    </section>
  )
}
