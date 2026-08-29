import { useEffect, useState } from 'react'
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { methodLabel } from '../lib/labels.js'
import { useReport } from '../lib/hooks.js'
import { DepreciationBreakdownPanel } from '../components/breakdownPanels.js'
import { BackLink, Field, Msg, okMsg, errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import { api } from '../api.js'
import type { AssetSchedule, FixedAssetView, CreateFixedAssetInput } from '../api.js'
import { yenOrZero } from '../lib/money.js'
import { formatHash } from '../nav/route.js'

// --- 固定資産台帳 ----------------------------------------------------------

export function FixedAssetsTab({
  scheduleId,
}: {
  /** 償却スケジュール表示中の資産 id（URL `#assets/schedule/<id>` 由来・issue #250）。 */
  scheduleId?: number
}) {
  const [assets, setAssets] = useState<FixedAssetView[] | null>(null)
  const [err, setErr] = useState('')
  const [posting, setPosting] = useState(false)
  const [postMsg, setPostMsg] = useState<MsgState>(null)

  const reload = () => {
    api.fixedAssets().then(setAssets).catch((e) => setErr(String(e)))
  }
  useEffect(reload, [])

  const post = async () => {
    setPosting(true)
    setPostMsg(null)
    try {
      const r = await api.postDepreciation()
      const method = r.recordMethod === 'indirect' ? '間接法' : '直接法'
      const skip = r.skipped.length > 0 ? `／スキップ ${r.skipped.length}件（${r.skipped.map((s) => s.name).join('・')}）` : ''
      setPostMsg(okMsg(`${method}で ${r.posted}件 起票（償却計 ${yen(r.totalDepreciation)}・うち経費 ${yen(r.totalBusinessAmount)}）${skip}`))
      reload()
    } catch (e) {
      setPostMsg(errMsg(e))
    } finally {
      setPosting(false)
    }
  }

  if (scheduleId != null) return <ScheduleView id={scheduleId} />
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!assets) return <p>…</p>

  return (
    <>
      <AssetForm onDone={reload} />
      <section style={{ display: 'flex', gap: 12, alignItems: 'center', margin: '1rem 0' }}>
        <button disabled={posting || assets.length === 0} onClick={post} className="btn btn-ok">当年度の償却仕訳を起票</button>
        <span style={{ color: COLORS.muted, fontSize: 13 }}>確定済みとして起票（再実行で洗い替え）。借)減価償却費・事業主貸 / 貸)累計額</span>
      </section>
      <Msg msg={postMsg} />
      <h2>固定資産台帳 {assets.length > 0 ? `（${assets.length}件）` : ''}</h2>
      {assets.length === 0 ? (
        <p style={{ color: COLORS.muted }}>固定資産がありません。上のフォームから登録してください。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>管理No</th>
              <th>名称</th>
              <th>方法</th>
              <th className="num">取得価額</th>
              <th>供用日</th>
              <th className="num">事業%</th>
              <th className="num">本年償却</th>
              <th className="num">うち経費</th>
              <th className="num">期末簿価</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {assets.map((a) => (
              <tr key={a.id}>
                <td style={{ color: COLORS.muted }}>{a.managementNo}</td>
                <td>{a.name}</td>
                <td style={{ color: a.supported ? undefined : COLORS.error }}>
                  {methodLabel(a.depreciationMethod)}{!a.supported && '（未対応）'}
                </td>
                <td className="num">{yen(a.acquisitionCost)}</td>
                <td style={{ color: COLORS.sub }}>{a.businessStartDate ?? a.acquiredDate ?? ''}</td>
                <td className="num">{a.businessUseRatio}%</td>
                <td className="num">{a.current ? yen(a.current.depreciationAmount) : '—'}</td>
                <td className="num">{a.current ? yen(a.current.businessAmount) : '—'}</td>
                <td className="num">{yen(a.bookValue)}</td>
                <td>
                  <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
                    {a.supported && (
                      <a href={formatHash({ tab: 'assets', assetScheduleId: a.id })} className="btn-link" style={{ padding: 0, textDecoration: 'none' }}>
                        明細
                      </a>
                    )}
                    <RetireCell asset={a} onDone={(msg) => { reload(); setPostMsg(msg) }} />
                  </span>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <DepreciationBreakdownPanel />
    </>
  )
}

function RetireCell({ asset, onDone }: { asset: FixedAssetView; onDone: (msg: MsgState) => void }) {
  const [mode, setMode] = useState<'retire' | 'sell' | null>(null)
  const [date, setDate] = useState('')
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  if (asset.status !== 'active') {
    // 一括償却資産は処分後も3年均等償却を継続する（spec §5・所令§139）ため、その旨を明示する。
    const label = asset.status === 'sold' ? '売却済' : '除却済'
    return <span style={{ color: COLORS.muted, fontSize: 13 }}>{asset.depreciationMethod === 'lump_sum' ? `${label}（3年償却継続）` : label}</span>
  }

  const run = async () => {
    if (!date) {
      setErr(`${mode === 'sell' ? '売却日' : '除却日'}を入力`)
      return
    }
    setBusy(true)
    setErr('')
    try {
      const r = mode === 'sell' ? await api.sellAsset(asset.id, date) : await api.retireAsset(asset.id, date)
      const verb = mode === 'sell' ? '売却' : '除却'
      onDone(okMsg(`${verb}しました${r.note ? `（${r.note}）` : ''}`))
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!mode) {
    return (
      <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
        <button onClick={() => setMode('retire')} className="btn-link" style={{ color: COLORS.error, padding: 0, fontSize: 13 }}>
          除却
        </button>
        <button onClick={() => setMode('sell')} className="btn-link" style={{ padding: 0, fontSize: 13 }}>
          売却
        </button>
      </span>
    )
  }
  return (
    <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
      <span style={{ fontSize: 11, color: COLORS.sub }}>{mode === 'sell' ? '売却' : '除却'}</span>
      <input type="date" value={date} onChange={(e) => setDate(e.target.value)} style={{ fontSize: 13 }} />
      <button disabled={busy} onClick={run} className="btn btn-danger" style={{ fontSize: 13 }}>{mode === 'sell' ? '確定売却' : '確定除却'}</button>
      <button onClick={() => { setMode(null); setErr(''); setDate('') }} className="btn" style={{ fontSize: 13 }}>×</button>
      {err && <span style={{ color: COLORS.error, fontSize: 11 }}>{err}</span>}
    </span>
  )
}

function AssetForm({ onDone }: { onDone: () => void }) {
  const empty: CreateFixedAssetInput = { name: '', acquisitionCost: 0, businessStartDate: '', depreciationMethod: 'straight_line', usefulLife: null, businessUseRatio: 100, managementNo: '' }
  const [f, setF] = useState<CreateFixedAssetInput>(empty)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)
  const set = (patch: Partial<CreateFixedAssetInput>) => setF((prev) => ({ ...prev, ...patch }))

  // 中古資産の簡便法（法定耐用年数＋経過月数 → 見積耐用年数を算定して耐用年数欄へ）。
  const [used, setUsed] = useState({ legalYears: '', elapsedMonths: '' })
  const [usedMsg, setUsedMsg] = useState<MsgState>(null)
  const usesUsefulLife = (f.depreciationMethod ?? 'straight_line') === 'straight_line' || f.depreciationMethod === 'declining_balance'
  const computeUsedLife = async () => {
    setUsedMsg(null)
    try {
      const life = await api.usedAssetUsefulLife(Number(used.legalYears), Number(used.elapsedMonths))
      set({ usefulLife: life })
      setUsedMsg(okMsg(`簡便法 → 耐用年数 ${life}年`))
    } catch (e) {
      setUsedMsg(errMsg(e))
    }
  }

  const submit = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.createAsset({
        ...f,
        acquiredDate: f.businessStartDate || null,
        usefulLife: f.usefulLife ? Number(f.usefulLife) : null,
      })
      setF(empty)
      onDone()
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: 16, margin: '1rem 0' }}>
      <h2>固定資産を登録</h2>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
        <Field label="管理No">
          <input placeholder="A-1" style={{ width: 70 }} value={f.managementNo ?? ''} onChange={(e) => set({ managementNo: e.target.value })} />
        </Field>
        <Field label="名称">
          <input placeholder="例: マツダ2" value={f.name} onChange={(e) => set({ name: e.target.value })} />
        </Field>
        <Field label="取得価額">
          <input type="number" placeholder="398000" value={f.acquisitionCost || ''} onChange={(e) => set({ acquisitionCost: yenOrZero(e.target.value) })} />
        </Field>
        <Field label="償却方法">
          <select value={f.depreciationMethod ?? 'straight_line'} onChange={(e) => set({ depreciationMethod: e.target.value })}>
            <option value="straight_line">定額法</option>
            <option value="declining_balance">定率法（200%）</option>
            <option value="lump_sum">一括償却（3年均等）</option>
            <option value="minor_special">少額特例（即時・30万未満）</option>
          </select>
        </Field>
        <Field label="供用日">
          <input type="date" value={f.businessStartDate ?? ''} onChange={(e) => set({ businessStartDate: e.target.value })} />
        </Field>
        <Field label="耐用年数">
          <input
            type="number"
            style={{ width: 90 }}
            value={f.usefulLife ?? ''}
            disabled={f.depreciationMethod !== 'straight_line' && f.depreciationMethod !== 'declining_balance'}
            title={
              f.depreciationMethod === 'declining_balance'
                ? '定率法は耐用年数から償却率・改定償却率・保証率を解決します（2〜20年）'
                : f.depreciationMethod !== 'straight_line'
                  ? '一括償却・少額特例では耐用年数は不要'
                  : ''
            }
            onChange={(e) => set({ usefulLife: e.target.value ? Number(e.target.value) : null })}
          />
        </Field>
        <Field label="事業%">
          <input
            type="number"
            min={0}
            max={100}
            step={1}
            style={{ width: 60 }}
            value={f.businessUseRatio ?? 100}
            disabled={f.depreciationMethod === 'lump_sum'}
            title={f.depreciationMethod === 'lump_sum' ? '一括償却では事業利用比率は使いません（全額が経費）' : '0〜100の整数'}
            onChange={(e) => set({ businessUseRatio: Math.round(Number(e.target.value)) })}
          />
        </Field>
        <button disabled={busy || !f.name || !f.acquisitionCost} onClick={submit} className="btn btn-ok">登録</button>
      </div>
      {usesUsefulLife && (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 8 }}>
          <span style={{ fontSize: 13, color: COLORS.sub, alignSelf: 'center' }}>中古資産の簡便法:</span>
          <Field label="法定耐用年数">
            <input type="number" style={{ width: 120 }} value={used.legalYears} onChange={(e) => setUsed((u) => ({ ...u, legalYears: e.target.value }))} />
          </Field>
          <Field label="経過月数">
            <input type="number" style={{ width: 90 }} value={used.elapsedMonths} onChange={(e) => setUsed((u) => ({ ...u, elapsedMonths: e.target.value }))} />
          </Field>
          <button type="button" disabled={!used.legalYears || !used.elapsedMonths} onClick={computeUsedLife} className="btn">簡便法で耐用年数を計算</button>
          {usedMsg && <span style={{ fontSize: 13, color: usedMsg.kind === 'error' ? COLORS.error : COLORS.ok, alignSelf: 'center' }}>{usedMsg.text}</span>}
        </div>
      )}
      <Msg msg={msg} />
    </section>
  )
}

