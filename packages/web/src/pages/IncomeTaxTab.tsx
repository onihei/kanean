import { useEffect, useState } from 'react'
import { COLORS, SECTION, FIELD } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { DEDUCTION_FIELDS } from '../lib/labels.js'
import { NoYear, TaxAdvisorBanner, PdfButton, SegTabs, okMsg, errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import { IncomeTaxForm } from './forms/IncomeTaxForm.js'
import { FormPreviewSwitch } from './forms/PdfFormPreview.js'
import { api } from '../api.js'
import type { IncomeTaxReturn, TaxReturnInputsView, Counterparty } from '../api.js'
import { yenOrZero } from '../lib/money.js'

export function IncomeTaxTab() {
  const [data, setData] = useState<IncomeTaxReturn | null>(null)
  const [err, setErr] = useState('')
  const [view, setView] = useState<'return' | 'preview'>('return')
  const reload = () => {
    api.incomeTaxReturn().then(setData).catch((e) => setErr(String(e)))
  }
  useEffect(reload, [])
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  return (
    <>
      <SegTabs
        value={view}
        onChange={setView}
        options={[{ value: 'return', label: '申告書' }, { value: 'preview', label: '様式プレビュー' }]}
      />
      {view === 'preview' ? (
        <FormPreviewSwitch
          pdfPath="/api/tax-return/income-tax-official.pdf"
          pdfFilename="確定申告書_公式様式.pdf"
          htmlNote="官製様式（確定申告書 第一表・第二表）の HTML 再現です。金額は「公式様式PDF」と同一集計。事業所得単独前提・配偶者特別控除等の細目は未対応。参考帳票につき税理士確認のうえ提出してください。"
        >
          <IncomeTaxForm data={data} />
        </FormPreviewSwitch>
      ) : (
        <>
          <h2>
            確定申告書 第一表・第二表（所得税）
            <PdfButton path="/api/tax-return/income-tax.pdf" filename="確定申告書_第一表第二表.pdf" />
            <PdfButton path="/api/tax-return/income-tax-official.pdf" filename="確定申告書_公式様式.pdf" label="公式様式PDF" />
          </h2>
          <TaxAdvisorBanner note="所得控除はご自身/税理士の控除明細から入力。累進税率は令和の速算表（税制改正で要更新）。源泉徴収税額は帳簿の事業主貸(源泉所得税)から自動集計。事業所得単独前提・各種税額控除は未対応。「公式様式PDF」は国税庁様式（令和5年分以降用）に座標差込（基礎控除・扶養控除は自動記入。配偶者特別控除等の細目は手記入）。参考帳票につき税理士確認のうえ提出してください。" />
          <TaxInputsForm inputs={data.inputs} onSaved={reload} />
          <IncomeTaxFirstTable data={data} />
          <IncomeDetailTable rows={data.incomeDetail} />
          <WithholdingSaleForm onPosted={reload} />
        </>
      )}
    </>
  )
}

function IncomeDetailTable({ rows }: { rows: IncomeTaxReturn['incomeDetail'] }) {
  if (rows.length === 0) return null
  return (
    <section style={SECTION}>
      <h3 style={{ marginTop: 0, color: COLORS.sub }}>第二表 所得の内訳（源泉徴収）</h3>
      <table className="tbl" style={{ maxWidth: 520 }}>
        <thead>
          <tr>
            <th>支払者</th>
            <th className="num">収入金額</th>
            <th className="num">源泉徴収税額</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((r, i) => (
            <tr key={r.counterpartyId ?? `none-${i}`}>
              <td>{r.payerName}</td>
              <td className="num">{yen(r.revenue)}</td>
              <td className="num">{yen(r.withholding)}</td>
            </tr>
          ))}
        </tbody>
        <tfoot>
          <tr style={{ fontWeight: 600 }}>
            <td>合計</td>
            <td className="num">{yen(rows.reduce((s, r) => s + r.revenue, 0))}</td>
            <td className="num">{yen(rows.reduce((s, r) => s + r.withholding, 0))}</td>
          </tr>
        </tfoot>
      </table>
    </section>
  )
}

