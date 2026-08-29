import { COLORS, SECTION } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { methodLabel } from '../lib/labels.js'
import { useReport } from '../lib/hooks.js'
import { api, type DepreciationBreakdown, type ExpenseBreakdown, type MonthlySalesPurchase } from '../api.js'

/** 青色決算書 内訳ページ（form-mapping §1.3〜§1.7）。各合計は損益の対応行に連動。 */

const NOTE: React.CSSProperties = { color: COLORS.muted, fontSize: 13, margin: '0 0 12px' }
const FOOT: React.CSSProperties = { fontWeight: 600, borderTop: `2px solid ${COLORS.border}` }

function PanelFrame({ title, note, children }: { title: string; note?: string; children: React.ReactNode }) {
  return (
    <section style={SECTION}>
      <h2>{title}</h2>
      {note && <p style={NOTE}>{note}</p>}
      {children}
    </section>
  )
}

/** 減価償却費の計算（§1.3・決算書3ページ目様式）。必要経費算入額合計＝損益⑱。 */
export function DepreciationBreakdownPanel() {
  const { data, err, loading } = useReport<DepreciationBreakdown>(() => api.depreciationBreakdown(), [])
  return (
    <PanelFrame title="減価償却費の計算（決算書3ページ目）" note="必要経費算入額の合計は損益計算書の減価償却費⑱に一致します。">
      {err && <p style={{ color: COLORS.error }}>{err}</p>}
      {loading ? (
        <p>…</p>
      ) : !data || data.rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>当年度に計上された減価償却がありません（固定資産タブで「当年度の償却仕訳を起票」してください）。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>名称</th>
              <th>取得年月</th>
              <th className="num">取得価額</th>
              <th>方法</th>
              <th className="num">耐用年数</th>
              <th className="num">償却率</th>
              <th className="num">本年償却費</th>
              <th className="num">事業%</th>
              <th className="num">必要経費算入額</th>
              <th className="num">未償却残高</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.fixedAssetId}>
                <td>{r.name}</td>
                <td style={{ color: COLORS.sub }}>{r.acquiredDate ?? ''}</td>
                <td className="num">{yen(r.acquisitionCost)}</td>
                <td>{methodLabel(r.depreciationMethod)}</td>
                <td className="num">{r.usefulLife ?? '—'}</td>
                <td className="num">{r.depreciationRate ?? '—'}</td>
                <td className="num">{yen(r.depreciationAmount)}</td>
                <td className="num">{r.businessUseRatio}%</td>
                <td className="num">{yen(r.businessAmount)}</td>
                <td className="num">{yen(r.closingBookValue)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ fontWeight: 600 }} colSpan={6}>合計（必要経費算入額は損益⑱に一致）</td>
              <td className="num" style={FOOT}>{yen(data.depreciationTotal)}</td>
              <td></td>
              <td className="num" style={FOOT}>{yen(data.businessAmountTotal)}</td>
              <td></td>
            </tr>
          </tbody>
        </table>
      )}
    </PanelFrame>
  )
}

/** 給料賃金/地代家賃/専従者給与の内訳（§1.4〜§1.6・補助科目/取引先別）。 */
export function ExpenseBreakdownPanel({
  title,
  note,
  nameHeader,
  load,
}: {
  title: string
  note?: string
  nameHeader: string
  load: () => Promise<ExpenseBreakdown | null>
}) {
  const { data, err, loading } = useReport<ExpenseBreakdown>(load, [])
  return (
    <PanelFrame title={title} note={note}>
      {err && <p style={{ color: COLORS.error }}>{err}</p>}
      {loading ? (
        <p>…</p>
      ) : !data || data.rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>該当する仕訳がありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>{nameHeader}</th>
              <th className="num">金額</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.key ?? 'none'}>
                <td>{r.name}</td>
                <td className="num">{yen(r.amount)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ fontWeight: 600 }}>合計</td>
              <td className="num" style={FOOT}>{yen(data.total)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </PanelFrame>
  )
}

/** 月別の売上(収入)金額及び仕入金額（§1.7）。年計＝①売上／③仕入。 */
export function MonthlySalesPurchasePanel() {
  const { data, err, loading } = useReport<MonthlySalesPurchase>(() => api.monthlySalesPurchase(), [])
  return (
    <PanelFrame title="月別の売上（収入）金額及び仕入金額（決算書2ページ目）" note="年計は損益の売上①・仕入③に一致します。">
      {err && <p style={{ color: COLORS.error }}>{err}</p>}
      {loading ? (
        <p>…</p>
      ) : !data ? (
        <p style={{ color: COLORS.muted }}>会計年度がありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%' }}>
          <thead>
            <tr>
              <th>月</th>
              <th className="num">売上（収入）金額</th>
              <th className="num">仕入金額</th>
            </tr>
          </thead>
          <tbody>
            {data.rows.map((r) => (
              <tr key={r.month}>
                <td>{r.month}月</td>
                <td className="num">{yen(r.sales)}</td>
                <td className="num">{yen(r.purchases)}</td>
              </tr>
            ))}
            <tr>
              <td style={{ fontWeight: 600 }}>年計</td>
              <td className="num" style={FOOT}>{yen(data.salesTotal)}</td>
              <td className="num" style={FOOT}>{yen(data.purchasesTotal)}</td>
            </tr>
          </tbody>
        </table>
      )}
    </PanelFrame>
  )
}
