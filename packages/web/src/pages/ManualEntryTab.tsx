import { COLORS } from '../lib/styles.js'
import { useEffect, useState } from 'react'
import { api, type Account, type SubAccount, type Counterparty, type Department } from '../api.js'
import { emptyLine, entriesReady, toLineInput } from '../lib/entryLine.js'
import { SegTabs, Msg, okMsg, errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import { AddLineButtons, EntryLinesEditor, useEntryLines } from '../components/EntryLinesEditor.js'
import { EasyEntryForm } from './EasyEntryForm.js'

export function ManualEntryTab() {
  const [mode, setMode] = useState<'easy' | 'compound'>('easy')
  const [accounts, setAccounts] = useState<Account[]>([])
  const [subAccounts, setSubAccounts] = useState<SubAccount[]>([])
  const [counterparties, setCounterparties] = useState<Counterparty[]>([])
  const [departments, setDepartments] = useState<Department[]>([])
  const [loadError, setLoadError] = useState('')

  useEffect(() => {
    api.accounts().then(setAccounts).catch((e) => setLoadError(String(e)))
    api.subAccounts().then(setSubAccounts).catch((e) => setLoadError(String(e)))
    api.counterparties().then(setCounterparties).catch((e) => setLoadError(String(e)))
    api.departments().then(setDepartments).catch((e) => setLoadError(String(e)))
  }, [])

  return (
    <>
      <h2>仕訳入力</h2>
      <SegTabs
        value={mode}
        onChange={setMode}
        options={[
          { value: 'easy', label: 'かんたん入力' },
          { value: 'compound', label: '複合仕訳' },
        ]}
      />
      {loadError && <p style={{ color: COLORS.error }}>エラー: {loadError}</p>}
      {mode === 'easy' ? (
        <EasyEntryForm accounts={accounts} subAccounts={subAccounts} counterparties={counterparties} />
      ) : (
        <CompoundEntryForm
          accounts={accounts}
          subAccounts={subAccounts}
          counterparties={counterparties}
          departments={departments}
        />
      )}
    </>
  )
}

/** 複合仕訳（借N:貸M の明細テーブル入力）。明細エディタは共通実装（issue #131）。 */
function CompoundEntryForm({
  accounts,
  subAccounts,
  counterparties,
  departments,
}: {
  accounts: Account[]
  subAccounts: SubAccount[]
  counterparties: Counterparty[]
  departments: Department[]
}) {
  const [date, setDate] = useState('')
  const [description, setDescription] = useState('')
  const editor = useEntryLines(() => [emptyLine('debit'), emptyLine('credit')])
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)
  const ready = entriesReady(editor.lines, date)

  const submit = async (status: 'draft' | 'confirmed') => {
    setBusy(true)
    setMsg(null)
    try {
      await api.createEntry({ entryDate: date, description: description || null, status, lines: editor.lines.map(toLineInput) })
      editor.reset([emptyLine('debit'), emptyLine('credit')])
      setDescription('')
      setMsg(okMsg(status === 'confirmed' ? '起票しました（確定）' : '下書きとして保存しました'))
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0.5rem 0' }}>
        <label style={{ color: COLORS.sub }}>日付 <input type="date" value={date} onChange={(e) => setDate(e.target.value)} /></label>
        <input placeholder="摘要" style={{ flex: 1, minWidth: 200 }} value={description} onChange={(e) => setDescription(e.target.value)} />
      </div>

      <EntryLinesEditor
        state={editor}
        accounts={accounts}
        subAccounts={subAccounts}
        counterparties={counterparties}
        departments={departments}
      />

      <div style={{ display: 'flex', gap: 8, margin: '0.75rem 0' }}>
        <AddLineButtons state={editor} />
        <span style={{ flex: 1 }} />
        <button disabled={busy || !ready} onClick={() => submit('draft')} className="btn">下書き保存</button>
        <button disabled={busy || !ready} onClick={() => submit('confirmed')} className="btn btn-ok">確定で起票</button>
      </div>
      <Msg msg={msg} />
    </>
  )
}