function WithholdingSaleForm({ onPosted }: { onPosted: () => void }) {
  const [counterparties, setCounterparties] = useState<Counterparty[]>([])
  const [counterpartyId, setCounterpartyId] = useState(0)
  const [entryDate, setEntryDate] = useState('')
  const [gross, setGross] = useState(0)
  const [withholdingBase, setWithholdingBase] = useState(0)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)

  useEffect(() => {
    api.counterparties().then(setCounterparties).catch(() => setCounterparties([]))
  }, [])

  const submit = async () => {
    if (!entryDate || gross <= 0) {
      setMsg(errMsg('日付と税込売上額を入力してください'))
      return
    }
    setBusy(true)
    setMsg(null)
    try {
      const r = await api.postWithholdingSale({
        entryDate,
        counterpartyId: counterpartyId || null,
        gross,
        withholdingBase: withholdingBase || gross,
      })
      setMsg(okMsg(`起票しました（源泉 ${yen(r.withholding)}・入金 ${yen(r.deposit)}）`))
      setGross(0)
      setWithholdingBase(0)
      onPosted()
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={SECTION}>
      <h3 style={{ marginTop: 0, color: COLORS.sub }}>源泉徴収された報酬売上の起票</h3>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 12px' }}>
        借)普通預金（税込−源泉）／借)事業主貸(源泉所得税)／貸)売上（税込）を複合仕訳で起票します。源泉計算の基礎は
        消費税が区分されていれば本体、なければ税込（未入力なら税込を使用）。10.21%／100万超は20.42%。
      </p>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <input type="date" value={entryDate} onChange={(e) => setEntryDate(e.target.value)} style={FIELD} />
        <select value={counterpartyId} onChange={(e) => setCounterpartyId(Number(e.target.value))} style={FIELD}>
          <option value={0}>支払者（取引先）を選択…</option>
          {counterparties.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <label style={{ color: COLORS.sub, fontSize: 13 }}>
          税込売上 <input type="number" min={0} style={{ width: 110 }} value={gross} onChange={(e) => setGross(yenOrZero(e.target.value))} /> 円
        </label>
        <label style={{ color: COLORS.sub, fontSize: 13 }}>
          源泉基礎 <input type="number" min={0} style={{ width: 110 }} value={withholdingBase} onChange={(e) => setWithholdingBase(yenOrZero(e.target.value))} /> 円
        </label>
        <button disabled={busy} onClick={submit} className="btn btn-ok">起票</button>
      </div>
      {msg && <p style={{ color: msg.kind === 'error' ? COLORS.error : COLORS.ok, fontSize: 13 }}>{msg.text}</p>}
    </section>
  )
}

function TaxInputsForm({ inputs, onSaved }: { inputs: TaxReturnInputsView; onSaved: () => void }) {
  const [form, setForm] = useState<TaxReturnInputsView>(inputs)
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)

  // タブ再取得で inputs が変わったら同期。
  useEffect(() => setForm(inputs), [inputs])

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.setTaxReturnInputs(form)
      onSaved()
      setMsg(okMsg('保存しました'))
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={SECTION}>
      <h3 style={{ marginTop: 0, color: COLORS.sub }}>所得控除・予定納税の入力</h3>
      <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill, minmax(220px, 1fr))', gap: 8 }}>
        {DEDUCTION_FIELDS.map((f) => (
          <label key={f.key} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, color: COLORS.sub, fontSize: 13 }}>
            {f.label}
            <input
              type="number"
              min={0}
              step={1}
              style={{ width: 120 }}
              value={form[f.key]}
              onChange={(e) => setForm({ ...form, [f.key]: yenOrZero(e.target.value) })}
            />
          </label>
        ))}
      </div>
      <div style={{ marginTop: 12, display: 'flex', gap: 12, alignItems: 'center' }}>
        <button disabled={busy} onClick={save} className="btn btn-ok">保存</button>
        {msg && <span style={{ color: msg.kind === 'error' ? COLORS.error : COLORS.ok, fontSize: 13 }}>{msg.text}</span>}
      </div>
    </section>
  )
}

function IncomeTaxFirstTable({ data }: { data: IncomeTaxReturn }) {
  const Row = ({ label, amount, strong, sign, hint }: { label: string; amount: number; strong?: boolean; sign?: '−'; hint?: string }) => (
    <tr style={strong ? { fontWeight: 600, color: COLORS.ok, borderTop: `2px solid ${COLORS.border}` } : undefined}>
      <td>{label}{hint ? <span style={{ color: COLORS.muted, fontSize: 13 }}>（{hint}）</span> : ''}</td>
      <td className="num">{sign ? `${sign} ` : ''}{yen(amount)}</td>
    </tr>
  )
  return (
    <section style={SECTION}>
      <h3 style={{ marginTop: 0, color: COLORS.sub }}>第一表（算出）</h3>
      <table className="tbl" style={{ maxWidth: 520 }}>
        <tbody>
          <Row label="収入金額等：事業（営業等）" amount={data.businessRevenue} />
          <Row label="所得金額等：事業（営業等）㊺" amount={data.businessIncome} />
          <Row label="所得金額の合計" amount={data.totalIncome} />
          <Row label="所得から差し引かれる金額（所得控除合計）" amount={data.totalDeductions} sign="−" />
          <Row label="課税される所得金額" amount={data.taxableIncome} hint="千円未満切捨" />
          <Row label="上の金額に対する税額" amount={data.baseTax} hint="累進税率" />
          <Row label="復興特別所得税" amount={data.surtax} hint="×2.1%" />
          <Row label="所得税及び復興特別所得税の額" amount={data.taxWithSurtax} />
          <Row label="源泉徴収税額" amount={data.withholding} sign="−" hint="帳簿集計" />
          {data.estimatedPrepaid > 0 && <Row label="予定納税額" amount={data.estimatedPrepaid} sign="−" />}
          {data.refund > 0 ? (
            <Row label="還付される税金" amount={data.refund} strong />
          ) : (
            <Row label="申告納税額（納める税金）" amount={data.payable} strong hint="百円未満切捨" />
          )}
        </tbody>
      </table>
    </section>
  )
}
