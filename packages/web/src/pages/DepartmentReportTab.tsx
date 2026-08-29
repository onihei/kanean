import { useState } from 'react'
import { COLORS, WARN_BANNER } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { useReport } from '../lib/hooks.js'
import { usePeriodFilter } from '../lib/useListFilter.js'
import { AccountLink, NoYear, CsvButton, SegTabs } from '../components/common.js'
import { api, qsOf } from '../api.js'
import type { DepartmentProfitAndLoss, DepartmentTrialBalance } from '../api.js'

type DeptView = 'pl' | 'trial'

const deptCell = (n: number) => (n ? yen(n) : '')
/** 部門列が「未配賦」しか無い＝部門を付与した明細が無い。 */
const onlyUnassigned = (cols: { departmentId: number | null }[]) =>
  cols.length === 1 && cols[0].departmentId === null

export function DepartmentReportTab() {
  const [view, setView] = useState<DeptView>('pl')
  // 期間フィルタ（即時適用・月次ショートカット付き。アプリ共通の操作モデル＝lib/useListFilter #249）。
  const { from, setFrom, to, setTo, month, pickMonth, clear, period } = usePeriodFilter()

  const base = view === 'pl' ? '/api/reports/department-pl' : '/api/reports/department-trial-balance'
  const csvPath = () => `${base}.csv${qsOf({ from: period.from, to: period.to })}`
  const periodLabel = period.from ? `${period.from} 〜 ${period.to ?? ''}` : period.to ? `${period.to} 時点まで` : '年間'

  return (
    <>
      <h2>部門別{view === 'pl' ? '損益計算書' : '試算表'}<CsvButton path={csvPath()} filename={`${view === 'pl' ? '部門別損益計算書' : '部門別試算表'}.csv`} /></h2>
      <p style={{ color: COLORS.muted, fontSize: 13 }}>部門を付与した確定済み明細の期中発生高（開始残高は含みません）。</p>
      <SegTabs value={view} onChange={setView} options={[{ value: 'pl', label: '損益計算書' }, { value: 'trial', label: '試算表' }]} />
      <section style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 0.75rem' }}>
        <label style={{ color: COLORS.sub }}>月次 <input type="month" value={month} onChange={(e) => pickMonth(e.target.value)} /></label>
        <span style={{ color: COLORS.border }}>|</span>
        <label style={{ color: COLORS.sub }}>期間 <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} /></label>
        <span style={{ color: COLORS.muted }}>〜</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} />
        <button onClick={clear} className="btn">全期間</button>
        <span style={{ color: COLORS.muted, fontSize: 13 }}>{periodLabel}</span>
      </section>
      {view === 'pl' ? <DeptPlView applied={period} /> : <DeptTrialView applied={period} />}
    </>
  )
}

function DeptNoData({ cols }: { cols: { departmentId: number | null }[] }) {
  if (cols.length === 0) return <p style={{ color: COLORS.muted }}>該当期間の確定済み仕訳がありません。</p>
  if (onlyUnassigned(cols))
    return <p style={WARN_BANNER}>部門を付与した明細がありません。すべて「未配賦」として表示しています（明細に部門を設定すると部門別に分かれます）。</p>
  return null
}

