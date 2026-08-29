/**
 * かんたん入力（現金・預金の出入りを1行で起票する簡易フォーム）。
 * 支出/収入/振替を選び、日付・金額・勘定科目・決済口座・摘要だけで2行の複式仕訳を組み立てて
 * 既存の POST /entries に送る。税区分はサーバ側の自動解決（科目既定→内税逆算）に乗るため UI では扱わない。
 */
import { COLORS } from '../lib/styles.js'
import { useMemo, useRef, useState } from 'react'
import { api, type Account, type SubAccount, type Counterparty, type ManualEntryLineInput } from '../api.js'
import { yen } from '../lib/format.js'
import { Msg, okMsg, errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import { yenOrZero } from '../lib/money.js'
import { toLineInput, type EntryLine } from '../lib/entryLine.js'
import { AccountPicker } from '../components/AccountPicker.js'

type Kind = 'expense' | 'income' | 'transfer'

const KINDS: { value: Kind; label: string; color: string }[] = [
  { value: 'expense', label: '支出', color: COLORS.error },
  { value: 'income', label: '収入', color: COLORS.ok },
  { value: 'transfer', label: '振替', color: COLORS.accent },
]

// 科目候補の絞り込み（accounts.category = 標準チャートの「分類」列）。
// 支出の相手科目: 費用系の分類（経費・仕入・専従者給与等）。
const EXPENSE_CATEGORIES = new Set(['経費', '当期仕入高', '繰入額等'])
// お金の動く側（決済口座）: 現金/預金に加え、プライベート資金（事業主借/貸）・掛け（売掛/買掛・未払金）。
// 事業主貸/借は分類でなく科目名で絞る（同分類に資産譲渡損など口座でない科目が混在するため）。
const isCashLike = (a: Account) => a.category === '現金及び預金'
const isPaySource = (a: Account) =>
  isCashLike(a) || a.name === '事業主借' || a.category === '仕入債務' || a.name === '未払金'
const isDepositTarget = (a: Account) =>
  isCashLike(a) || a.name === '事業主貸' || a.category === '売上債権'

const todayLocal = () => {
  const d = new Date()
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={{ display: 'flex', alignItems: 'center', gap: 12, margin: '10px 0' }}>
      <span style={{ width: 84, color: COLORS.sub, fontSize: 13, flexShrink: 0 }}>{label}</span>
      <div style={{ flex: 1, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>{children}</div>
    </div>
  )
}

export function EasyEntryForm({
  accounts,
  subAccounts,
  counterparties,
}: {
  accounts: Account[]
  subAccounts: SubAccount[]
  counterparties: Counterparty[]
}) {
  const [kind, setKind] = useState<Kind>('expense')
  const [date, setDate] = useState(todayLocal())
  const [amount, setAmount] = useState(0)
  const [targetId, setTargetId] = useState(0)
  const [targetSubId, setTargetSubId] = useState(0)
  const [fundId, setFundId] = useState(0)
  const [fundSubId, setFundSubId] = useState(0)
  const [counterpartyId, setCounterpartyId] = useState(0)
  const [description, setDescription] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)
  const amountRef = useRef<HTMLInputElement>(null)

  // 種別ごとの科目候補。target=損益科目（振替では移動先口座）、fund=決済口座（振替では移動元）。
  const targets = useMemo(() => {
    if (kind === 'expense') return accounts.filter((a) => EXPENSE_CATEGORIES.has(a.category))
    if (kind === 'income') return accounts.filter((a) => a.category === '売上（収入）金額')
    return accounts.filter((a) => isPaySource(a) || isDepositTarget(a))
  }, [accounts, kind])
  const funds = useMemo(() => {
    if (kind === 'expense') return accounts.filter(isPaySource)
    if (kind === 'income') return accounts.filter(isDepositTarget)
    return accounts.filter((a) => isPaySource(a) || isDepositTarget(a))
  }, [accounts, kind])

  const switchKind = (k: Kind) => {
    setKind(k)
    setMsg(null)
    // 候補リストが変わるので、新リストに無い選択はリセット（残っていれば維持）。
    setTargetId(0)
    setTargetSubId(0)
    setCounterpartyId(0)
    const fundStill =
      k === 'expense' ? accounts.some((a) => a.id === fundId && isPaySource(a))
      : k === 'income' ? accounts.some((a) => a.id === fundId && isDepositTarget(a))
      : accounts.some((a) => a.id === fundId && (isPaySource(a) || isDepositTarget(a)))
    if (!fundStill) {
      setFundId(0)
      setFundSubId(0)
    }
  }

  const sameTransferAccount = kind === 'transfer' && targetId === fundId && targetSubId === fundSubId
  const ready =
    !!date && amount > 0 && Number.isInteger(amount) && targetId > 0 && fundId > 0 && !sameTransferAccount

  const nameOf = (id: number) => accounts.find((a) => a.id === id)?.name ?? ''
  // 複式の組み立て: 支出=借方科目/貸方口座、収入=借方口座/貸方科目、振替=借方移動先/貸方移動元。
  // 0→null の変換規約は lib/entryLine の toLineInput に一本化（issue #131）。
  const buildLines = (): ManualEntryLineInput[] => {
    const targetLine: EntryLine = {
      side: kind === 'income' ? 'credit' : 'debit',
      accountId: targetId,
      amount,
      subAccountId: targetSubId,
      counterpartyId: kind === 'transfer' ? 0 : counterpartyId,
      departmentId: 0,
    }
    const fundLine: EntryLine = {
      side: kind === 'income' ? 'debit' : 'credit',
      accountId: fundId,
      amount,
      subAccountId: fundSubId,
      counterpartyId: 0,
      departmentId: 0,
    }
    return (kind === 'income' ? [fundLine, targetLine] : [targetLine, fundLine]).map(toLineInput)
  }

  const submit = async (status: 'draft' | 'confirmed') => {
    setBusy(true)
    setMsg(null)
    try {
      await api.createEntry({ entryDate: date, description: description || null, status, lines: buildLines() })
      setMsg(
        okMsg(
          `${status === 'confirmed' ? '登録しました' : '下書きとして保存しました'}：${date} ${nameOf(targetId)} ${yen(amount)}`,
        ),
      )
      // 連続入力しやすいよう日付・科目・口座は保持し、金額と摘要だけクリアして金額へフォーカス。
      setAmount(0)
      setDescription('')
      amountRef.current?.focus()
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const kindDef = KINDS.find((k) => k.value === kind)!
  const targetLabel = kind === 'transfer' ? '振替先' : '勘定科目'
  const fundLabel = kind === 'expense' ? '支払元' : kind === 'income' ? '入金先' : '振替元'

  return (
    <section style={{ maxWidth: 560, border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '16px 20px' }}>
      <div style={{ display: 'flex', gap: 8, marginBottom: 12 }}>
        {KINDS.map((k) => (
          <button
            key={k.value}
            onClick={() => switchKind(k.value)}
            style={{
              flex: 1,
              padding: '8px 0',
              borderRadius: 8,
              border: kind === k.value ? `2px solid ${k.color}` : `1px solid ${COLORS.border}`,
              background: kind === k.value ? `${k.color}14` : COLORS.surface,
              color: kind === k.value ? k.color : COLORS.sub,
              fontWeight: kind === k.value ? 700 : 400,
              fontSize: 15,
              cursor: 'pointer',
            }}
          >
            {k.label}
          </button>
        ))}
      </div>

      <Row label="日付">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} />
      </Row>
      <Row label="金額（税込）">
        <input
          ref={amountRef}
          type="number"
          min={1}
          step={1}
          placeholder="0"
          value={amount || ''}
          onChange={(e) => setAmount(yenOrZero(e.target.value))}
          style={{ width: 160, fontSize: 20, textAlign: 'right', padding: '4px 8px' }}
        />
        <span style={{ color: COLORS.sub }}>円</span>
      </Row>
      <Row label={fundLabel}>
        <AccountPicker
          accounts={funds}
          subAccounts={subAccounts}
          accountId={fundId}
          subId={fundSubId}
          onAccount={(id) => { setFundId(id); setFundSubId(0) }}
          onSub={setFundSubId}
          placeholder="口座を選択…"
        />
      </Row>
      <Row label={targetLabel}>
        <AccountPicker
          accounts={targets}
          subAccounts={subAccounts}
          accountId={targetId}
          subId={targetSubId}
          onAccount={(id) => { setTargetId(id); setTargetSubId(0) }}
          onSub={setTargetSubId}
          placeholder={kind === 'transfer' ? '口座を選択…' : '科目を選択…'}
        />
        {sameTransferAccount && targetId > 0 && (
          <span style={{ color: COLORS.error, fontSize: 13 }}>振替元と同じ口座です</span>
        )}
      </Row>
      {kind !== 'transfer' && (
        <Row label="取引先">
          <select value={counterpartyId} onChange={(e) => setCounterpartyId(Number(e.target.value))}>
            <option value={0}>（なし）</option>
            {counterparties.map((cp) => (
              <option key={cp.id} value={cp.id}>{cp.name}</option>
            ))}
          </select>
        </Row>
      )}
      <Row label="摘要">
        <input
          placeholder={kind === 'expense' ? '例: プリンタ用紙' : kind === 'income' ? '例: 6月分請求' : '例: 売上代金の振込'}
          style={{ flex: 1, minWidth: 200 }}
          value={description}
          onChange={(e) => setDescription(e.target.value)}
        />
      </Row>

      {ready && (
        <p style={{ color: COLORS.muted, fontSize: 13, margin: '4px 0 0 96px' }}>
          仕訳: 借方 {kind === 'income' ? nameOf(fundId) : nameOf(targetId)} {yen(amount)} ／ 貸方{' '}
          {kind === 'income' ? nameOf(targetId) : nameOf(fundId)} {yen(amount)}
        </p>
      )}

      <div style={{ display: 'flex', gap: 8, marginTop: 14 }}>
        <span style={{ flex: 1 }} />
        <button disabled={busy || !ready} onClick={() => submit('draft')} className="btn">下書き保存</button>
        <button
          disabled={busy || !ready}
          onClick={() => submit('confirmed')}
          style={{
            background: ready ? kindDef.color : undefined,
            color: ready ? '#fff' : undefined,
            border: 'none',
            borderRadius: 6,
            padding: '6px 18px',
            fontWeight: 600,
            cursor: ready ? 'pointer' : 'default',
          }}
        >
          登録する
        </button>
      </div>
      <Msg msg={msg} />
    </section>
  )
}
