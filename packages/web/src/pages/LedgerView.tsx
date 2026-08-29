import { useState, useEffect } from 'react'
import { formatHash, useHashRoute, type Route } from '../nav/route.js'
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { useReport } from '../lib/hooks.js'
import { BackLink, CsvButton } from '../components/common.js'
import { api } from '../api.js'
import type { LedgerRow, GeneralLedger, SubLedger, SubAccount } from '../api.js'

/** 元帳・補助元帳で共通の明細テーブル（時系列・累積残高）。 */
function LedgerRowsTable({ rows }: { rows: LedgerRow[] }) {
  return (
    <table className="tbl" style={{ width: '100%' }}>
      <thead>
        <tr>
          <th>日付</th>
          <th>摘要</th>
          <th>相手科目</th>
          <th className="num">借方</th>
          <th className="num">貸方</th>
          <th className="num">残高</th>
        </tr>
      </thead>
      <tbody>
        {rows.map((r, i) => (
          <tr key={`${r.entryId}-${i}`}>
            <td style={{ color: COLORS.sub }}>{r.entryDate}</td>
            <td>{r.description}</td>
            <td style={{ color: COLORS.muted }}>{r.counterAccount}</td>
            <td className="num">{r.debit ? yen(r.debit) : ''}</td>
            <td className="num">{r.credit ? yen(r.credit) : ''}</td>
            <td className="num">{yen(r.balance)}</td>
          </tr>
        ))}
      </tbody>
    </table>
  )
}

export function LedgerView({
  accountId,
  subId,
}: {
  accountId: number
  /** 補助元帳（URL の `/sub/<id>` セグメント・issue #136）。科目が変われば URL ごと消える。 */
  subId?: number
}) {
  const { tab } = useHashRoute()
  const { data, err, loading } = useReport<GeneralLedger>(() => api.ledger(accountId), [accountId])
  const [subs, setSubs] = useState<SubAccount[]>([])
  useEffect(() => {
    // 無効化済みの補助科目も含める（過去明細を持つ補助元帳に到達できるように）。
    api.subAccounts(accountId, true).then(setSubs).catch(() => setSubs([]))
  }, [accountId])

  if (subId != null)
    return <SubLedgerView subAccountId={subId} backTo={{ tab, ledgerAccountId: accountId }} />

  return (
    <>
      <BackLink to={{ tab }} />
      {loading && <p>…</p>}
      {err && <p style={{ color: COLORS.error }}>{err}</p>}
      {data && (
        <>
          <h2>総勘定元帳：{data.accountName}<CsvButton path={`/api/reports/ledger/${accountId}/csv`} filename={`総勘定元帳_${data.accountName}.csv`} /></h2>
          <p style={{ color: COLORS.muted }}>期首残高 {yen(data.openingBalance)} ／ 期末残高 {yen(data.closingBalance)}</p>
          {subs.length > 0 && (
            <p style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 8px' }}>
              <span style={{ color: COLORS.sub, fontSize: 13 }}>補助元帳:</span>
              {subs.map((s) => (
                <a
                  key={s.id}
                  href={formatHash({ tab, ledgerAccountId: accountId, ledgerSubId: s.id })}
                  className="btn-link" style={{ padding: '0 6px', textDecoration: 'none', color: s.isActive ? COLORS.accent : COLORS.muted }}
                >
                  {s.name}{s.isActive ? '' : '（無効）'}
                </a>
              ))}
            </p>
          )}
          <LedgerRowsTable rows={data.rows} />
        </>
      )}
    </>
  )
}

function SubLedgerView({ subAccountId, backTo }: { subAccountId: number; backTo: Route }) {
  const { data, err, loading } = useReport<SubLedger>(() => api.subLedger(subAccountId), [subAccountId])
  return (
    <>
      <BackLink to={backTo} />
      {loading && <p>…</p>}
      {err && <p style={{ color: COLORS.error }}>{err}</p>}
      {data && (
        <>
          <h2>補助元帳：{data.accountName} ／ {data.subAccountName}<CsvButton path={`/api/reports/sub-ledger/${subAccountId}/csv`} filename={`補助元帳_${data.accountName}_${data.subAccountName}.csv`} /></h2>
          <p style={{ color: COLORS.muted }}>期首残高 {yen(data.openingBalance)} ／ 期末残高 {yen(data.closingBalance)}</p>
          <LedgerRowsTable rows={data.rows} />
        </>
      )}
    </>
  )
}
