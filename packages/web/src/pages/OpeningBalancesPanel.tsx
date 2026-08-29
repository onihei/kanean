import { useEffect, useState } from 'react'
import { COLORS, SECTION } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { yenOrZero } from '../lib/money.js'
import { Msg, errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import {
  api,
  type OpeningBalanceView,
  type BsAccountView,
  type BsSubAccountView,
  type OpeningBalanceTotals,
  type Counterparty,
} from '../api.js'

/** (科目, 補助) の一意キー。補助なしは 'a'。 */
const keyOf = (accountId: number, subAccountId: number | null) => `${accountId}:${subAccountId ?? 'a'}`

const cellInput: React.CSSProperties = {
  width: 130,
  textAlign: 'right',
  fontVariantNumeric: 'tabular-nums',
  padding: '3px 6px',
}

/**
 * 期首残高グリッド。全 BS 科目＋登録済み補助科目を一覧の格子にし、借方/貸方列で
 * インライン入力する。セルを空（0）にすると当該残高を削除。フッタで貸借合計と一致を表示
 * （data-model §2.7 の整合性チェックはサーバ集計＝`totals`）。補助科目は「設定 > 補助科目」で増やす。
 */
/** wire の side/normalBalance は string（DB text 由来）。UI の二値ロジックへ入る境界で絞る。 */
const asSide = (v: string): 'debit' | 'credit' => (v === 'credit' ? 'credit' : 'debit')

export function OpeningBalancesPanel({
  balances,
  accounts,
  subAccounts,
  totals,
  onChange,
}: {
  balances: OpeningBalanceView[]
  accounts: BsAccountView[]
  subAccounts: BsSubAccountView[]
  totals: OpeningBalanceTotals
  onChange: () => void
}) {
  const [msg, setMsg] = useState<MsgState>(null)
  const [busy, setBusy] = useState(false)

  const byKey = new Map(balances.map((b) => [keyOf(b.accountId, b.subAccountId), b]))
  const subsByAccount = new Map<number, BsSubAccountView[]>()
  for (const s of subAccounts) {
    const arr = subsByAccount.get(s.accountId) ?? []
    arr.push(s)
    subsByAccount.set(s.accountId, arr)
  }

  // 貸借対照表の三部（資産の部→負債の部→資本の部）で並べ替え、各部の先頭行に部名を見出しとして出す。
  const PART_ORDER: BsAccountView['part'][] = ['資産の部', '負債の部', '資本の部']
  const orderedAccounts = PART_ORDER.flatMap((part) =>
    accounts.filter((a) => a.part === part).map((a, i) => ({ a, partLabel: i === 0 ? part : '' })),
  )

  // 成否を返す。成功時のみ onChange でサーバから再読込（key 変化で行が再シード）。
  // 失敗時は再読込せず false を返し、呼び出し元の行がローカル入力をサーバ値へ戻す。
  const save = async (fn: () => Promise<unknown>): Promise<boolean> => {
    setBusy(true)
    setMsg(null)
    try {
      await fn()
      onChange()
      return true
    } catch (e) {
      setMsg(errMsg(e))
      return false
    } finally {
      setBusy(false)
    }
  }

  const upsert = (accountId: number, subAccountId: number | null, side: 'debit' | 'credit', amount: number) =>
    save(() => api.upsertOpeningBalance({ accountId, subAccountId, side, amount }))
  const remove = (id: number) => save(() => api.deleteOpeningBalance(id))

  const diff = totals.difference

  return (
    <section style={SECTION}>
      <h2>
        期首残高（開始残高）
        {busy && <span style={{ fontSize: 13, color: COLORS.muted, fontWeight: 400, marginLeft: 8 }}>保存中…</span>}
      </h2>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 12px' }}>
        貸借対照表科目の期首残高を直接入力します（青色決算書4ページ目 貸借の期首列を駆動）。
        各科目は本来の側のみ入力できます＝<strong>資産は借方（左）、負債・資本（元入金）は貸方（右）</strong>。
        セルを空にすると削除。取引先別の売掛・買掛の繰越は、下の「取引先別の繰越を追加」で取引先を選ぶと補助科目が作られ、各科目の下に行が増えます
        （請求書の起票で作られる補助科目と同じものに揃います）。
      </p>

      <AddCounterpartyCarryover accounts={accounts} onAdded={onChange} />

      <Msg msg={msg} />

      <table className="tbl" style={{ width: '100%', maxWidth: 760 }}>
        <thead>
          <tr>
            <th style={{ width: 76 }}>区分</th>
            <th>科目</th>
            <th className="num" style={{ width: 150 }}>借方（資産）</th>
            <th className="num" style={{ width: 150 }}>貸方（負債・資本）</th>
          </tr>
        </thead>
        <tbody>
          {orderedAccounts.map(({ a, partLabel }) => {
            const subs = subsByAccount.get(a.id) ?? []
            const acctRow = byKey.get(keyOf(a.id, null))
            return (
              <Rows key={a.id}>
                <BalanceRow
                  key={`${keyOf(a.id, null)}:${acctRow?.side ?? ''}:${acctRow?.amount ?? ''}`}
                  section={partLabel}
                  label={a.name}
                  normalBalance={asSide(a.normalBalance)}
                  existing={acctRow}
                  onUpsert={(side, amount) => upsert(a.id, null, side, amount)}
                  onDelete={remove}
                />
                {subs.map((s) => {
                  const subRow = byKey.get(keyOf(a.id, s.id))
                  return (
                    <BalanceRow
                      key={`${keyOf(a.id, s.id)}:${subRow?.side ?? ''}:${subRow?.amount ?? ''}`}
                      section=""
                      label={
                        <span style={{ color: COLORS.sub, paddingLeft: 16, display: 'flex', gap: 4, alignItems: 'flex-start' }}>
                          <span aria-hidden="true">└</span>
                          <span style={{ flex: 1, minWidth: 0, overflowWrap: 'anywhere' }}>{s.name}</span>
                        </span>
                      }
                      normalBalance={asSide(a.normalBalance)}
                      existing={subRow}
                      onUpsert={(side, amount) => upsert(a.id, s.id, side, amount)}
                      onDelete={remove}
                    />
                  )
                })}
              </Rows>
            )
          })}
        </tbody>
        <tfoot>
          <tr style={{ borderTop: `2px solid ${COLORS.border}`, fontWeight: 600 }}>
            <td colSpan={2}>
              合計
            </td>
            <td className="num">{yen(totals.totalDebit)}</td>
            <td className="num">{yen(totals.totalCredit)}</td>
          </tr>
          <tr>
            <td style={{ borderBottom: 'none' }} colSpan={4}>
              {totals.balanced ? (
                <span style={{ color: COLORS.ok }}>✓ 貸借一致</span>
              ) : (
                <span style={{ color: COLORS.error }}>
                  ⚠ 貸借不一致 差額 {yen(Math.abs(diff))}（{diff > 0 ? '借方' : '貸方'}が超過）
                  <span style={{ color: COLORS.muted, fontWeight: 400, marginLeft: 8 }}>
                    ※入力途中は不一致でも保存できますが、不一致のままでは年度繰越できません
                  </span>
                </span>
              )}
            </td>
          </tr>
        </tfoot>
      </table>
    </section>
  )
}

/** tbody 内で複数行をまとめて返すためのフラグメント別名（key 付与用）。 */
function Rows({ children }: { children: React.ReactNode }) {
  return <>{children}</>
}

/**
 * 取引先別の繰越（売掛/買掛）を追加する導線。勘定科目＋取引先を選ぶと取引先別補助科目を
 * get-or-create（既にあれば再利用＝重複なし）し、グリッドに行が増える。請求書起票と同じ補助科目に収束する。
 */
function AddCounterpartyCarryover({ accounts, onAdded }: { accounts: BsAccountView[]; onAdded: () => void }) {
  const [cps, setCps] = useState<Counterparty[]>([])
  const [accountId, setAccountId] = useState(0)
  const [counterpartyId, setCounterpartyId] = useState(0)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')

  useEffect(() => {
    api.counterparties().then(setCps).catch((e) => setErr(String(e)))
  }, [])
  // 既定の勘定科目は売掛金（典型）。無ければ未選択のまま。
  useEffect(() => {
    if (!accountId) {
      const ar = accounts.find((a) => a.name === '売掛金')
      if (ar) setAccountId(ar.id)
    }
  }, [accounts, accountId])

  const add = async () => {
    if (!accountId || !counterpartyId) return
    setBusy(true)
    setErr('')
    try {
      await api.linkCounterpartySubAccount({ accountId, counterpartyId })
      setCounterpartyId(0)
      onAdded()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 12px', padding: '8px 10px', background: COLORS.accentBg, borderRadius: 8 }}>
      <span style={{ color: COLORS.sub, fontSize: 13, fontWeight: 600 }}>取引先別の繰越を追加:</span>
      <select value={accountId} onChange={(e) => setAccountId(Number(e.target.value))}>
        <option value={0}>勘定科目…</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      <select value={counterpartyId} onChange={(e) => setCounterpartyId(Number(e.target.value))}>
        <option value={0}>取引先…</option>
        {cps.map((c) => (
          <option key={c.id} value={c.id}>{c.name}</option>
        ))}
      </select>
      <button type="button" disabled={busy || !accountId || !counterpartyId} onClick={add} className="btn">補助科目を追加</button>
      {cps.length === 0 && <span style={{ color: COLORS.muted, fontSize: 13 }}>取引先は「設定 &gt; 取引先」で登録できます。</span>}
      {err && <span style={{ color: COLORS.error, fontSize: 13 }}>{err}</span>}
    </div>
  )
}

/**
 * 1 科目（または補助科目）の期首残高セル。入力は本来の側（normalBalance）の1列のみ＝
 * 資産は借方、負債・資本は貸方。誤った側への入力を防ぎ、貸借対照表の形に揃える。
 * 既存残高が例外的に反対側にある場合（旧データ等）はその側を表示し編集・削除できる。
 * フォーカスを外した時点（onBlur）でサーバへ反映。空（0）にすると削除。
 */
function BalanceRow({
  section,
  label,
  normalBalance,
  existing,
  onUpsert,
  onDelete,
}: {
  section: string
  label: React.ReactNode
  normalBalance: 'debit' | 'credit'
  existing: OpeningBalanceView | undefined
  onUpsert: (side: 'debit' | 'credit', amount: number) => Promise<boolean>
  onDelete: (id: number) => Promise<boolean>
}) {
  // 入力する側＝既存があればその側、無ければ本来の側。これにより新規は必ず正常側へ入る。
  const side: 'debit' | 'credit' = existing ? asSide(existing.side) : normalBalance
  const seed = existing ? String(existing.amount) : ''
  const [val, setVal] = useState(seed)

  const commit = async () => {
    const amount = yenOrZero(val)
    let ok = true
    if (amount <= 0) {
      if (!existing) return // 元々無い空セル＝何もしない（無駄な API 呼び出しを避ける）
      ok = await onDelete(existing.id)
    } else {
      if (existing && existing.side === side && existing.amount === amount) return // 変化なし
      ok = await onUpsert(side, amount)
    }
    // 保存失敗時は再読込されないため、ローカル入力を直前のサーバ値へ戻す（誤った未保存値を残さない）。
    if (!ok) setVal(seed)
  }

  const cell = (
    <input
      type="number"
      min={0}
      step={1}
      style={cellInput}
      value={val}
      aria-label={side === 'debit' ? '借方' : '貸方'}
      onChange={(e) => setVal(e.target.value)}
      onBlur={() => void commit()}
    />
  )

  return (
    <tr>
      <td style={{ color: section ? COLORS.text : COLORS.muted, fontWeight: section ? 600 : 400, whiteSpace: 'nowrap' }}>
        {section}
      </td>
      <td>{label}</td>
      <td className="num">{side === 'debit' ? cell : null}</td>
      <td className="num">{side === 'credit' ? cell : null}</td>
    </tr>
  )
}
