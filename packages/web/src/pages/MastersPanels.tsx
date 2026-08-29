import { useState, useEffect } from 'react'
import { api } from '../api.js'
import type {
  Counterparty,
  CounterpartyInput,
  SubAccount,
  Department,
  Item,
  ItemInput,
  Tag,
  Rule,
  RuleInput,
  Account,
  TaxCategory,
} from '../api.js'
import { COLORS, SECTION, FIELD } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { yenOrZero } from '../lib/money.js'
import { DIRECTION_LABELS, FIELD_LABELS, OP_LABELS } from '../lib/labels.js'
import { useMasterCrud } from '../lib/useMasterCrud.js'
import { Field, Msg, okMsg, errMsg, useConfirm } from '../components/common.js'
import type { MsgState } from '../components/common.js'

// --- 一覧行の共通部品（issue #133。状態セルと 編集/無効化[/削除] の操作セル） ---------

function StatusCell({ active }: { active: boolean }) {
  return <td>{active ? '有効' : '無効'}</td>
}

function RowActions({ active, onEdit, onToggle, onDelete }: { active: boolean; onEdit: () => void; onToggle: () => void; onDelete?: () => void }) {
  return (
    <td style={{ whiteSpace: 'nowrap' }}>
      <button className="btn-link" onClick={onEdit}>編集</button>
      <button className="btn-link" style={{ color: active ? COLORS.error : COLORS.ok }} onClick={onToggle}>
        {active ? '無効化' : '有効化'}
      </button>
      {onDelete && <button className="btn-link" style={{ color: COLORS.error }} onClick={onDelete}>削除</button>}
    </td>
  )
}

// --- 取引先 ----------------------------------------------------------------

