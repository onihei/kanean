import { useState } from 'react'
import { COLORS, WARN_BANNER } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { ADJ_LABEL, KIND_LABEL } from '../lib/labels.js'
import { useReport } from '../lib/hooks.js'
import { NoYear, CsvButton, TaxAdvisorBanner, SegTabs, PdfButton } from '../components/common.js'
import { ConsumptionTaxForm } from './forms/ConsumptionTaxForm.js'
import { FormPreviewSwitch } from './forms/PdfFormPreview.js'
import { api } from '../api.js'
import type { TaxSalesSummary, ConsumptionTaxReturn } from '../api.js'

export function TaxSalesTab() {
  const [view, setView] = useState<'summary' | 'return' | 'preview'>('summary')
  return (
    <>
      <SegTabs
        value={view}
        onChange={setView}
        options={[
          { value: 'summary', label: '課税売上集計' },
          { value: 'return', label: '申告書（簡易課税）' },
          { value: 'preview', label: '様式プレビュー' },
        ]}
      />
      {view === 'summary' ? <TaxSalesView /> : view === 'return' ? <ConsumptionTaxReturnView /> : <ConsumptionTaxPreview />}
    </>
  )
}

/** 消費税申告書（簡易課税 第一表）の官製様式 HTML プレビュー。 */
function ConsumptionTaxPreview() {
  const { data, err, loading } = useReport<ConsumptionTaxReturn>(api.consumptionTaxReturn)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  return (
    <FormPreviewSwitch
      pdfPath="/api/tax-return/consumption-official.pdf"
      pdfFilename="消費税申告書_公式様式.pdf"
      htmlNote="官製様式（簡易課税用 第一表）の HTML 再現です。金額は「公式様式PDF」と同一集計。参考帳票につき税理士確認のうえ提出してください。"
    >
      <ConsumptionTaxForm data={data} />
    </FormPreviewSwitch>
  )
}

