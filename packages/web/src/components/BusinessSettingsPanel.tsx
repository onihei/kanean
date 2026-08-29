/** 事業者設定（各種設定）。屋号・申告区分・経理方式・消費税方式などの基本設定。 */
import { useEffect, useState } from 'react'
import { api, type BusinessSettingsView, type BusinessSettingsPatch } from '../api.js'
import { COLORS, SECTION, FIELD } from '../lib/styles.js'
import { Field, Msg, okMsg, errMsg } from './common.js'
import type { MsgState } from './common.js'

/** 編集対象フィールドだけを抜き出す（送信は変更分でなく全フォーム値）。 */
function pickEditable(s: BusinessSettingsView): BusinessSettingsPatch {
  return {
    businessName: s.businessName,
    ownerName: s.ownerName,
    phone: s.phone,
    prefecture: s.prefecture,
    industry: s.industry,
    filingType: s.filingType,
    accountingMethod: s.accountingMethod,
    taxMethod: s.taxMethod,
    taxBusinessCategory: s.taxBusinessCategory,
    blueDeductionETax: s.blueDeductionETax,
    evidenceCapture: s.evidenceCapture,
  }
}

export function BusinessSettingsPanel() {
  const [form, setForm] = useState<BusinessSettingsPatch | null>(null)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)
  const [err, setErr] = useState('')

  useEffect(() => {
    api
      .businessSettings()
      .then((s) => setForm(pickEditable(s)))
      .catch((e) => setErr(String(e)))
  }, [])

  const set = (patch: BusinessSettingsPatch) => setForm((p) => ({ ...(p ?? {}), ...patch }))

  const save = async () => {
    if (!form) return
    setBusy(true)
    setMsg(null)
    try {
      const saved = await api.updateBusinessSettings(form)
      setForm(pickEditable(saved))
      setMsg(okMsg('保存しました'))
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!form) return <p style={{ color: COLORS.muted }}>…</p>

  return (
    <section style={SECTION}>
      <h3 style={{ margin: '0 0 4px' }}>事業者設定</h3>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 14px' }}>
        申告書・帳票の前提となる基本設定です。<strong>経理方式・消費税方式・申告区分の変更は申告内容に影響します</strong>
        （妥当性は税理士にご確認ください）。
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 12 }}>
        <Field label="屋号・事業者名">
          <input style={FIELD} value={form.businessName ?? ''} onChange={(e) => set({ businessName: e.target.value })} />
        </Field>
        <Field label="氏名">
          <input style={FIELD} value={form.ownerName ?? ''} onChange={(e) => set({ ownerName: e.target.value })} />
        </Field>
        <Field label="電話番号">
          <input style={FIELD} value={form.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
        </Field>
        <Field label="都道府県">
          <input style={FIELD} value={form.prefecture ?? ''} onChange={(e) => set({ prefecture: e.target.value })} />
        </Field>
        <Field label="業種">
          <input style={FIELD} value={form.industry ?? ''} onChange={(e) => set({ industry: e.target.value })} />
        </Field>
        <Field label="申告区分">
          <select style={FIELD} value={form.filingType ?? 'blue'} onChange={(e) => set({ filingType: e.target.value })}>
            <option value="blue">青色申告</option>
            <option value="white">白色申告</option>
          </select>
        </Field>
        <Field label="経理方式">
          <select
            style={FIELD}
            value={form.accountingMethod ?? 'tax_included'}
            onChange={(e) => set({ accountingMethod: e.target.value })}
          >
            <option value="tax_included">税込経理</option>
            <option value="tax_excluded">税抜経理</option>
          </select>
        </Field>
        <Field label="消費税の課税方式">
          <select style={FIELD} value={form.taxMethod ?? 'simplified'} onChange={(e) => set({ taxMethod: e.target.value })}>
            <option value="simplified">簡易課税</option>
            <option value="general">一般（本則）課税</option>
            <option value="exempt">免税事業者</option>
          </select>
        </Field>
        <Field label="簡易課税の事業区分">
          <select
            style={FIELD}
            value={form.taxBusinessCategory ?? ''}
            onChange={(e) => set({ taxBusinessCategory: e.target.value || null })}
          >
            <option value="">未設定</option>
            <option value="1">第1種（卸売 90%）</option>
            <option value="2">第2種（小売 80%）</option>
            <option value="3">第3種（製造等 70%）</option>
            <option value="4">第4種（その他 60%）</option>
            <option value="5">第5種（サービス等 50%）</option>
            <option value="6">第6種（不動産 40%）</option>
          </select>
        </Field>
      </div>

      <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: COLORS.sub, fontSize: 13, margin: '14px 0 0' }}>
        <input
          type="checkbox"
          checked={form.blueDeductionETax ?? false}
          onChange={(e) => set({ blueDeductionETax: e.target.checked })}
        />
        青色申告特別控除65万円の要件（e-Tax電子申告 または 優良な電子帳簿の保存）を満たす
      </label>

      <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', color: COLORS.sub, fontSize: 13, margin: '10px 0 0' }}>
        <input
          type="checkbox"
          style={{ marginTop: 3 }}
          checked={form.evidenceCapture ?? false}
          onChange={(e) => set({ evidenceCapture: e.target.checked })}
        />
        <span>
          連携サービス取込で<strong>証憑（注文明細のスクショ等）を保存する</strong>（電帳法・電子取引データ保存）。
          <br />
          <span style={{ color: COLORS.muted, fontSize: 13 }}>
            OFF だと取込が速くなります。e-Tax申告なら65万控除に電子帳簿保存は不要ですが、電子取引データの保存義務は控除要件とは別です。対応要否は税理士にご確認ください。
          </span>
        </span>
      </label>

      <div style={{ marginTop: 16, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button disabled={busy} onClick={save} className="btn btn-ok">
          保存
        </button>
        <Msg msg={msg} />
      </div>
    </section>
  )
}
