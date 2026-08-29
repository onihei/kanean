import { useState, useEffect } from 'react'
import { api } from '../api.js'
import type { Account, ProrationSettingView } from '../api.js'
import { yen } from '../lib/format.js'
import { COLORS } from '../lib/styles.js'
import { Msg, okMsg, errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'

export function ProrationTab() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [settings, setSettings] = useState<ProrationSettingView[] | null>(null)
  const [err, setErr] = useState('')
  const [postMsg, setPostMsg] = useState<MsgState>(null)
  const [busy, setBusy] = useState(false)

  const reload = () => {
    api.accounts().then(setAccounts).catch((e) => setErr(String(e)))
    api.prorationSettings().then(setSettings).catch((e) => setErr(String(e)))
  }
  useEffect(reload, [])

  const post = async () => {
    setBusy(true)
    setPostMsg(null)
    try {
      const r = await api.postProration()
      setPostMsg(okMsg(`${r.posted}件 起票（家事分計 ${yen(r.totalHousehold)}）`))
    } catch (e) {
      setPostMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!settings) return <p>…</p>

  return (
    <>
      <ProrationForm accounts={accounts} onDone={reload} />
      <section style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '1rem 0' }}>
        <button disabled={busy || settings.length === 0} onClick={post} className="btn btn-ok">家事按分の仕訳を起票</button>
        <span style={{ color: COLORS.muted, fontSize: 13 }}>期末一括で 借)事業主貸 / 貸)対象経費（再実行で洗い替え）</span>
      </section>
      <Msg msg={postMsg} />

      <h2>按分設定 {settings.length > 0 ? `（${settings.length}件）` : ''}</h2>
      {settings.length === 0 ? (
        <p style={{ color: COLORS.muted }}>按分設定がありません。対象の経費科目と事業利用比率を登録してください。</p>
      ) : (
        <table className="tbl" style={{ width: '100%', maxWidth: 640 }}>
          <thead>
            <tr>
              <th>対象科目</th>
              <th className="num">事業%</th>
              <th className="num">家事%</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {settings.map((s) => (
              <tr key={s.id}>
                <td>{s.accountName}{s.subAccountName ? `（${s.subAccountName}）` : ''}</td>
                <td className="num">{s.businessRatio}%</td>
                <td className="num" style={{ color: COLORS.muted }}>{100 - s.businessRatio}%</td>
                <td>
                  <button onClick={() => api.deleteProration(s.id).then(reload)} className="btn-link" style={{ color: COLORS.error, padding: 0 }}>
                    削除
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function ProrationForm({ accounts, onDone }: { accounts: Account[]; onDone: () => void }) {
  const [accountId, setAccountId] = useState(0)
  const [ratio, setRatio] = useState(60)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)

  const submit = async () => {
    if (!accountId) return
    setBusy(true)
    setMsg(null)
    try {
      await api.upsertProration({ accountId, businessRatio: ratio })
      onDone()
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, margin: '1rem 0' }}>
      <h2>按分設定を追加 / 更新</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
          <option value={0}>対象経費科目を選択…</option>
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <label style={{ color: COLORS.sub }}>
          事業利用比率 <input type="number" min={0} max={100} style={{ width: 70 }} value={ratio} onChange={(e) => setRatio(Number(e.target.value))} /> %
        </label>
        <button disabled={busy || !accountId} onClick={submit} className="btn btn-ok">保存</button>
        <span style={{ color: COLORS.muted, fontSize: 13 }}>同じ科目は上書き更新</span>
      </div>
      <Msg msg={msg} />
    </section>
  )
}