export function CounterpartiesPanel() {
  const [includeInactive, setIncludeInactive] = useState(false)
  const { rows, editId, form: f, setForm, msg, busy, reset, startEdit, save, toggle } = useMasterCrud<Counterparty, CounterpartyInput>(
    {
      load: () => api.counterparties(includeInactive),
      empty: { name: '' },
      idOf: (c) => c.id,
      toForm: (c) => ({
        name: c.name, nameKana: c.nameKana, honorific: c.honorific, customerCode: c.customerCode,
        invoiceRegNo: c.invoiceRegNo, phone: c.phone, email: c.email,
        prefecture: c.prefecture, address1: c.address1, address2: c.address2, memo: c.memo,
      }),
      create: (form) => api.createCounterparty(form),
      update: (id, form) => api.updateCounterparty(id, form),
      setActive: (c) => api.setCounterpartyActive(c.id, !c.isActive),
      canSave: (form) => Boolean(form.name?.trim()),
    },
    [includeInactive],
  )
  const set = (patch: Partial<CounterpartyInput>) => setForm((p) => ({ ...p, ...patch }))

  return (
    <>
      <section style={SECTION}>
        <h3 style={{ margin: '0 0 8px' }}>{editId ? `取引先を編集 #${editId}` : '取引先を登録'}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="取引先名 *">
            <input style={FIELD} value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="カナ">
            <input style={FIELD} value={f.nameKana ?? ''} onChange={(e) => set({ nameKana: e.target.value })} />
          </Field>
          <Field label="敬称">
            <input style={{ ...FIELD, width: 70 }} placeholder="御中" value={f.honorific ?? ''} onChange={(e) => set({ honorific: e.target.value })} />
          </Field>
          <Field label="登録番号">
            <input style={FIELD} placeholder="T+13桁" value={f.invoiceRegNo ?? ''} onChange={(e) => set({ invoiceRegNo: e.target.value })} />
          </Field>
          <Field label="顧客コード">
            <input style={FIELD} value={f.customerCode ?? ''} onChange={(e) => set({ customerCode: e.target.value })} />
          </Field>
          <Field label="電話">
            <input style={FIELD} value={f.phone ?? ''} onChange={(e) => set({ phone: e.target.value })} />
          </Field>
          <Field label="メール">
            <input style={FIELD} value={f.email ?? ''} onChange={(e) => set({ email: e.target.value })} />
          </Field>
          <Field label="メモ" style={{ flex: 1, minWidth: 160 }}>
            <input style={FIELD} value={f.memo ?? ''} onChange={(e) => set({ memo: e.target.value })} />
          </Field>
          <button disabled={busy || !f.name?.trim()} onClick={save} className="btn btn-ok">{editId ? '更新' : '登録'}</button>
          {editId && <button onClick={reset} className="btn">新規</button>}
        </div>
        <Msg msg={msg} />
      </section>

      <label style={{ color: COLORS.sub, fontSize: 13 }}>
        <input type="checkbox" checked={includeInactive} onChange={(e) => setIncludeInactive(e.target.checked)} /> 無効も表示
      </label>
      {rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>取引先がありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>取引先名</th>
              <th>カナ</th>
              <th>登録番号</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((c) => (
              <tr key={c.id} style={c.isActive ? undefined : { color: COLORS.faint }}>
                <td>{c.name}</td>
                <td style={{ color: COLORS.muted }}>{c.nameKana ?? ''}</td>
                <td style={{ color: COLORS.muted }}>{c.invoiceRegNo ?? ''}</td>
                <StatusCell active={c.isActive} />
                <RowActions active={c.isActive} onEdit={() => startEdit(c)} onToggle={() => toggle(c)} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// --- 補助科目 --------------------------------------------------------------

type SubForm = { name: string; defaultTaxCategoryId: number; counterpartyId: number; linkedAccountRef: string }
const emptySub: SubForm = { name: '', defaultTaxCategoryId: 0, counterpartyId: 0, linkedAccountRef: '' }
/** フォーム（select は 0=なし）→ API ペイロード（0 → null）。 */
const subPayload = (f: SubForm) => ({
  name: f.name,
  defaultTaxCategoryId: f.defaultTaxCategoryId || null,
  counterpartyId: f.counterpartyId || null,
  linkedAccountRef: f.linkedAccountRef || null,
})

export function SubAccountsPanel() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [taxCats, setTaxCats] = useState<TaxCategory[]>([])
  const [cps, setCps] = useState<Counterparty[]>([])
  const [accountId, setAccountId] = useState(0)
  const { rows, editId, form: f, setForm, msg, setMsg, busy, reset, startEdit, save, toggle } = useMasterCrud<SubAccount, SubForm>(
    {
      load: () => (accountId ? api.subAccounts(accountId, true) : Promise.resolve([])),
      empty: emptySub,
      idOf: (s) => s.id,
      toForm: (s) => ({ name: s.name, defaultTaxCategoryId: s.defaultTaxCategoryId ?? 0, counterpartyId: s.counterpartyId ?? 0, linkedAccountRef: s.linkedAccountRef ?? '' }),
      create: (form) => api.createSubAccount({ accountId, ...subPayload(form) }),
      update: (id, form) => api.updateSubAccount(id, subPayload(form)),
      setActive: (s) => api.setSubAccountActive(s.id, !s.isActive),
      canSave: (form) => Boolean(accountId) && Boolean(form.name.trim()),
    },
    [accountId],
  )

  useEffect(() => {
    api.accounts().then(setAccounts).catch((e) => setMsg(errMsg(e)))
    api.taxCategories().then(setTaxCats).catch((e) => setMsg(errMsg(e)))
    // 無効な取引先も含める（既存の補助科目が無効先を参照していても表示・保持するため）。
    api.counterparties(true).then(setCps).catch((e) => setMsg(errMsg(e)))
    // setMsg は useState セッター由来で安定（フック返却のため lint が同定できないだけ）。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const taxLabel = (id: number | null) => taxCats.find((t) => t.id === id)?.label ?? ''
  const cpLabel = (id: number | null) => {
    const c = cps.find((x) => x.id === id)
    return c ? `${c.name}${c.isActive ? '' : '（無効）'}` : ''
  }

  return (
    <>
      <section style={SECTION}>
        <h3 style={{ margin: '0 0 8px' }}>補助科目</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
          <select value={accountId} onChange={(e) => { setAccountId(Number(e.target.value)); reset() }}>
            <option value={0}>勘定科目を選択…</option>
            {accounts.map((a) => (
              <option key={a.id} value={a.id}>{a.name}</option>
            ))}
          </select>
        </div>
        {accountId > 0 && (
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end', marginTop: 10 }}>
            <Field label="補助科目名 *">
              <input style={FIELD} value={f.name} onChange={(e) => setForm((p) => ({ ...p, name: e.target.value }))} />
            </Field>
            <select value={f.defaultTaxCategoryId} onChange={(e) => setForm((p) => ({ ...p, defaultTaxCategoryId: Number(e.target.value) }))}>
              <option value={0}>既定税区分（なし）</option>
              {taxCats.map((t) => (
                <option key={t.id} value={t.id}>{t.label}</option>
              ))}
            </select>
            <select value={f.counterpartyId} onChange={(e) => setForm((p) => ({ ...p, counterpartyId: Number(e.target.value) }))}>
              <option value={0}>取引先（なし）</option>
              {cps.map((c) => (
                <option key={c.id} value={c.id}>{c.name}{c.isActive ? '' : '（無効）'}</option>
              ))}
            </select>
            <Field label="取込参照（任意）">
              <input style={FIELD} value={f.linkedAccountRef} onChange={(e) => setForm((p) => ({ ...p, linkedAccountRef: e.target.value }))} />
            </Field>
            <button disabled={busy || !f.name.trim()} onClick={save} className="btn btn-ok">{editId ? '更新' : '追加'}</button>
            {editId && <button onClick={reset} className="btn">新規</button>}
          </div>
        )}
        <Msg msg={msg} />
      </section>

      {accountId === 0 ? (
        <p style={{ color: COLORS.muted }}>勘定科目を選ぶと、その配下の補助科目を管理できます。</p>
      ) : rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>この勘定に補助科目はありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>補助科目名</th>
              <th>既定税区分</th>
              <th>取引先</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((s) => (
              <tr key={s.id} style={s.isActive ? undefined : { color: COLORS.faint }}>
                <td>{s.name}</td>
                <td style={{ color: COLORS.muted }}>{taxLabel(s.defaultTaxCategoryId)}</td>
                <td style={{ color: COLORS.muted }}>{cpLabel(s.counterpartyId)}</td>
                <StatusCell active={s.isActive} />
                <RowActions active={s.isActive} onEdit={() => startEdit(s)} onToggle={() => toggle(s)} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// --- 部門 ------------------------------------------------------------------

export function DepartmentsPanel() {
  const { rows, editId, form: name, setForm: setName, msg, busy, reset, startEdit, save, toggle } = useMasterCrud<Department, string>({
    load: () => api.departments(true),
    empty: '',
    idOf: (d) => d.id,
    toForm: (d) => d.name,
    create: (n) => api.createDepartment(n),
    update: (id, n) => api.updateDepartment(id, n),
    setActive: (d) => api.setDepartmentActive(d.id, !d.isActive),
    canSave: (n) => Boolean(n.trim()),
  })

  return (
    <>
      <section style={SECTION}>
        <h3 style={{ margin: '0 0 8px' }}>{editId ? `部門を編集 #${editId}` : '部門を登録'}</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Field label="部門名 *">
            <input style={FIELD} value={name} onChange={(e) => setName(e.target.value)} />
          </Field>
          <button disabled={busy || !name.trim()} onClick={save} className="btn btn-ok">{editId ? '更新' : '登録'}</button>
          {editId && <button onClick={reset} className="btn">新規</button>}
        </div>
        <Msg msg={msg} />
      </section>
      {rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>部門がありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%', maxWidth: 520 }}>
          <thead>
            <tr>
              <th>部門名</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((d) => (
              <tr key={d.id} style={d.isActive ? undefined : { color: COLORS.faint }}>
                <td>{d.name}</td>
                <StatusCell active={d.isActive} />
                <RowActions active={d.isActive} onEdit={() => startEdit(d)} onToggle={() => toggle(d)} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// --- 品目 ------------------------------------------------------------------

export function ItemsPanel() {
  const { rows, editId, form: f, setForm, msg, busy, reset, startEdit, save, toggle } = useMasterCrud<Item, ItemInput>({
    load: () => api.items(true),
    empty: { name: '' },
    idOf: (it) => it.id,
    toForm: (it) => ({ name: it.name, itemCode: it.itemCode, unitPrice: it.unitPrice, unit: it.unit, taxRate: it.taxRate, withholding: it.withholding, detail: it.detail }),
    create: (form) => api.createItem(form),
    update: (id, form) => api.updateItem(id, form),
    setActive: (it) => api.setItemActive(it.id, !it.isActive),
    canSave: (form) => Boolean(form.name?.trim()),
  })
  const set = (patch: Partial<ItemInput>) => setForm((p) => ({ ...p, ...patch }))

  return (
    <>
      <section style={SECTION}>
        <h3 style={{ margin: '0 0 8px' }}>{editId ? `品目を編集 #${editId}` : '品目を登録'}</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="品目名 *">
            <input style={FIELD} value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <Field label="コード">
            <input style={FIELD} value={f.itemCode ?? ''} onChange={(e) => set({ itemCode: e.target.value })} />
          </Field>
          <Field label="単価">
            <input style={{ ...FIELD, width: 110, textAlign: 'right' }} type="number" min={0} step={1} value={f.unitPrice ?? ''} onChange={(e) => set({ unitPrice: e.target.value ? yenOrZero(e.target.value) : null })} />
          </Field>
          <Field label="単位">
            <input style={{ ...FIELD, width: 70 }} placeholder="個" value={f.unit ?? ''} onChange={(e) => set({ unit: e.target.value })} />
          </Field>
          <select value={f.taxRate ?? 0} onChange={(e) => set({ taxRate: Number(e.target.value) || null })}>
            <option value={0}>税率なし</option>
            <option value={10}>10%</option>
            <option value={8}>8%</option>
          </select>
          <label style={{ color: COLORS.sub }}>
            <input type="checkbox" checked={f.withholding ?? false} onChange={(e) => set({ withholding: e.target.checked })} /> 源泉
          </label>
          <button disabled={busy || !f.name?.trim()} onClick={save} className="btn btn-ok">{editId ? '更新' : '登録'}</button>
          {editId && <button onClick={reset} className="btn">新規</button>}
        </div>
        <Msg msg={msg} />
      </section>
      {rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>品目がありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>品目名</th>
              <th>コード</th>
              <th className="num">単価</th>
              <th>税率</th>
              <th>源泉</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((it) => (
              <tr key={it.id} style={it.isActive ? undefined : { color: COLORS.faint }}>
                <td>{it.name}</td>
                <td style={{ color: COLORS.muted }}>{it.itemCode ?? ''}</td>
                <td className="num">{it.unitPrice != null ? yen(it.unitPrice) : ''}</td>
                <td>{it.taxRate != null ? `${it.taxRate}%` : ''}</td>
                <td>{it.withholding ? '○' : ''}</td>
                <StatusCell active={it.isActive} />
                <RowActions active={it.isActive} onEdit={() => startEdit(it)} onToggle={() => toggle(it)} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}

// --- タグ ------------------------------------------------------------------
// 編集・有効/無効の無い別機械（追加と物理削除のみ）なので useMasterCrud の対象外（issue #133 の注意）。

export function TagsPanel() {
  const [rows, setRows] = useState<Tag[]>([])
  const [name, setName] = useState('')
  const [msg, setMsg] = useState<MsgState>(null)
  const [busy, setBusy] = useState(false)

  const [confirmDialog, ask] = useConfirm()
  const reload = () => api.tags().then(setRows).catch((e) => setMsg(errMsg(e)))
  useEffect(() => { reload() }, [])

  const add = async () => {
    if (!name.trim()) return
    setBusy(true); setMsg(null)
    try {
      await api.createTag(name)
      setName(''); await reload(); setMsg(okMsg('保存しました'))
    } catch (e) { setMsg(errMsg(e)) } finally { setBusy(false) }
  }
  const del = async (t: Tag) => {
    if (!(await ask(`タグ「${t.name}」を削除します。付与済みの仕訳からも外れます。`))) return
    api.deleteTag(t.id).then(reload).catch((e) => setMsg(errMsg(e)))
  }

  return (
    <>
      <section style={SECTION}>
        {confirmDialog}
        <h3 style={{ margin: '0 0 8px' }}>タグ</h3>
        <div style={{ display: 'flex', gap: 8, alignItems: 'flex-end' }}>
          <Field label="タグ名 *">
            <input style={FIELD} value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && add()} />
          </Field>
          <button disabled={busy || !name.trim()} onClick={add} className="btn btn-ok">追加</button>
        </div>
        <Msg msg={msg} />
      </section>
      {rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>タグがありません。</p>
      ) : (
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          {rows.map((t) => (
            <span key={t.id} style={{ display: 'inline-flex', gap: 8, alignItems: 'center', border: `1px solid ${COLORS.border}`, borderRadius: 999, padding: '2px 10px' }}>
              {t.name}
              <button onClick={() => del(t)} className="btn-link" style={{ color: COLORS.error, padding: 0 }}>×</button>
            </span>
          ))}
        </div>
      )}
    </>
  )
}

// --- 自動仕訳ルール --------------------------------------------------------

type RuleForm = {
  name: string
  priority: number
  direction: Rule['direction']
  matchField: Rule['matchField']
  matchOp: Rule['matchOp']
  matchValue: string
  resultAccountId: number
  resultSubAccountId: number
  resultTaxCategoryId: number
}
const emptyRule: RuleForm = {
  name: '',
  priority: 100,
  direction: 'any',
  matchField: 'description',
  matchOp: 'contains',
  matchValue: '',
  resultAccountId: 0,
  resultSubAccountId: 0,
  resultTaxCategoryId: 0,
}
/** フォーム（select は 0=なし）→ API ペイロード（0 → null）。 */
const rulePayload = (f: RuleForm): RuleInput => ({
  name: f.name,
  priority: f.priority,
  direction: f.direction,
  matchField: f.matchField,
  matchOp: f.matchOp,
  matchValue: f.matchValue,
  resultAccountId: f.resultAccountId,
  resultSubAccountId: f.resultSubAccountId || null,
  resultTaxCategoryId: f.resultTaxCategoryId || null,
})

export function RulesPanel() {
  const [accounts, setAccounts] = useState<Account[]>([])
  const [subAccounts, setSubAccounts] = useState<SubAccount[]>([])
  const [taxCats, setTaxCats] = useState<TaxCategory[]>([])
  const { rows, editId, form: f, setForm, msg, setMsg, busy, reload, reset, startEdit, save, toggle } = useMasterCrud<Rule, RuleForm>({
    load: () => api.rules(true),
    empty: emptyRule,
    idOf: (r) => r.id,
    toForm: (r) => ({
      name: r.name, priority: r.priority, direction: r.direction, matchField: r.matchField, matchOp: r.matchOp,
      matchValue: r.matchValue, resultAccountId: r.resultAccountId ?? 0, resultSubAccountId: r.resultSubAccountId ?? 0, resultTaxCategoryId: r.resultTaxCategoryId ?? 0,
    }),
    create: (form) => api.createRule(rulePayload(form)),
    update: (id, form) => api.updateRule(id, rulePayload(form)),
    setActive: (r) => api.setRuleActive(r.id, !r.isActive),
    canSave: (form) => Boolean(form.name.trim() && form.matchValue.trim() && form.resultAccountId),
  })

  useEffect(() => {
    api.accounts().then(setAccounts).catch((e) => setMsg(errMsg(e)))
    // 無効な補助科目も含める（既存ルールが無効先を参照していても編集時に表示・保持するため）。
    api.subAccounts(undefined, true).then(setSubAccounts).catch((e) => setMsg(errMsg(e)))
    api.taxCategories().then(setTaxCats).catch((e) => setMsg(errMsg(e)))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [confirmDialog, ask] = useConfirm()
  const set = (patch: Partial<RuleForm>) => setForm((p) => ({ ...p, ...patch }))
  const del = async (r: Rule) => {
    if (!(await ask(`ルール「${r.name}」を削除します。`))) return
    api.deleteRule(r.id).then(reload).catch((e) => setMsg(errMsg(e)))
  }

  const accName = (id: number | null) => accounts.find((a) => a.id === id)?.name ?? ''
  const resultSubs = subAccounts.filter((s) => s.accountId === f.resultAccountId)
  // range は金額のみ対象。op=range を選んだら field を amount に固定。
  const onOp = (op: Rule['matchOp']) => set(op === 'range' ? { matchOp: op, matchField: 'amount' } : { matchOp: op })

  return (
    <>
      <section style={SECTION}>
        {confirmDialog}
        <h3 style={{ margin: '0 0 8px' }}>{editId ? `ルールを編集 #${editId}` : '自動仕訳ルールを登録'}</h3>
        <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 8px' }}>
          取込明細が条件に一致すると、相手科目を自動付与します（優先度の小さい順に評価。履歴学習より優先）。
        </p>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'flex-end' }}>
          <Field label="ルール名 *">
            <input style={{ ...FIELD, minWidth: 160 }} value={f.name} onChange={(e) => set({ name: e.target.value })} />
          </Field>
          <label style={{ color: COLORS.sub }}>優先 <input style={{ ...FIELD, width: 64, textAlign: 'right' }} type="number" value={f.priority} onChange={(e) => set({ priority: e.target.value === '' ? f.priority : Number(e.target.value) })} /></label>
          <select value={f.direction} onChange={(e) => set({ direction: e.target.value as Rule['direction'] })}>
            {(['any', 'in', 'out'] as const).map((d) => <option key={d} value={d}>{DIRECTION_LABELS[d]}</option>)}
          </select>
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <span style={{ color: COLORS.sub }}>条件:</span>
          <select value={f.matchField} disabled={f.matchOp === 'range'} onChange={(e) => set({ matchField: e.target.value as Rule['matchField'] })}>
            {(['description', 'amount', 'source'] as const).map((x) => <option key={x} value={x}>{FIELD_LABELS[x]}</option>)}
          </select>
          <select value={f.matchOp} onChange={(e) => onOp(e.target.value as Rule['matchOp'])}>
            {(['contains', 'equals', 'regex', 'range'] as const).map((x) => <option key={x} value={x}>{OP_LABELS[x]}</option>)}
          </select>
          <input
            style={{ ...FIELD, minWidth: 200 }}
            placeholder={f.matchOp === 'range' ? '{"min":1000,"max":5000}' : '値（例 東京電力）'}
            value={f.matchValue}
            onChange={(e) => set({ matchValue: e.target.value })}
          />
        </div>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', marginTop: 8 }}>
          <span style={{ color: COLORS.sub }}>→ 相手科目:</span>
          <select value={f.resultAccountId} onChange={(e) => set({ resultAccountId: Number(e.target.value), resultSubAccountId: 0 })}>
            <option value={0}>科目を選択… *</option>
            {accounts.map((a) => <option key={a.id} value={a.id}>{a.name}</option>)}
          </select>
          <select value={f.resultSubAccountId} onChange={(e) => set({ resultSubAccountId: Number(e.target.value) })} disabled={resultSubs.length === 0}>
            <option value={0}>{resultSubs.length === 0 ? '補助 —' : '補助（なし）'}</option>
            {resultSubs.map((s) => <option key={s.id} value={s.id}>{s.name}</option>)}
          </select>
          <select value={f.resultTaxCategoryId} onChange={(e) => set({ resultTaxCategoryId: Number(e.target.value) })}>
            <option value={0}>税区分（既定）</option>
            {taxCats.map((t) => <option key={t.id} value={t.id}>{t.label}</option>)}
          </select>
          <button disabled={busy || !f.name.trim() || !f.matchValue.trim() || !f.resultAccountId} onClick={save} className="btn btn-ok">{editId ? '更新' : '登録'}</button>
          {editId && <button onClick={reset} className="btn">新規</button>}
        </div>
        <Msg msg={msg} />
      </section>

      {rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>ルールがありません。取込時の自動仕訳に使う条件を登録してください。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th className="num">優先</th>
              <th>名前</th>
              <th>方向</th>
              <th>条件</th>
              <th>→ 相手科目</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => (
              <tr key={r.id} style={r.isActive ? undefined : { color: COLORS.faint }}>
                <td className="num">{r.priority}</td>
                <td>{r.name}</td>
                <td style={{ color: COLORS.muted }}>{DIRECTION_LABELS[r.direction]}</td>
                <td style={{ color: COLORS.sub }}>{FIELD_LABELS[r.matchField]} {OP_LABELS[r.matchOp]} 「{r.matchValue}」</td>
                <td>{accName(r.resultAccountId)}</td>
                <StatusCell active={r.isActive} />
                <RowActions active={r.isActive} onEdit={() => startEdit(r)} onToggle={() => toggle(r)} onDelete={() => del(r)} />
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </>
  )
}
