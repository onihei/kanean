import { useState, useEffect } from 'react'
import { useListFilter } from '../lib/useListFilter.js'
import { COLORS } from '../lib/styles.js'
import { yen, fmtSize } from '../lib/format.js'
import { sourceLabel } from '../lib/labels.js'
import { entriesReady, toLineInput } from '../lib/entryLine.js'
import { AccountLink, CsvButton, Msg, okMsg, errMsg, useConfirm } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import { api, qsOf } from '../api.js'
import type { Account, SubAccount, Counterparty, Department, EntryView, AttachmentMeta, AuditLogView } from '../api.js'
import { AddLineButtons, EntryLinesEditor, useEntryLines } from '../components/EntryLinesEditor.js'

export function JournalTab() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [entries, setEntries] = useState<EntryView[] | null>(null)
  const [err, setErr] = useState('')
  const [msg, setMsg] = useState<MsgState>(null)
  // フィルタ（即時適用・q は 300ms デバウンス。アプリ共通の操作モデル＝lib/useListFilter）。
  const [status, setStatus] = useState<'all' | 'draft' | 'confirmed'>('confirmed')
  const { from, setFrom, to, setTo, q, setQ, applied } = useListFilter()

  const reload = () => {
    setErr('')
    api
      .entries({ status, from: applied.from || undefined, to: applied.to || undefined, q: applied.q || undefined })
      .then(setEntries)
      .catch((e) => setErr(String(e)))
  }
  useEffect(() => {
    api.accounts().then(setAccounts).catch((e) => setErr(String(e)))
  }, [])
  useEffect(reload, [status, applied.from, applied.to, applied.q])

  // 適用済みフィルタを反映した CSV パス（即時適用モデルでは applied が常に表示中の条件）。
  const csvPath = () => `/api/reports/journal.csv${qsOf({ status, from: applied.from, to: applied.to, q: applied.q })}`

  if (err) return <p style={{ color: COLORS.error }}>{err}</p>

  return (
    <>
      <h2>仕訳帳<CsvButton path={csvPath()} filename="仕訳帳.csv" /></h2>
      <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0.5rem 0' }}>
        <select value={status} onChange={(e) => setStatus(e.target.value as 'all' | 'draft' | 'confirmed')}>
          <option value="confirmed">確定済み</option>
          <option value="draft">下書き</option>
          <option value="all">すべて</option>
        </select>
        <label style={{ color: COLORS.sub }}>期間 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <span style={{ color: COLORS.muted }}>〜</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <input placeholder="摘要で検索" value={q} onChange={(e) => setQ(e.target.value)} />
      </section>
      <Msg msg={msg} />

      {!entries ? (
        <p>…</p>
      ) : entries.length === 0 ? (
        <p style={{ color: COLORS.muted }}>該当する仕訳がありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>No</th>
              <th>日付</th>
              <th>摘要</th>
              <th>源泉</th>
              <th>状態</th>
              <th className="num">金額</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {entries.map((e) => (
              <JournalRow
                key={e.id}
                entry={e}
                accounts={accounts}
                onChanged={(m) => { if (m) setMsg(m); reload() }}
              />
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

function JournalRow({
  entry,
  accounts,
  onChanged,
}: {
  entry: EntryView
  accounts: Account[]
  onChanged: (msg?: MsgState) => void
}) {
  const [open, setOpen] = useState(false)
  const [editing, setEditing] = useState(false)
  const [showAudit, setShowAudit] = useState(false)
  const [busy, setBusy] = useState(false)
  const [confirmDialog, , askWithNote] = useConfirm()

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

  const confirm = () => run(() => api.confirm(entry.id), '確定しました')
  const unconfirm = () => run(() => api.unconfirmEntry(entry.id), '確定を取り消しました（下書きに戻しました）')
  const del = async () => {
    const r = await askWithNote(
      `仕訳 #${entry.id}（${entry.entryDate} ${entry.description ?? ''}）を削除します。よろしいですか？`,
      '削除理由（任意・監査ログに残ります）',
    )
    if (!r.ok) return
    run(() => api.deleteEntry(entry.id, r.note), '削除しました')
  }

  return (
    <>
      {/* 下書き行の地は warnBg より一段淡い一回きりの色（面積が広く、毎行を警告に見せない）。 */}
      <tr style={entry.status === 'draft' ? { background: '#fffdf5' } : undefined}>
        <td style={{ color: COLORS.muted }}>#{entry.id}</td>
        <td style={{ color: COLORS.sub, whiteSpace: 'nowrap' }}>{entry.entryDate}</td>
        <td>
          <button onClick={() => setOpen((v) => !v)} className="btn-link" style={{ padding: 0 }}>
            {open ? '▾ ' : '▸ '}{entry.description || '（摘要なし）'}
          </button>
        </td>
        <td style={{ color: COLORS.muted }}>{sourceLabel(entry.source)}</td>
        <td>
          <span style={{ color: entry.status === 'confirmed' ? COLORS.ok : COLORS.warn }}>
            {entry.status === 'confirmed' ? '確定' : '下書き'}
          </span>
        </td>
        <td className="num">{yen(entry.debitTotal)}</td>
        <td className="row-actions" style={{ whiteSpace: 'nowrap' }}>
          {entry.status === 'confirmed' ? (
            <button disabled={busy} onClick={unconfirm} className="btn-link">確定取消</button>
          ) : (
            <>
              <button disabled={busy} onClick={confirm} className="btn-link">確定</button>
              <button disabled={busy} onClick={() => setEditing((v) => !v)} className="btn-link">編集</button>
            </>
          )}
          <button disabled={busy} onClick={del} className="btn-link" style={{ color: COLORS.error }}>削除</button>
          <button onClick={() => setShowAudit((v) => !v)} className="btn-link" style={{ color: COLORS.muted }}>履歴</button>
          {confirmDialog}
        </td>
      </tr>

      {open && !editing && (
        <tr>
          <td colSpan={7} style={{ padding: '0 10px 10px 30px', background: COLORS.bgSubtle }}>
            <table className="tbl" style={{ width: '100%' }}>
              <thead>
                <tr>
                  <th>借/貸</th>
                  <th>勘定科目</th>
                  <th>補助</th>
                  <th>取引先</th>
                  <th>部門</th>
                  <th className="num">借方</th>
                  <th className="num">貸方</th>
                  <th className="num">税額</th>
                </tr>
              </thead>
              <tbody>
                {entry.lines.map((l) => (
                  <tr key={l.id}>
                    <td>{l.side === 'debit' ? '借' : '貸'}</td>
                    <td><AccountLink id={l.accountId} name={l.accountName} /></td>
                    <td style={{ color: COLORS.muted }}>{l.subAccountName ?? ''}</td>
                    <td style={{ color: COLORS.muted }}>{l.counterpartyName ?? ''}</td>
                    <td style={{ color: COLORS.muted }}>{l.departmentName ?? ''}</td>
                    <td className="num">{l.side === 'debit' ? yen(l.amount) : ''}</td>
                    <td className="num">{l.side === 'credit' ? yen(l.amount) : ''}</td>
                    <td className="num" style={{ color: COLORS.muted }}>{l.taxAmount ? yen(l.taxAmount) : ''}</td>
                  </tr>
                ))}
              </tbody>
            </table>
            <AttachmentPanel entryId={entry.id} />
          </td>
        </tr>
      )}

      {editing && (
        <tr>
          <td colSpan={7} style={{ padding: '10px 10px 14px 30px', background: COLORS.warnBg }}>
            <EntryEditor
              entry={entry}
              accounts={accounts}
              onCancel={() => setEditing(false)}
              onSaved={() => { setEditing(false); onChanged(okMsg('編集を保存しました')) }}
            />
          </td>
        </tr>
      )}

      {showAudit && (
        <tr>
          <td colSpan={7} style={{ padding: '0 10px 10px 30px', background: COLORS.bgSubtle }}>
            <AuditTrail targetId={entry.id} />
          </td>
        </tr>
      )}
    </>
  )
}

/** 仕訳に紐づく証憑（領収書等）の一覧・アップロード・削除（電帳法・Exit#1）。 */
function AttachmentPanel({ entryId }: { entryId: number }) {
  const [items, setItems] = useState<AttachmentMeta[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirmDialog, ask] = useConfirm()

  const reload = () => api.entryAttachments(entryId).then(setItems).catch((e) => setErr(String(e)))
  useEffect(() => {
    api.entryAttachments(entryId).then(setItems).catch((e) => setErr(String(e)))
  }, [entryId])

  const onUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0]
    if (!file) return
    setBusy(true)
    setErr('')
    try {
      await api.uploadAttachment(entryId, file)
      await reload()
    } catch (e2) {
      setErr(String(e2))
    } finally {
      setBusy(false)
      e.target.value = '' // 同じファイルを連続選択できるようにリセット。
    }
  }
  const del = async (id: number) => {
    if (!(await ask('この証憑を削除します。よろしいですか？'))) return
    setBusy(true)
    setErr('')
    try {
      await api.deleteAttachment(id)
      await reload()
    } catch (e2) {
      setErr(String(e2))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ marginTop: 10, paddingTop: 8, borderTop: `1px solid ${COLORS.borderFaint}` }}>
      {confirmDialog}
      <div style={{ fontSize: 13, color: COLORS.sub, marginBottom: 4 }}>証憑（領収書・請求書等）</div>
      {items == null ? (
        <span style={{ color: COLORS.muted, fontSize: 13 }}>…</span>
      ) : items.length === 0 ? (
        <span style={{ color: COLORS.muted, fontSize: 13 }}>添付なし</span>
      ) : (
        <ul style={{ margin: '0 0 6px', paddingLeft: 18, fontSize: 13 }}>
          {items.map((a) => (
            <li key={a.id} style={{ marginBottom: 2 }}>
              <a href={api.attachmentUrl(a.id)} target="_blank" rel="noreferrer" style={{ color: COLORS.accent }}>
                {a.fileName ?? `添付#${a.id}`}
              </a>
              <span style={{ color: COLORS.muted, marginLeft: 6 }}>{fmtSize(a.fileSize)}</span>
              {a.sha256 && <span style={{ color: COLORS.muted, marginLeft: 6, fontFamily: 'monospace', fontSize: 11 }} title={`SHA-256: ${a.sha256}`}>#{a.sha256.slice(0, 8)}</span>}
              <button disabled={busy} onClick={() => del(a.id)} className="btn-link" style={{ color: COLORS.error, fontSize: 13 }}>削除</button>
            </li>
          ))}
        </ul>
      )}
      <input type="file" accept="application/pdf,image/jpeg,image/png,image/heic,image/heif" disabled={busy} onChange={onUpload} style={{ fontSize: 13 }} />
      {err && <span style={{ color: COLORS.error, fontSize: 13, marginLeft: 8 }}>{err}</span>}
      <div style={{ color: COLORS.muted, fontSize: 11, marginTop: 4 }}>
        ※ SHA-256 は改ざん検知用のハッシュです。電子帳簿保存法の保存要件（検索・訂正削除履歴・タイムスタンプ等）の充足判断は税理士にご確認ください。
      </div>
    </div>
  )
}

function EntryEditor({
  entry,
  accounts,
  onCancel,
  onSaved,
}: {
  entry: EntryView
  accounts: Account[]
  onCancel: () => void
  onSaved: () => void
}) {
  const [date, setDate] = useState(entry.entryDate)
  const [description, setDescription] = useState(entry.description ?? '')
  const editor = useEntryLines(() =>
    entry.lines.map((l) => ({
      side: l.side,
      accountId: l.accountId,
      amount: l.amount,
      subAccountId: l.subAccountId ?? 0,
      counterpartyId: l.counterpartyId ?? 0,
      departmentId: l.departmentId ?? 0,
    })),
  )
  // 補助科目・取引先・部門も編集できる（issue #131 の機能差解消。従来は値保持のみ）。
  // エディタは編集開始時にしか mount されないので、マスタはここで遅延取得する。
  const [subAccounts, setSubAccounts] = useState<SubAccount[] | undefined>()
  const [counterparties, setCounterparties] = useState<Counterparty[] | undefined>()
  const [departments, setDepartments] = useState<Department[] | undefined>()
  useEffect(() => {
    // 取得失敗時は undefined のまま＝列非表示・値保持（編集自体は止めない）
    api.subAccounts().then(setSubAccounts).catch(() => {})
    api.counterparties().then(setCounterparties).catch(() => {})
    api.departments().then(setDepartments).catch(() => {})
  }, [])
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)
  const ready = entriesReady(editor.lines, date)

  const save = async () => {
    setBusy(true)
    setMsg(null)
    try {
      await api.updateEntry(entry.id, { entryDate: date, description: description || null, lines: editor.lines.map(toLineInput), note: note || null })
      onSaved()
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 6px' }}>
        <strong style={{ color: COLORS.warn }}>編集 #{entry.id}</strong>
        <label style={{ color: COLORS.sub }}>日付 <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <input placeholder="摘要" style={{ flex: 1, minWidth: 180 }} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>
      <EntryLinesEditor
        state={editor}
        accounts={accounts}
        subAccounts={subAccounts}
        counterparties={counterparties}
        departments={departments}
      />
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '6px 0' }}>
        <AddLineButtons state={editor} />
        <input placeholder="訂正理由（任意・監査ログ）" style={{ flex: 1, minWidth: 160 }} value={note} onChange={(e) => setNote(e.target.value)} />
        <button disabled={busy} onClick={onCancel} className="btn">キャンセル</button>
        <button disabled={busy || !ready} onClick={save} className="btn btn-ok">保存</button>
      </div>
      {msg && <p style={{ color: msg.kind === 'error' ? COLORS.error : COLORS.ok, margin: 0 }}>{msg.text}</p>}
    </>
  )
}

function AuditTrail({ targetId }: { targetId: number }) {
  const [logs, setLogs] = useState<AuditLogView[] | null>(null)
  const [err, setErr] = useState('')
  useEffect(() => {
    api.auditLogs(targetId).then(setLogs).catch((e) => setErr(String(e)))
  }, [targetId])

  const ACTION_LABELS: Record<string, string> = { update: '編集', unconfirm: '確定取消', delete: '削除', confirm: '確定' }
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!logs) return <p style={{ color: COLORS.muted }}>…</p>
  if (logs.length === 0) return <p style={{ color: COLORS.muted, margin: '6px 0' }}>変更履歴はありません。</p>

  return (
    <table className="tbl" style={{ width: '100%' }}>
      <thead>
        <tr>
          <th>日時</th>
          <th>操作</th>
          <th>理由</th>
        </tr>
      </thead>
      <tbody>
        {logs.map((l) => (
          <tr key={l.id}>
            <td style={{ color: COLORS.sub, whiteSpace: 'nowrap' }}>{new Date(l.at).toLocaleString()}</td>
            <td>{ACTION_LABELS[l.action] ?? l.action}</td>
            <td style={{ color: COLORS.muted }}>{l.note ?? ''}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}
