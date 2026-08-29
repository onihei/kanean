/**
 * 確定申告書 第一表・第二表（所得税）の官製様式 HTML 再現。
 * 数値源は IncomeTaxReturn（公式様式PDF = kakuteiOverlay と同じ）。欄番号は templates/kakuteiOverlay に準拠。
 */
import type { IncomeTaxReturn } from '../../api.js'
import { Sheet, PrintToolbar, money, useFormHeader } from './sheet.js'

/** 欄番号付きの金額行。 */
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

/** 欄番号 + ラベル + 金額の3列 colgroup（左=欄番号・右=金額固定）。 */
function Cols3() {
  return (
    <colgroup>
      <col style={{ width: '34px' }} />
      <col />
      <col style={{ width: '160px' }} />
    </colgroup>
  )
}

export function IncomeTaxForm({ data }: { data: IncomeTaxReturn }) {
  const header = useFormHeader()
  const i = data.inputs

  return (
    <div className="gov-wrap">
      <PrintToolbar />

      {/* ===== 第一表 ===== */}
      <Sheet title="確定申告書（第一表）" subtitle="令和5年分以降用（所得税及び復興特別所得税）" header={header}>
        <div className="gov-section">収入金額等</div>
        <table className="gov-table">
          <Cols3 />
          <tbody>
            <Line no="㋐" label="事業（営業等）" value={data.businessRevenue} />
          </tbody>
        </table>

        <div className="gov-section">所得金額等</div>
        <table className="gov-table">
          <Cols3 />
          <tbody>
            <Line no="①" label="事業（営業等）" value={data.businessIncome} />
            <Line no="⑫" label="合計" value={data.totalIncome} strong />
          </tbody>
        </table>

        <div className="gov-section">所得から差し引かれる金額</div>
        <table className="gov-table">
          <Cols3 />
          <tbody>
            <Line no="⑬" label="社会保険料控除" value={i.socialInsurance} />
            <Line no="⑮" label="生命保険料控除" value={i.lifeInsurance} />
            <Line no="㉗" label="医療費控除" value={i.medical} />
            <Line no="㉓" label="配偶者・扶養控除" value={i.spouseDependents} />
            <Line no="㉔" label="基礎控除" value={i.basicDeduction} />
            <Line label="その他の所得控除" value={i.otherDeductions} />
            <Line no="㉙" label="合計" value={data.totalDeductions} strong />
          </tbody>
        </table>

        <div className="gov-section">税金の計算</div>
        <table className="gov-table">
          <Cols3 />
          <tbody>
            <Line no="㉚" label="課税される所得金額" hint="千円未満切捨" value={data.taxableIncome} />
            <Line no="㉛" label="上の㉚に対する税額" value={data.baseTax} />
            <Line no="44" label="復興特別所得税額" hint="×2.1%" value={data.surtax} />
            <Line no="45" label="所得税及び復興特別所得税の額" value={data.taxWithSurtax} />
            <Line no="48" label="源泉徴収税額" value={data.withholding} />
            <Line label="予定納税額（第1期・第2期分）" value={data.estimatedPrepaid} />
            <Line no="49" label="申告納税額" value={data.payable} />
            <Line no="51" label="第3期分の税額（納める税金）" hint="百円未満切捨" value={data.payable} strong />
            <Line no="52" label="還付される税金" value={data.refund} />
          </tbody>
        </table>
      </Sheet>

      {/* ===== 第二表 ===== */}
      <Sheet title="確定申告書（第二表）" subtitle="所得の内訳・所得から差し引かれる金額に関する事項" header={header}>
        <div className="gov-section">所得の内訳（所得税及び復興特別所得税の源泉徴収税額）</div>
        <table className="gov-table">
          <colgroup>
            <col style={{ width: '120px' }} />
            <col />
            <col style={{ width: '140px' }} />
            <col style={{ width: '140px' }} />
          </colgroup>
          <thead>
            <tr>
              <th>所得の種類</th>
              <th>支払者の氏名・名称</th>
              <th>収入金額</th>
              <th>源泉徴収税額</th>
            </tr>
          </thead>
          <tbody>
            {data.incomeDetail.length === 0 ? (
              <tr>
                <td className="gov-empty" colSpan={4}>
                  源泉徴収された所得はありません
                </td>
              </tr>
            ) : (
              data.incomeDetail.map((d, idx) => (
                <tr key={d.counterpartyId ?? `row-${idx}`}>
                  <td>事業（営業等）</td>
                  <td className="gov-label">{d.payerName}</td>
                  <td className="gov-amount">{money(d.revenue)}</td>
                  <td className="gov-amount">{money(d.withholding)}</td>
                </tr>
              ))
            )}
            <tr className="gov-total">
              <td colSpan={3} style={{ textAlign: 'right' }}>
                源泉徴収税額の合計額
              </td>
              <td className="gov-amount">{money(data.withholding)}</td>
            </tr>
          </tbody>
        </table>

        <div className="gov-section">所得から差し引かれる金額に関する事項</div>
        <table className="gov-table">
          <Cols3 />
          <tbody>
            <Line no="⑬" label="社会保険料控除" value={i.socialInsurance} />
            <Line no="⑮" label="生命保険料控除" value={i.lifeInsurance} />
            <Line no="㉗" label="医療費控除" value={i.medical} />
            <Line no="㉓" label="配偶者・扶養控除" value={i.spouseDependents} />
            <Line no="㉔" label="基礎控除" value={i.basicDeduction} />
            <Line label="その他の所得控除" value={i.otherDeductions} />
          </tbody>
        </table>
      </Sheet>
    </div>
  )
}
