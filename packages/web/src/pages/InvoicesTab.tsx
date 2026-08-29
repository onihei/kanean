import { useState, useEffect } from 'react'
import { useReport } from '../lib/hooks.js'
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { yenOrZero } from '../lib/money.js'
import { previewTotals } from '../lib/documentTotals.js'
import { DOC_STATUS_LABEL } from '../lib/labels.js'
import { Field, Msg, okMsg, errMsg, useConfirm } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import { api } from '../api.js'
import type { DocumentLine, DocumentView, DocumentInput, Counterparty } from '../api.js'

const emptyDocLine = (): DocumentLine => ({ description: '', amount: 0, taxRate: 10, withholding: false })

export function InvoicesTab() {
  // 一覧本体は useReport（追い越しガード＋reload 込み。issue #160 の拡張形）。
  const { data: docs, err, reload } = useReport<DocumentView[]>(() => api.documents({ docType: 'invoice' }))
  const [counterparties, setCounterparties] = useState<Counterparty[]>([])
  const [msg, setMsg] = useState<MsgState>(null)

  useEffect(() => {
    // 取引先は表示名の解決用。失敗しても一覧は出せるが、黙って「取引先N」に劣化させない。
    api.counterparties().then(setCounterparties).catch((e) => setMsg(errMsg(e, '取引先一覧の取得に失敗しました')))
  }, [])

  const cpName = (id: number | null) => (id == null ? '' : counterparties.find((c) => c.id === id)?.name ?? `取引先${id}`)

  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  return (
    <>
      <h2>請求書</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: '4px 0' }}>
        税込経理。起票すると売掛金の複合仕訳（源泉対応）を計上します。売上計上時期・源泉徴収・消費税区分は税理士にご確認ください（PDF出力は今後の対応）。
      </p>
      <Msg msg={msg} />
      <NewInvoiceForm counterparties={counterparties} onDone={(m) => { setMsg(m); reload() }} />
      {!docs ? (
        <p>…</p>
      ) : docs.length === 0 ? (
        <p style={{ color: COLORS.muted }}>請求書がありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%', marginTop: 12 }}>
          <thead>
            <tr>
              <th>請求No</th>
              <th>請求日</th>
              <th>件名</th>
              <th>取引先</th>
              <th className="num">総額</th>
              <th className="num">源泉</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {docs.map((d) => (
              <InvoiceRow key={d.id} doc={d} cpName={cpName} onChanged={(m) => { if (m) setMsg(m); reload() }} />
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function NewInvoiceForm({ counterparties, onDone }: { counterparties: Counterparty[]; onDone: (msg: MsgState) => void }) {
  const [open, setOpen] = useState(false)
  const [docNo, setDocNo] = useState('')
  const [subject, setSubject] = useState('')
  const [counterpartyId, setCounterpartyId] = useState(0)
  const [issueDate, setIssueDate] = useState('')
  const [recogDate, setRecogDate] = useState('')
  const [lines, setLines] = useState<DocumentLine[]>([emptyDocLine()])
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  const setLine = (i: number, patch: Partial<DocumentLine>) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l)))
  const addLine = () => setLines((prev) => [...prev, emptyDocLine()])
  const removeLine = (i: number) => setLines((prev) => (prev.length > 1 ? prev.filter((_, j) => j !== i) : prev))
  const pv = previewTotals(lines)
  const ready = lines.length > 0 && lines.every((l) => Number.isFinite(l.amount) && l.amount > 0)

  const submit = async () => {
    setBusy(true)
    setErr('')
    try {
      const input: DocumentInput = {
        docType: 'invoice',
        docNo: docNo || null,
        subject: subject || null,
        counterpartyId: counterpartyId || null,
        issueDate: issueDate || null,
        revenueRecognitionDate: recogDate || issueDate || null,
        lines: lines.map((l) => ({ description: l.description, amount: l.amount, taxRate: l.taxRate, withholding: l.withholding })),
      }
      await api.createDocument(input)
      onDone(okMsg('請求書を作成しました（下書き）'))
      setDocNo(''); setSubject(''); setCounterpartyId(0); setIssueDate(''); setRecogDate(''); setLines([emptyDocLine()]); setOpen(false)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (!open) return <button onClick={() => setOpen(true)} className="btn btn-ok">＋ 請求書を作成</button>
  return (
    <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 6, padding: 12, margin: '8px 0', background: COLORS.bgSubtle }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginBottom: 8 }}>
        <Field label="請求No">
          <input value={docNo} onChange={(e) => setDocNo(e.target.value)} style={{ width: 110 }} />
        </Field>
        <Field label="件名">
          <input value={subject} onChange={(e) => setSubject(e.target.value)} style={{ width: 200 }} />
        </Field>
        <select value={counterpartyId} onChange={(e) => setCounterpartyId(Number(e.target.value))}>
          <option value={0}>取引先（任意）</option>
          {counterparties.map((c) => (
            <option key={c.id} value={c.id}>{c.name}</option>
          ))}
        </select>
        <label style={{ color: COLORS.sub, fontSize: 13 }}>請求日 <input type="date" value={issueDate} onChange={(e) => setIssueDate(e.target.value)} /></label>
        <label style={{ color: COLORS.sub, fontSize: 13 }}>売上計上日 <input type="date" value={recogDate} onChange={(e) => setRecogDate(e.target.value)} /></label>
      </div>
      <table className="tbl" style={{ width: '100%' }}>
        <thead>
          <tr>
            <th>品目・摘要</th>
            <th className="num">金額(税抜)</th>
            <th>税率</th>
            <th>源泉</th>
            <th></th>
          </tr>
        </thead>
        <tbody>
          {lines.map((l, i) => (
            <tr key={i}>
              <td><input value={l.description ?? ''} onChange={(e) => setLine(i, { description: e.target.value })} style={{ width: '100%' }} /></td>
              <td className="num"><input type="number" value={l.amount || ''} onChange={(e) => setLine(i, { amount: yenOrZero(e.target.value) })} style={{ width: 110, textAlign: 'right' }} /></td>
              <td>
                <select value={l.taxRate ?? 10} onChange={(e) => setLine(i, { taxRate: Number(e.target.value) })}>
                  <option value={10}>10%</option>
                  <option value={8}>8%</option>
                </select>
              </td>
              <td><input type="checkbox" checked={!!l.withholding} onChange={(e) => setLine(i, { withholding: e.target.checked })} /></td>
              <td><button onClick={() => removeLine(i)} disabled={lines.length <= 1} className="btn-link" style={{ color: COLORS.error }}>×</button></td>
            </tr>
          ))}
        </tbody>
      </table>
      <div style={{ marginTop: 6 }}>
        <button onClick={addLine} className="btn" style={{ fontSize: 13 }}>＋ 明細追加</button>
        <span style={{ marginLeft: 16, color: COLORS.sub, fontSize: 13 }}>
          小計 {yen(pv.subtotal)} ＋税 {yen(pv.taxTotal)} ＝ <strong>{yen(pv.total)}</strong>
          {pv.withholding > 0 && <>（源泉 −{yen(pv.withholding)} → 入金予定 {yen(pv.total - pv.withholding)}）</>}
        </span>
      </div>
      <div style={{ marginTop: 10, display: 'flex', gap: 8, alignItems: 'center' }}>
        <button disabled={busy || !ready} onClick={submit} className="btn btn-ok">作成（下書き）</button>
        <button onClick={() => setOpen(false)} disabled={busy} className="btn">キャンセル</button>
        {err && <span style={{ color: COLORS.error, fontSize: 13 }}>{err}</span>}
      </div>
    </section>
  )
}

function InvoiceRow({ doc, cpName, onChanged }: { doc: DocumentView; cpName: (id: number | null) => string; onChanged: (msg?: MsgState) => void }) {
  const [busy, setBusy] = useState(false)
  const [collecting, setCollecting] = useState(false)
  const [confirmDialog, ask] = useConfirm()
  const [payDate, setPayDate] = useState('')

  const run = async (fn: () => Promise<unknown>, okText: string) => {
    setBusy(true)
    try {
      await fn()
      onChanged(okMsg(okText))
    } catch (e) {
      onChanged(errMsg(e))
    } finally {
      setBusy(false)
    }
  }
  const issue = () => run(() => api.issueDocument(doc.id), '起票しました（売掛金を計上）')
  const collect = () => {
    if (!payDate) return onChanged(errMsg('入金日を入力してください'))
    run(() => api.collectDocument(doc.id, payDate), '入金消込しました')
    setCollecting(false)
  }
  const receipt = () => run(() => api.createReceipt(doc.id), '領収書を作成しました')
  const voidDoc = async () => {
    if (!(await ask(`請求書 #${doc.id} を無効化します。よろしいですか？`, '無効化する'))) return
    run(() => api.voidDocument(doc.id), '無効化しました')
  }

  return (
    <tr style={doc.status === 'void' ? { color: COLORS.faint, textDecoration: 'line-through' } : undefined}>
      <td style={{ color: COLORS.muted }}>{doc.docNo ?? `#${doc.id}`}</td>
      <td style={{ whiteSpace: 'nowrap', color: COLORS.sub }}>{doc.issueDate ?? ''}</td>
      <td>{doc.subject ?? ''}</td>
      <td style={{ color: COLORS.sub }}>{cpName(doc.counterpartyId)}</td>
      <td className="num">{yen(doc.total ?? 0)}</td>
      <td className="num" style={{ color: COLORS.muted }}>{doc.withholdingTotal ? yen(doc.withholdingTotal) : ''}</td>
      <td>{DOC_STATUS_LABEL[doc.status] ?? doc.status}</td>
      <td style={{ whiteSpace: 'nowrap' }}>
        {confirmDialog}
        {doc.status === 'draft' && (
          <>
            <button disabled={busy} onClick={issue} className="btn-link">起票</button>
            <button disabled={busy} onClick={voidDoc} className="btn-link" style={{ color: COLORS.error }}>無効</button>
          </>
        )}
        {doc.status === 'issued' && (
          collecting ? (
            <span style={{ display: 'inline-flex', gap: 4, alignItems: 'center' }}>
              <input type="date" value={payDate} onChange={(e) => setPayDate(e.target.value)} style={{ fontSize: 13 }} />
              <button disabled={busy} onClick={collect} className="btn btn-ok" style={{ fontSize: 13 }}>消込</button>
              <button onClick={() => setCollecting(false)} className="btn" style={{ fontSize: 13 }}>×</button>
            </span>
          ) : (
            <>
              <button disabled={busy} onClick={() => setCollecting(true)} className="btn-link">入金消込</button>
              <button disabled={busy} onClick={receipt} className="btn-link">領収書</button>
            </>
          )
        )}
        {doc.journalEntryId != null && <span style={{ color: COLORS.muted, fontSize: 11, marginLeft: 4 }}>仕訳#{doc.journalEntryId}</span>}
      </td>
    </tr>
  )
}
