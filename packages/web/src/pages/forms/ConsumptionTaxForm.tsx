/**
 * 消費税及び地方消費税申告書（簡易課税用 第一表）の官製様式 HTML 再現。
 * 数値源は ConsumptionTaxReturn（公式様式PDF = shohiOverlay と同じ）。欄番号は templates/shohiOverlay に準拠。
 */
import { COLORS } from '../../lib/styles.js'
import type { ConsumptionTaxReturn } from '../../api.js'
import { KIND_LABEL } from '../../lib/labels.js'
import { Sheet, PrintToolbar, money, useFormHeader } from './sheet.js'

/** 欄番号付きの金額行（gov-table 内の <tr>）。 */
function Line({ no, label, value, hint, strong }: { no?: string; label: string; value: number; hint?: string; strong?: boolean }) {
  return (
    <tr className={strong ? 'gov-emph' : undefined}>
      <td className="gov-no">{no ?? ''}</td>
      <td className="gov-label">
        {label}
        {hint && <span className="hint">{hint}</span>}
      </td>
      <td className="gov-amount">{money(value)}</td>
    </tr>
  )
}

export function ConsumptionTaxForm({ data }: { data: ConsumptionTaxReturn }) {
  const header = useFormHeader()
  const kind = KIND_LABEL[data.businessCategory] ?? `第${data.businessCategory}種`
  const deductSubtotal = data.deemedDeduction + data.returnNational + data.badDebtNational

  return (
    <div className="gov-wrap">
      <PrintToolbar />
      <Sheet
        title="消費税及び地方消費税申告書"
        subtitle="（簡易課税用・第一表）"
        header={header}
        periodLabel="課税期間"
        extraMeta={[
          { k: '事業区分', v: kind },
          { k: 'みなし仕入率', v: `${Math.round(data.deemedRate * 100)}%` },
        ]}
      >
        {!data.applicable && (
          <div className="gov-meta" style={{ color: COLORS.warn, borderColor: COLORS.warnBorder }}>
            <span>⚠ 簡易課税の適用対象外です。{data.note ?? ''}</span>
          </div>
        )}

        <div className="gov-section">付表 税率別 課税標準額・売上に係る消費税額（国税）</div>
        <table className="gov-table">
          <colgroup>
            <col style={{ width: '90px' }} />
            <col />
            <col style={{ width: '170px' }} />
          </colgroup>
          <thead>
            <tr>
              <th>税率</th>
              <th>課税標準額（税抜・千円未満切捨）</th>
              <th>売上に係る消費税額（国税）</th>
            </tr>
          </thead>
          <tbody>
            {data.baseRows.length === 0 ? (
              <tr>
                <td className="gov-empty" colSpan={3}>
                  課税売上の確定済み仕訳がありません
                </td>
              </tr>
            ) : (
              data.baseRows.map((b) => (
                <tr key={b.rate}>
                  <td style={{ textAlign: 'center' }}>{b.rate}%</td>
                  <td className="gov-amount">{money(b.taxBase)}</td>
                  <td className="gov-amount">{money(b.salesTaxNational)}</td>
                </tr>
              ))
            )}
            <tr className="gov-total">
              <td style={{ textAlign: 'center' }}>合計</td>
              <td className="gov-amount">{money(data.taxBaseTotal)}</td>
              <td className="gov-amount">{money(data.salesTaxNational)}</td>
            </tr>
          </tbody>
        </table>

        <div className="gov-section">この申告書による消費税の税額の計算（国税）</div>
        <table className="gov-table">
          <colgroup>
            <col style={{ width: '34px' }} />
            <col />
            <col style={{ width: '170px' }} />
          </colgroup>
          <tbody>
            <Line no="①" label="課税標準額" hint="千円未満切捨" value={data.taxBaseTotal} />
            <Line no="②" label="消費税額（売上に係る消費税額）" value={data.salesTaxNational} />
            <Line no="④" label="控除対象仕入税額" hint={`みなし${Math.round(data.deemedRate * 100)}%`} value={data.deemedDeduction} />
            <Line no="⑤" label="返還等対価に係る税額" value={data.returnNational} />
            <Line no="⑥" label="貸倒れに係る税額" value={data.badDebtNational} />
            <Line no="⑦" label="控除税額小計（④＋⑤＋⑥）" value={deductSubtotal} />
            <Line no="⑨" label="差引税額（国税）" hint="百円未満切捨" value={data.national} />
            <Line no="⑪" label="納付税額（国税）" hint="中間納付控除前" value={data.national} strong />
          </tbody>
        </table>

        <div className="gov-section">この申告書による地方消費税の税額の計算</div>
        <table className="gov-table">
          <colgroup>
            <col style={{ width: '34px' }} />
            <col />
            <col style={{ width: '170px' }} />
          </colgroup>
          <tbody>
            <Line no="⑯" label="差引税額（地方消費税の課税標準＝国税の差引税額）" value={data.national} />
            <tr>
              <td className="gov-no" />
              <td className="gov-label">譲渡割額 納税額（地方）</td>
              <td className="gov-amount">{money(data.local)}</td>
            </tr>
            <tr>
              <td className="gov-no" />
              <td className="gov-label">納付譲渡割額（地方）</td>
              <td className="gov-amount">{money(data.local)}</td>
            </tr>
          </tbody>
        </table>

        <div className="gov-section">納付税額</div>
        <table className="gov-table">
          <colgroup>
            <col style={{ width: '34px' }} />
            <col />
            <col style={{ width: '170px' }} />
          </colgroup>
          <tbody>
            {data.midPaid > 0 && <Line label="中間納付税額" value={data.midPaid} />}
            <Line no="㉖" label="消費税及び地方消費税の合計（納付）税額" value={data.payable} strong />
          </tbody>
        </table>
        <p style={{ fontSize: 11, color: COLORS.muted, marginTop: 8 }}>
          ※ 中間納付税額は未追跡（0前提）。金額は確定済み仕訳からの参考値です。
        </p>
      </Sheet>
    </div>
  )
}
