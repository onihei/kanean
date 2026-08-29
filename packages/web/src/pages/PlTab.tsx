import { useState } from 'react'
import { COLORS, WARN_BANNER } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { useReport } from '../lib/hooks.js'
import { AccountLink, NoYear, CsvButton, SegTabs } from '../components/common.js'
import { useCompare, CompareCells, COMPARE_TH, NoPriorNote } from '../components/compare.js'
import { api } from '../api.js'
import type {
  ProfitAndLoss,
  TaxExcludedProfitAndLoss,
  ComparativeProfitAndLoss,
} from '../api.js'

export function PlTab() {
  const [mode, setMode] = useState<'included' | 'excluded' | 'compare'>('included')
  return (
    <>
      <h2>
        損益計算書{mode === 'excluded' && '（税抜）'}{mode === 'compare' && '（前期比較）'}
        {mode === 'included' && <CsvButton path="/api/reports/pl.csv" filename="損益計算書.csv" />}
        {mode === 'excluded' && <CsvButton path="/api/reports/tax-excluded-pl.csv" filename="税抜損益計算書.csv" />}
      </h2>
      <SegTabs
        value={mode}
        onChange={setMode}
        options={[
          { value: 'included', label: '税込経理' },
          { value: 'excluded', label: '税抜表示' },
          { value: 'compare', label: '前期比較' },
        ]}
      />
      {mode === 'included' ? (
        <PlIncludedView />
      ) : mode === 'excluded' ? (
        <PlExcludedView />
      ) : (
        <PlCompareView />
      )}
    </>
  )
}

function PlCompareView() {
  const { data, err, loading, picker, csvQs } = useCompare<ComparativeProfitAndLoss>(api.comparePl)

  const Section = ({ title, sec }: { title: string; sec: ComparativeProfitAndLoss['sales'] }) => (
    <>
      <tr style={{ background: COLORS.bgSubtle, fontWeight: 600 }}>
        <td>{title}</td>
        <CompareCells c={sec.total} />
      </tr>
      {sec.rows.map((r) => (
        <tr key={r.accountId}>
          <td style={{ paddingLeft: 28 }}><AccountLink id={r.accountId} name={r.accountName} /></td>
          <CompareCells c={r} />
        </tr>
      ))}
    </>
  )

  return (
    <>
      <section style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {picker}
        <CsvButton path={`/api/reports/comparison/pl.csv${csvQs()}`} filename="損益計算書_前期比較.csv" />
      </section>
      {loading ? (
        <p>…</p>
      ) : err ? (
        <p style={{ color: COLORS.error }}>{err}</p>
      ) : !data ? (
        <NoYear />
      ) : (
        <>
          {!data.hasPrior && <NoPriorNote />}
          <table className="tbl" style={{ width: '100%', maxWidth: 760 }}>
            <thead>
              <tr>
                <th>区分 / 科目</th>
                {COMPARE_TH}
              </tr>
            </thead>
            <tbody>
              <Section title="売上（収入）金額" sec={data.sales} />
              {data.costOfSales.rows.length > 0 && <Section title="売上原価" sec={data.costOfSales} />}
              <tr style={{ fontWeight: 600 }}>
                <td>売上総利益</td>
                <CompareCells c={data.grossProfit} />
              </tr>
              <Section title="経費" sec={data.expenses} />
              {data.otherIncome.rows.length > 0 && <Section title="その他（繰戻額等）" sec={data.otherIncome} />}
              <tr style={{ fontWeight: 700, borderTop: `2px solid ${COLORS.border}` }}>
                <td style={{ color: COLORS.ok }}>当期所得（控除前所得金額）</td>
                <CompareCells c={data.netIncome} />
              </tr>
            </tbody>
          </table>
        </>
      )}
    </>
  )
}