function DeptPlView({ applied }: { applied: { from?: string; to?: string } }) {
  const { data, err, loading } = useReport<DepartmentProfitAndLoss>(() => api.departmentPl(applied), [applied.from, applied.to])
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  const cols = data.departments

  const Section = ({ title, sec }: { title: string; sec: DepartmentProfitAndLoss['sales'] }) => (
    <>
      <tr style={{ background: COLORS.bgSubtle, fontWeight: 600 }}>
        <td className="sticky" style={{ background: COLORS.bgSubtle }}>{title}</td>
        {sec.totalByDept.map((v, i) => <td key={i} className="num">{deptCell(v)}</td>)}
        <td className="num">{yen(sec.total)}</td>
      </tr>
      {sec.rows.map((r) => (
        <tr key={r.accountId}>
          <td className="sticky" style={{ paddingLeft: 28 }}><AccountLink id={r.accountId} name={r.accountName} /></td>
          {r.byDept.map((v, i) => <td key={i} className="num">{deptCell(v)}</td>)}
          <td className="num">{yen(r.total)}</td>
        </tr>
      ))}
    </>
  )

  return (
    <>
      <DeptNoData cols={cols} />
      {cols.length > 0 && (
        <div style={{ overflowX: 'auto' }}>
          <table className="tbl">
            <thead>
              <tr>
                <th className="sticky">科目</th>
                {cols.map((c) => <th key={c.departmentId ?? 'none'} className="num">{c.departmentName}</th>)}
                <th className="num">合計</th>
              </tr>
            </thead>
            <tbody>
              <Section title="売上（収入）金額" sec={data.sales} />
              {data.costOfSales.rows.length > 0 && <Section title="売上原価" sec={data.costOfSales} />}
              <tr style={{ fontWeight: 600 }}>
                <td className="sticky">売上総利益</td>
                {data.grossProfitByDept.map((v, i) => <td key={i} className="num">{yen(v)}</td>)}
                <td className="num">{yen(data.grossProfit)}</td>
              </tr>
              <Section title="経費" sec={data.expenses} />
              <tr style={{ fontWeight: 700, borderTop: `2px solid ${COLORS.border}` }}>
                <td className="sticky" style={{ color: COLORS.ok }}>当期所得（控除前所得金額）</td>
                {data.netIncomeByDept.map((v, i) => <td key={i} className="num" style={{ color: COLORS.ok }}>{yen(v)}</td>)}
                <td className="num" style={{ color: COLORS.ok }}>{yen(data.netIncome)}</td>
              </tr>
            </tbody>
          </table>
        </div>
      )}
    </>
  )
}

function DeptTrialView({ applied }: { applied: { from?: string; to?: string } }) {
  const { data, err, loading } = useReport<DepartmentTrialBalance>(() => api.departmentTrialBalance(applied), [applied.from, applied.to])
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  const cols = data.departments

  return (
    <>
      <DeptNoData cols={cols} />
      {cols.length > 0 && (
        <>
          {!data.balanced && <p style={{ color: COLORS.error }}>⚠ 貸借不一致</p>}
          <div style={{ overflowX: 'auto' }}>
            <table className="tbl">
              <thead>
                <tr>
                  <th className="sticky">区分 / 勘定科目</th>
                  {cols.map((c) => <th key={c.departmentId ?? 'none'} className="num">{c.departmentName}</th>)}
                  <th className="num">合計</th>
                </tr>
              </thead>
              <tbody>
                {data.rows.map((r) => (
                  <tr key={r.accountId}>
                    <td className="sticky">
                      <span style={{ color: COLORS.muted, marginRight: 6, fontSize: 11 }}>{r.section}</span>
                      <AccountLink id={r.accountId} name={r.accountName} />
                    </td>
                    {r.byDept.map((v, i) => <td key={i} className="num">{deptCell(v)}</td>)}
                    <td className="num" style={{ fontWeight: 600 }}>{yen(r.total)}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr style={{ fontWeight: 600 }}>
                  <td className="sticky">借方合計</td>
                  {data.totalsByDept.map((t, i) => <td key={i} className="num">{deptCell(t.totalDebit)}</td>)}
                  <td className="num">{yen(data.totalDebit)}</td>
                </tr>
                <tr style={{ fontWeight: 600 }}>
                  <td className="sticky">貸方合計</td>
                  {data.totalsByDept.map((t, i) => <td key={i} className="num">{deptCell(t.totalCredit)}</td>)}
                  <td className="num">{yen(data.totalCredit)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        </>
      )}
    </>
  )
}
