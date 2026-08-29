import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { useReport } from '../lib/hooks.js'
import { AccountLink, NoYear, CsvButton } from '../components/common.js'
import { api } from '../api.js'
import type { MonthlyTrend } from '../api.js'

export function TrendTab() {
  const { data, err, loading } = useReport<MonthlyTrend>(api.monthlyTrend)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  if (data.rows.length === 0) return <p style={{ color: COLORS.muted }}>確定済みの仕訳がありません。</p>

  const monthLabel = (ym: string) => `${Number(ym.slice(5))}月`
  const cell = (n: number) => (n ? yen(n) : '')

  return (
    <>
      <h2>月次推移表<CsvButton path="/api/reports/monthly-trend.csv" filename="月次推移表.csv" /></h2>
      <p style={{ color: COLORS.muted, fontSize: 13 }}>各月の発生高（normal_balance 方向の純増減）。確定済み仕訳のみ。</p>
      <div style={{ overflowX: 'auto' }}>
        <table className="tbl">
          <thead>
            <tr>
              <th className="sticky">勘定科目</th>
              {data.months.map((m) => (
                <th key={m} className="num">{monthLabel(m)}</th>
              ))}
              <th className="num">合計</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.accountId}>
                <td className="sticky">
                  <AccountLink id={r.accountId} name={r.accountName} />
                </td>
                {r.monthly.map((v, i) => (
                  <td key={i} className="num">{cell(v)}</td>
                ))}
                <td className="num" style={{ fontWeight: 600 }}>{yen(r.total)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </>
  )
}