function PlIncludedView() {
  const { data, err, loading } = useReport<ProfitAndLoss>(api.pl)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />

  const Section = ({ title, total, rows }: { title: string; total: number; rows: ProfitAndLoss['sales']['rows'] }) => (
    <>
      <tr style={{ background: COLORS.bgSubtle, fontWeight: 600 }}>
        <td>{title}</td>
        <td className="num">{yen(total)}</td>
      </tr>
      {rows.map((r) => (
        <tr key={r.accountId}>
          <td style={{ paddingLeft: 28 }}><AccountLink id={r.accountId} name={r.accountName} /></td>
          <td className="num">{yen(r.balance)}</td>
        </tr>
      ))}
    </>
  )

  return (
    <table className="tbl" style={{ width: '100%', maxWidth: 560 }}>
      <tbody>
        <Section title="売上（収入）金額" total={data.sales.total} rows={data.sales.rows} />
        {data.costOfSales.rows.length > 0 && <Section title="売上原価" total={data.costOfSales.total} rows={data.costOfSales.rows} />}
        <tr style={{ fontWeight: 600 }}>
          <td>売上総利益</td>
          <td className="num">{yen(data.grossProfit)}</td>
        </tr>
        <Section title="経費" total={data.expenses.total} rows={data.expenses.rows} />
        {data.otherIncome.rows.length > 0 && (
          <Section title="その他（繰戻額等）" total={data.otherIncome.total} rows={data.otherIncome.rows} />
        )}
        <tr style={{ fontWeight: 700, borderTop: `2px solid ${COLORS.border}` }}>
          <td style={{ color: COLORS.ok }}>当期所得（控除前所得金額）</td>
          <td className="num" style={{ color: COLORS.ok }}>{yen(data.netIncome)}</td>
        </tr>
      </tbody>
    </table>
  )
}

function PlExcludedView() {
  const { data, err, loading } = useReport<TaxExcludedProfitAndLoss>(api.taxExcludedPl)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  const cell = (n: number) => (n ? yen(n) : '')

  const Section = ({ title, sec }: { title: string; sec: TaxExcludedProfitAndLoss['sales'] }) => (
    <>
      <tr style={{ background: COLORS.bgSubtle, fontWeight: 600 }}>
        <td>{title}</td>
        <td className="num">{yen(sec.gross)}</td>
        <td className="num">{yen(sec.tax)}</td>
        <td className="num">{yen(sec.net)}</td>
      </tr>
      {sec.rows.map((r) => (
        <tr key={r.accountId}>
          <td style={{ paddingLeft: 28 }}><AccountLink id={r.accountId} name={r.accountName} /></td>
          <td className="num">{yen(r.gross)}</td>
          <td className="num" style={{ color: COLORS.muted }}>{cell(r.tax)}</td>
          <td className="num">{yen(r.net)}</td>
        </tr>
      ))}
    </>
  )

  return (
    <>
      <p style={WARN_BANNER}>
        {data.accountingMethod === 'tax_included' ? (
          <>⚠ 税込経理（既定）の記帳から行単位の内税を控除した<strong>本体（税抜）表示</strong>です。消費税申告の入力源であり、納付税額の算定・申告書作成は税理士の確認を経て行います。</>
        ) : (
          <>⚠ 本表は<strong>税込経理を前提</strong>に内税を控除した本体（税抜）表示です。現在の経理方式は「{data.accountingMethod}」のため、税抜経理では別途の集計が必要です。納付税額の算定・申告書作成は税理士の確認を経て行います。</>
        )}
      </p>
      <table className="tbl" style={{ width: '100%', maxWidth: 680 }}>
        <thead>
          <tr>
            <th>区分 / 科目</th>
            <th className="num">税込</th>
            <th className="num">内税</th>
            <th className="num">税抜</th>
          </tr>
        </thead>
        <tbody>
          <Section title="売上（収入）金額" sec={data.sales} />
          {data.costOfSales.rows.length > 0 && <Section title="売上原価" sec={data.costOfSales} />}
          <tr style={{ fontWeight: 600 }}>
            <td>売上総利益</td>
            <td className="num">{yen(data.grossProfitGross)}</td>
            <td className="num"></td>
            <td className="num">{yen(data.grossProfitNet)}</td>
          </tr>
          <Section title="経費" sec={data.expenses} />
          <tr style={{ fontWeight: 700, borderTop: `2px solid ${COLORS.border}` }}>
            <td style={{ color: COLORS.ok }}>当期所得（控除前所得金額）</td>
            <td className="num">{yen(data.netIncomeGross)}</td>
            <td className="num"></td>
            <td className="num" style={{ color: COLORS.ok }}>{yen(data.netIncomeNet)}</td>
          </tr>
        </tbody>
      </table>
    </>
  )
}
