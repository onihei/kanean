/** 科目セレクト＋（補助科目があれば）補助セレクト（issue #131 で EasyEntryForm から抽出）。 */
import type { Account, SubAccount } from '../api.js'

export function AccountPicker({
  accounts,
  subAccounts,
  accountId,
  subId,
  onAccount,
  onSub,
  placeholder,
}: {
  accounts: Account[]
  subAccounts: SubAccount[]
  accountId: number
  subId: number
  onAccount: (id: number) => void
  onSub: (id: number) => void
  placeholder: string
}) {
  const subs = subAccounts.filter((s) => s.accountId === accountId)
  return (
    <>
      <select value={accountId} onChange={(e) => onAccount(Number(e.target.value))}>
        <option value={0}>{placeholder}</option>
        {accounts.map((a) => (
          <option key={a.id} value={a.id}>{a.name}</option>
        ))}
      </select>
      {subs.length > 0 && (
        <select value={subId} onChange={(e) => onSub(Number(e.target.value))}>
          <option value={0}>（補助なし）</option>
          {subs.map((s) => (
            <option key={s.id} value={s.id}>{s.name}</option>
          ))}
        </select>
      )}
    </>
  )
}
