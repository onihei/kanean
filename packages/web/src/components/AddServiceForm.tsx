import { COLORS } from '../lib/styles.js'
import { useState } from 'react'
import { api } from '../api.js'
import type { LinkedService, ServiceCatalogEntry } from '../api.js'

/** サービス追加フォーム（カタログから選んで登録→補助科目を自動作成）。ServicesTab から分割（issue #152）。 */
export function AddServiceForm({
  catalog,
  onRegistered,
  onCancel,
}: {
  catalog: ServiceCatalogEntry[]
  onRegistered: (s: LinkedService) => void
  onCancel: () => void
}) {
  const [serviceKey, setServiceKey] = useState('')
  const [name, setName] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const entry = catalog.find((c) => c.key === serviceKey)

  const submit = async () => {
    if (!serviceKey) return
    setBusy(true)
    setErr('')
    try {
      const svc = await api.registerService({ serviceKey, name: name.trim() || null })
      setServiceKey('')
      setName('')
      onRegistered(svc)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '1rem 0', padding: '10px 12px', background: COLORS.accentBg, borderRadius: 8 }}>
      <span style={{ color: COLORS.sub, fontWeight: 600 }}>サービスを追加:</span>
      <select value={serviceKey} onChange={(e) => setServiceKey(e.target.value)}>
        <option value="">（サービスを選択）</option>
        {catalog.map((c) => (
          <option key={c.key} value={c.key}>
            {c.label}
            {c.csv ? '' : '（スキル連携）'}
          </option>
        ))}
      </select>
      <input placeholder="表示名（任意・例 UFJ 五反田）" value={name} onChange={(e) => setName(e.target.value)} />
      {entry && <span style={{ fontSize: 13, color: COLORS.muted }}>→ {entry.parentAccountName} に補助科目を自動作成</span>}
      <button type="button" disabled={!serviceKey || busy} onClick={submit} className="btn btn-ok">登録</button>
      <button type="button" onClick={onCancel} className="btn">キャンセル</button>
      {catalog.length === 0 && <span style={{ color: COLORS.error, fontSize: 13 }}>サービス候補を取得できませんでした。ページを再読込してください。</span>}
      {err && <span style={{ color: COLORS.error, fontSize: 13 }}>{err}</span>}
    </div>
  )
}
