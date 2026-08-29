import { useState, Fragment } from 'react'
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { useReport } from '../lib/hooks.js'
import { AccountLink, NoYear, TaxAdvisorBanner, CsvButton, SegTabs } from '../components/common.js'
import { CompareCells, COMPARE_TH, NoPriorNote, useCompare } from '../components/compare.js'
import { api } from '../api.js'
import type { BalanceSheet, ComparativeBalanceSheet, CompareCell } from '../api.js'

export function BsTab() {
  const [view, setView] = useState<'normal' | 'compare'>('normal')
  return (
    <>
      <h2>貸借対照表{view === 'normal' && <CsvButton path="/api/reports/bs.csv" filename="貸借対照表.csv" />}</h2>
      <SegTabs
        value={view}
        onChange={setView}
        options={[{ value: 'normal', label: '当期' }, { value: 'compare', label: '前期比較' }]}
      />
      {view === 'normal' ? <BsNormalView /> : <BsCompareView />}
    </>
  )
}

function BsNormalView() {
  const { data, err, loading } = useReport<BalanceSheet>(api.bs)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />

  const Side = ({ sections, extra }: { sections: BalanceSheet['assets']; extra?: { label: string; amount: number } }) => (
    <table className="tbl" style={{ width: '100%' }}>
      <tbody>
        {sections.map((sec) => (
          <Fragment key={sec.section}>
            <tr style={{ background: COLORS.bgSubtle, fontWeight: 600 }}>
              <td>{sec.section}</td>
              <td className="num">{yen(sec.total)}</td>
            </tr>
            {sec.rows.map((r) => (
              <tr key={r.accountId}>
                <td style={{ paddingLeft: 28 }}><AccountLink id={r.accountId} name={r.accountName} /></td>
                <td className="num">{yen(r.balance)}</td>
              </tr>
            ))}
          </Fragment>
        ))}
        {extra && (
          <tr style={{ fontWeight: 600, color: COLORS.ok }}>
            <td>{extra.label}</td>
            <td className="num">{yen(extra.amount)}</td>
          </tr>
        )}
      </tbody>
    </table>
  )

  return (
    <>
      <TaxAdvisorBanner note="期首は「決算整理」タブの開始残高で駆動。控除前所得金額は損益㊸の連結算出行です。" />
      {!data.balanced && <p style={{ color: COLORS.error }}>⚠ 借方計 ≠ 貸方計</p>}
      <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
        <div>
          <h3 style={{ color: COLORS.sub }}>資産の部 <span style={{ marginLeft: 8 }}>{yen(data.totalAssets)}</span></h3>
          <Side sections={data.assets} />
        </div>
        <div>
          <h3 style={{ color: COLORS.sub }}>負債・資本の部 <span style={{ marginLeft: 8 }}>{yen(data.totalLiabilities + data.totalEquity)}</span></h3>
          <Side sections={data.liabilities} />
          <Side sections={data.equity} extra={{ label: '当期所得（控除前所得金額）', amount: data.netIncome }} />
        </div>
      </div>
    </>
  )
}

function BsCompareView() {
  const { data, err, loading, picker, csvQs } = useCompare<ComparativeBalanceSheet>(api.compareBs)

  const SideTable = ({ sections, extra }: { sections: ComparativeBalanceSheet['assets']; extra?: { label: string; cell: CompareCell } }) => (
    <table className="tbl" style={{ width: '100%' }}>
      <thead>
        <tr>
          <th>区分 / 科目</th>
          {COMPARE_TH}
        </tr>
      </thead>
      <tbody>
        {sections.map((sec) => (
          <Fragment key={sec.section}>
            <tr style={{ background: COLORS.bgSubtle, fontWeight: 600 }}>
              <td>{sec.section}</td>
              <CompareCells c={sec.total} />
            </tr>
            {sec.rows.map((r) => (
              <tr key={r.accountId}>
                <td style={{ paddingLeft: 28 }}><AccountLink id={r.accountId} name={r.accountName} /></td>
                <CompareCells c={r} />
              </tr>
            ))}
          </Fragment>
        ))}
        {extra && (
          <tr style={{ fontWeight: 600, color: COLORS.ok }}>
            <td>{extra.label}</td>
            <CompareCells c={extra.cell} />
          </tr>
        )}
      </tbody>
    </table>
  )

  return (
    <>
      <section style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
        {picker}
        <CsvButton path={`/api/reports/comparison/bs.csv${csvQs()}`} filename="貸借対照表_前期比較.csv" />
      </section>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 0.5rem' }}>期末残高の当期/前期比較。</p>
      {loading ? (
        <p>…</p>
      ) : err ? (
        <p style={{ color: COLORS.error }}>{err}</p>
      ) : !data ? (
        <NoYear />
      ) : (
        <>
          {!data.hasPrior && <NoPriorNote />}
          <div style={{ display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 24 }}>
            <div>
              <h3 style={{ color: COLORS.sub }}>資産の部</h3>
              <SideTable sections={data.assets} />
            </div>
            <div>
              <h3 style={{ color: COLORS.sub }}>負債・資本の部</h3>
              <SideTable sections={data.liabilities} />
              <SideTable sections={data.equity} extra={{ label: '当期所得（控除前所得金額）', cell: data.netIncome }} />
            </div>
          </div>
        </>
      )}
    </>
  )
}