function TaxSalesView() {
  const { data, err, loading } = useReport<TaxSalesSummary>(api.taxSales)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />

  return (
    <>
      <h2>税区分別 課税売上集計<CsvButton path="/api/reports/tax-sales.csv" filename="消費税集計.csv" /></h2>
      <p style={WARN_BANNER}>
        ⚠ 本表は確定申告（消費税）の<strong>入力源となる集計</strong>です。納付税額の算定・申告書の作成は税理士の確認を経て行います（本システムは単独で「提出可能」と判断しません）。
      </p>
      {data.rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>課税売上の確定済み仕訳がありません。</p>
      ) : (
        <>
          <table className="tbl" style={{ width: '100%', maxWidth: 760 }}>
            <thead>
              <tr>
                <th>税区分</th>
                <th className="num">税率</th>
                <th>区分</th>
                <th className="num">件数</th>
                <th className="num">税込</th>
                <th className="num">税抜</th>
                <th className="num">消費税額</th>
              </tr>
            </thead>
            <tbody>
              {data.rows.map((r) => (
                <tr key={r.taxCategoryId}>
                  <td>{r.label}</td>
                  <td className="num">{r.rate != null ? `${r.rate}%` : ''}</td>
                  <td style={{ color: COLORS.muted }}>{ADJ_LABEL[r.adjustment] ?? r.adjustment}</td>
                  <td className="num">{r.count}</td>
                  <td className="num">{yen(r.grossAmount)}</td>
                  <td className="num">{yen(r.netAmount)}</td>
                  <td className="num">{yen(r.taxAmount)}</td>
                </tr>
              ))}
            </tbody>
            <tfoot>
              <tr style={{ fontWeight: 600 }}>
                <td colSpan={4}>合計</td>
                <td className="num">{yen(data.totalGross)}</td>
                <td className="num">{yen(data.totalNet)}</td>
                <td className="num">{yen(data.totalTax)}</td>
              </tr>
            </tfoot>
          </table>

          <h3 style={{ color: COLORS.sub, marginTop: '1.25rem' }}>税率別 課税標準額（税抜・通常売上）</h3>
          <table className="tbl" style={{ maxWidth: 360 }}>
            <thead>
              <tr>
                <th className="num">税率</th>
                <th className="num">税抜課税標準額</th>
                <th className="num">消費税額</th>
              </tr>
            </thead>
            <tbody>
              {data.baseByRate.map((b) => (
                <tr key={b.rate}>
                  <td className="num">{b.rate}%</td>
                  <td className="num">{yen(b.net)}</td>
                  <td className="num">{yen(b.tax)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </>
      )}
    </>
  )
}

function ConsumptionTaxReturnView() {
  const { data, err, loading } = useReport<ConsumptionTaxReturn>(api.consumptionTaxReturn)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />

  const Line = ({ label, amount, strong, hint }: { label: string; amount: number; strong?: boolean; hint?: string }) => (
    <tr style={strong ? { fontWeight: 600, color: COLORS.ok, borderTop: `2px solid ${COLORS.border}` } : undefined}>
      <td>{label}{hint ? <span style={{ color: COLORS.muted, fontSize: 13 }}>（{hint}）</span> : ''}</td>
      <td className="num">{yen(amount)}</td>
    </tr>
  )

  return (
    <>
      <h2>
        消費税及び地方消費税申告書（簡易課税）
        <PdfButton path="/api/tax-return/consumption.pdf" filename="消費税申告書_簡易課税.pdf" />
        <PdfButton path="/api/tax-return/consumption-official.pdf" filename="消費税申告書_公式様式.pdf" label="公式様式PDF" />
      </h2>
      <TaxAdvisorBanner note={`事業区分 ${KIND_LABEL[data.businessCategory] ?? data.businessCategory}・みなし仕入率 ${Math.round(data.deemedRate * 100)}%。課税標準額は税抜額の千円未満切捨て（公式手順との端数差は要確認）。中間納付は未追跡。「公式様式PDF」は国税庁様式（簡易課税用 第一表）に座標差込。参考帳票につき税理士確認のうえ提出してください。`} />
      {data.note && <p style={{ color: COLORS.warn }}>{data.note}</p>}

      <h3 style={{ color: COLORS.sub }}>付表4-3 / 5-3（税率別）</h3>
      {data.baseRows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>課税売上の確定済み仕訳がありません。</p>
      ) : (
        <table className="tbl" style={{ maxWidth: 480, marginBottom: 16 }}>
          <thead>
            <tr>
              <th className="num">税率</th>
              <th className="num">課税標準額（税抜・千円切捨）</th>
              <th className="num">売上消費税額（国税）</th>
            </tr>
          </thead>
          <tbody>
            {data.baseRows.map((b) => (
              <tr key={b.rate}>
                <td className="num">{b.rate}%</td>
                <td className="num">{yen(b.taxBase)}</td>
                <td className="num">{yen(b.salesTaxNational)}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ color: COLORS.sub }}>申告書 第一表</h3>
      <table className="tbl" style={{ maxWidth: 480 }}>
        <tbody>
          <Line label="課税標準額" amount={data.taxBaseTotal} />
          <Line label="売上に係る消費税額" amount={data.salesTaxNational} hint="国税" />
          <Line label="控除対象仕入税額" amount={data.deemedDeduction} hint={`みなし${Math.round(data.deemedRate * 100)}%`} />
          {data.returnNational > 0 && <Line label="返還等対価に係る税額" amount={data.returnNational} hint="国税" />}
          {data.badDebtNational > 0 && <Line label="貸倒れに係る税額" amount={data.badDebtNational} hint="国税" />}
          <Line label="差引税額（国税）" amount={data.national} hint="百円切捨" />
          <Line label="地方消費税額" amount={data.local} hint="百円切捨" />
          {data.midPaid > 0 && <Line label="中間納付税額" amount={data.midPaid} />}
          <Line label="納付税額" amount={data.payable} strong />
        </tbody>
      </table>
    </>
  )
}
