/**
 * 仕訳明細エディタ（issue #131）。ManualEntryTab（複合仕訳の新規起票）と JournalTab
 * （確定取消後の編集）で二重実装だった「行操作＋貸借集計＋明細テーブル」を1実装に。
 * 純ロジック（entryTotals / entriesReady）は lib/entryLine.ts にありテスト対象。
 *
 * マスタ props（subAccounts / counterparties / departments）を省略するとその列は非表示になり、
 * **値は保持される**（保存で消えない）。見た目は旧2実装の差（maxWidth 980/640・fontSize 14/13・
 * thead 有無）を thead あり・fontSize 14・maxWidth 980 に正規化した。
 */
import { useState } from 'react'
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { yenOrZero } from '../lib/money.js'
import { type EntryLine, type EntryTotals, emptyLine, entryTotals } from '../lib/entryLine.js'
import type { Account, SubAccount, Counterparty, Department, Side } from '../api.js'

/** 明細行の状態と操作（行の追加/削除/更新＋貸借集計）。 */
export function useEntryLines(initial: () => EntryLine[]): EntryLinesState {
  const [lines, setLines] = useState<EntryLine[]>(initial)
  return {
    lines,
    totals: entryTotals(lines),
    setLine: (i, patch) => setLines((prev) => prev.map((l, j) => (j === i ? { ...l, ...patch } : l))),
    addLine: (side) => setLines((prev) => [...prev, emptyLine(side)]),
    // 複式の最小形（借1:貸1）を下回る削除はしない
    removeLine: (i) => setLines((prev) => (prev.length > 2 ? prev.filter((_, j) => j !== i) : prev)),
    reset: (next) => setLines(next),
  }
}

export interface EntryLinesState {
  lines: EntryLine[]
  totals: EntryTotals
  setLine: (i: number, patch: Partial<EntryLine>) => void
  addLine: (side: Side) => void
  removeLine: (i: number) => void
  reset: (next: EntryLine[]) => void
}

/** 行追加ボタン（ラベルも統一）。配置は画面ごとに違うのでエディタ本体とは分けて置く。 */
export function AddLineButtons({ state }: { state: EntryLinesState }) {
  return (
    <>
      <button onClick={() => state.addLine('debit')} className="btn">＋借方行</button>
      <button onClick={() => state.addLine('credit')} className="btn">＋貸方行</button>
    </>
  )
}

export function EntryLinesEditor({
  state,
  accounts,
  subAccounts,
  counterparties,
  departments,
}: {
  state: EntryLinesState
  accounts: Account[]
  /** 省略した列は非表示（値は保持され、保存で消えない）。 */
  subAccounts?: SubAccount[]
  counterparties?: Counterparty[]
  departments?: Department[]
}) {
  const { lines, totals, setLine, removeLine } = state
  // 金額の手前までの列数（借/貸・科目＋出しているマスタ列）。フッタの colSpan に使う。
  const leadCols = 2 + (subAccounts ? 1 : 0) + (counterparties ? 1 : 0) + (departments ? 1 : 0)
  return (
    <table className="tbl" style={{ width: '100%', maxWidth: 980 }}>
      <thead>
        <tr>
          <th>借/貸</th>
          <th>勘定科目</th>
          {subAccounts && <th>補助科目</th>}
          {counterparties && <th>取引先</th>}
          {departments && <th>部門</th>}
          <th className="num">金額</th>
          <th></th>
        </tr>
      </thead>
      <tbody>
        {lines.map((l, i) => {
          const lineSubs = subAccounts?.filter((s) => s.accountId === l.accountId) ?? []
          return (
            <tr key={i}>
              <td>
                <select value={l.side} onChange={(e) => setLine(i, { side: e.target.value as Side })}>
                  <option value="debit">借方</option>
                  <option value="credit">貸方</option>
                </select>
              </td>
              <td>
                <select value={l.accountId} onChange={(e) => setLine(i, { accountId: Number(e.target.value), subAccountId: 0 })}>
                  <option value={0}>科目を選択…</option>
                  {accounts.map((a) => (
                    <option key={a.id} value={a.id}>{a.name}</option>
                  ))}
                </select>
              </td>
              {subAccounts && (
                <td>
                  <select value={l.subAccountId} onChange={(e) => setLine(i, { subAccountId: Number(e.target.value) })} disabled={lineSubs.length === 0}>
                    <option value={0}>{lineSubs.length === 0 ? '—' : '（なし）'}</option>
                    {lineSubs.map((s) => (
                      <option key={s.id} value={s.id}>{s.name}</option>
                    ))}
                  </select>
                </td>
              )}
              {counterparties && (
                <td>
                  <select value={l.counterpartyId} onChange={(e) => setLine(i, { counterpartyId: Number(e.target.value) })}>
                    <option value={0}>（なし）</option>
                    {counterparties.map((cp) => (
                      <option key={cp.id} value={cp.id}>{cp.name}</option>
                    ))}
                  </select>
                </td>
              )}
              {departments && (
                <td>
                  <select value={l.departmentId} onChange={(e) => setLine(i, { departmentId: Number(e.target.value) })} disabled={departments.length === 0}>
                    <option value={0}>{departments.length === 0 ? '—' : '（なし）'}</option>
                    {departments.map((d) => (
                      <option key={d.id} value={d.id}>{d.name}</option>
                    ))}
                  </select>
                </td>
              )}
              <td className="num">
                <input
                  type="number"
                  min={0}
                  step={1}
                  style={{ width: 120, textAlign: 'right' }}
                  value={l.amount || ''}
                  onChange={(e) => setLine(i, { amount: yenOrZero(e.target.value) })}
                />
              </td>
              <td>
                {lines.length > 2 && (
                  <button onClick={() => removeLine(i)} className="btn-link" style={{ color: COLORS.error, padding: 0 }}>削除</button>
                )}
              </td>
            </tr>
          )
        })}
      </tbody>
      <tfoot>
        <tr style={{ fontWeight: 600 }}>
          <td colSpan={leadCols}>
            借方計 {yen(totals.debitTotal)} ／ 貸方計 {yen(totals.creditTotal)}
          </td>
          <td className="num" style={{ color: totals.balanced ? COLORS.ok : COLORS.error }}>
            {totals.balanced ? '一致' : `差額 ${yen(totals.diff)}`}
          </td>
          <td></td>
        </tr>
      </tfoot>
    </table>
  )
}
