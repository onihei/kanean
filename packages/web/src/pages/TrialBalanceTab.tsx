import { useState } from 'react'
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { useReport } from '../lib/hooks.js'
import { usePeriodFilter } from '../lib/useListFilter.js'
import { AccountLink, NoYear, CsvButton, SegTabs } from '../components/common.js'
import { useCompare, CompareCells, COMPARE_TH, NoPriorNote } from '../components/compare.js'
import { api, qsOf } from '../api.js'
import type { TrialBalance, ComparativeTrialBalance } from '../api.js'

export function TrialBalanceTab() {
  const [view, setView] = useState<'normal' | 'compare'>('normal')
  return (
    <>
      <h2>合計残高試算表</h2>
      <SegTabs
        value={view}
        onChange={setView}
        options={[{ value: 'normal', label: '当期（期間指定）' }, { value: 'compare', label: '前期比較' }]}
      />
      {view === 'normal' ? <TrialBalanceNormalView /> : <TbCompareView />}
    </>
  )
}

function TrialBalanceNormalView() {
  // 期間フィルタ（即時適用・月次ショートカット付き。アプリ共通の操作モデル＝lib/useListFilter #249）。
  const { from, setFrom, to, setTo, month, pickMonth, clear, period } = usePeriodFilter()
  const { data, err, loading } = useReport<TrialBalance>(() => api.trialBalance(period), [period.from, period.to])

  const csvPath = () => `/api/reports/trial-balance.csv${qsOf({ from: period.from, to: period.to })}`
  const periodLabel = period.from ? `${period.from} 〜 ${period.to ?? ''}（期間発生高）` : period.to ? `${period.to} 時点（累計）` : '年間（期首〜期末）'

  return (
    <>
      <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0.25rem 0 0.75rem' }}>
        <label style={{ color: COLORS.sub }}>月次 <input type="month" value={month} onChange={(e) => pickMonth(e.target.value)} /></label>
        <span style={{ color: COLORS.border }}>|</span>
        <label style={{ color: COLORS.sub }}>期間 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <span style={{ color: COLORS.muted }}>〜</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button onClick={clear} className="btn">全期間</button>
        <span style={{ color: COLORS.muted, fontSize: 13 }}>{periodLabel}</span>
        <CsvButton path={csvPath()} filename="試算表.csv" />
      </section>
      {loading ? (
        <p>…</p>
      ) : err ? (
        <p style={{ color: COLORS.error }}>{err}</p>
      ) : !data ? (
        <NoYear />
      ) : data.rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>該当期間の確定済み仕訳がありません。</p>
      ) : (
        <>
          {!data.balanced && <p style={{ color: COLORS.error }}>⚠ 貸借不一致</p>}
          <table className="tbl" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>区分</th>
                <th>勘定科目</th>
                <th className="num">借方合計</th>
                <th className="num">貸方合計</th>
                <th className="num">残高</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.accountId}>
                  <td style={{ color: COLORS.muted }}>{r.section}</td>
                  <td><AccountLink id={r.accountId} name={r.accountName} /></td>
                  <td className="num">{r.totalDebit ? yen(r.totalDebit) : ''}</td>
                  <td className="num">{r.totalCredit ? yen(r.totalCredit) : ''}</td>
                  <td className="num">{yen(r.balance)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td colSpan={2}>合計</td>
                <td className="num">{yen(data.totalDebit)}</td>
                <td className="num">{yen(data.totalCredit)}</td>
                <td className="num"></td>
              </tr>
            </tfoot>
          </table>
        </>
      )}
    </>
  )
}

function TbCompareView() {
  const { data, err, loading, picker, csvQs } = useCompare<ComparativeTrialBalance>(api.compareTrialBalance)
  return (
    <>
      <section style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {picker}
        <CsvButton path={`/api/reports/comparison/trial-balance.csv${csvQs()}`} filename="試算表_前期比較.csv" />
      </section>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 0.5rem' }}>科目別残高（年間・期首〜期末）の当期/前期比較。</p>
      {loading ? (
        <p>…</p>
      ) : err ? (
        <p style={{ color: COLORS.error }}>{err}</p>
      ) : !data ? (
        <NoYear />
      ) : data.rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>確定済みの仕訳がありません。</p>
      ) : (
        <>
          {!data.hasPrior && <NoPriorNote />}
          <table className="tbl" style={{ width: '100%' }}>
            <thead>
              <tr>
                <th>区分</th>
                <th>勘定科目</th>
                {COMPARE_TH}
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.accountId}>
                  <td style={{ color: COLORS.muted }}>{r.section}</td>
                  <td><AccountLink id={r.accountId} name={r.accountName} /></td>
                  <CompareCells c={r} />
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}
