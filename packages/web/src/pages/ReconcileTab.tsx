import { useReport } from '../lib/hooks.js'
import { NoYear } from '../components/common.js'
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { api, type ReconcileReport } from '../api.js'

export function ReconcileTab() {
  const { data, err, loading } = useReport<ReconcileReport>(api.reconciliation)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />

  return (
    <>
      <h2>残高突合</h2>
      <p style={{ color: COLORS.muted, fontSize: 13 }}>
        取込済みの銀行明細を口座別・時系列に並べ、CSVの差引残高と累積（入金+/出金−）の連続性を検証します。
        差異は<strong>取りこぼし（未取込の取引）</strong>の疑いです。カード等の残高列が無い明細は対象外。
      </p>
      {data.accounts.length === 0 ? (
        <p style={{ color: COLORS.muted }}>残高列を持つ取込明細がありません（銀行CSVを取り込むと突合できます）。</p>
      ) : (
        data.accounts.map((acc) => (
          <section key={acc.accountRef} style={{ margin: '1rem 0', border: `1px solid ${COLORS.borderFaint}`, borderRadius: 8, padding: '12px 16px' }}>
            <h3 style={{ margin: '0 0 6px' }}>
              {acc.accountRef}{' '}
              {acc.balanced ? (
                <span style={{ color: COLORS.ok, fontSize: 13 }}>✓ 残高整合（{acc.rowCount}件）</span>
              ) : (
                <span style={{ color: COLORS.error, fontSize: 13 }}>⚠ 差異 {acc.gaps.length}件（{acc.rowCount}件中）</span>
              )}
              <span style={{ color: COLORS.muted, fontSize: 13, marginLeft: 10 }}>最新残高 {acc.lastBalance != null ? yen(acc.lastBalance) : '—'}</span>
            </h3>
            {acc.gaps.length > 0 && (
              <>
                <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 6px' }}>
                  下記の行は「取引前残高」で終わる直前取引が取込内に見つかりません＝間に未取込の取引（取りこぼし）がある疑いです。
                </p>
                <table className="tbl">
                  <thead>
                    <tr>
                      <th>行（取りこぼしの直後）</th>
                      <th className="num">取引前残高（期待）</th>
                      <th className="num">金額</th>
                      <th className="num">残高</th>
                    </tr>
                  </thead>
                  <tbody>
                    {acc.gaps.map((g, i) => (
                      <tr key={i}>
                        <td>{g.date}（{g.description ?? '—'}）</td>
                        <td className="num" style={{ color: COLORS.error }}>{yen(g.expectedPrevBalance)}</td>
                        <td className="num">{g.delta > 0 ? '+' : ''}{yen(g.delta)}</td>
                        <td className="num">{yen(g.balance)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </>
            )}
          </section>
        ))
      )}
    </>
  )
}