function ScheduleView({ id }: { id: number }) {
  const { data, err, loading } = useReport<AssetSchedule>(() => api.assetSchedule(id), [id])
  return (
    <>
      <BackLink to={{ tab: 'assets' }} />
      {loading && <p>…</p>}
      {err && <p style={{ color: COLORS.error }}>{err}</p>}
      {data && (
        <>
          <h2>償却スケジュール：{data.asset.name}</h2>
          <p style={{ color: COLORS.muted }}>
            {methodLabel(data.asset.depreciationMethod)} ／ 取得 {yen(data.asset.acquisitionCost)} ／ 事業 {data.asset.businessUseRatio}%
          </p>
          <table className="tbl" style={{ width: '100%', maxWidth: 720 }}>
            <thead>
              <tr>
                <th>年</th>
                <th className="num">期首簿価</th>
                <th className="num">償却費（全額）</th>
                <th className="num">必要経費</th>
                <th className="num">家事分</th>
                <th className="num">期末簿価</th>
              </tr>
            </thead>
            <tbody>
              {data.years.map((y) => (
                <tr key={y.year} style={data.asset.current?.year === y.year ? { background: COLORS.okBg, fontWeight: 600 } : undefined}>
                  <td>{y.year}</td>
                  <td className="num">{yen(y.openingBookValue)}</td>
                  <td className="num">{yen(y.depreciationAmount)}</td>
                  <td className="num">{yen(y.businessAmount)}</td>
                  <td className="num" style={{ color: COLORS.muted }}>{yen(y.householdAmount)}</td>
                  <td className="num">{yen(y.closingBookValue)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}
