/**
 * 青色申告決算書（一般用・4ページ）の官製様式 HTML 再現。
 *   P1 損益計算書 / P2 月別売上仕入・各種内訳・控除額計算・貸倒引当金 / P3 減価償却費の計算 / P4 貸借対照表
 * 数値源は BlueStatementReport（公式様式PDF = aoiroOverlay と同じ集計）。
 */
import { COLORS } from '../../lib/styles.js'
import type { BlueStatementReport, FormBox, BsFormRow, ExpenseBreakdown } from '../../api.js'
import { Sheet, PrintToolbar, money, moneyOrBlank, useFormHeader } from './sheet.js'

const METHOD_LABEL: Record<string, string> = {
  straight_line: '定額法',
  declining_balance: '定率法',
  lump_sum: '一括償却',
  minor_special: '少額特例',
  old_straight_line: '旧定額法',
  old_declining_balance: '旧定率法',
}

// 貸借対照表の固定行ラベル（様式に事前印字＝サーバは label を省略するため、ここで補う）。
const ASSET_LABEL: Record<number, string> = {
  1: '現金', 2: '当座預金', 3: '定期預金', 4: 'その他の預金', 5: '受取手形', 6: '売掛金', 7: '有価証券',
  8: '棚卸資産', 9: '前払金', 10: '貸付金', 11: '建物', 12: '建物附属設備', 13: '機械装置',
  14: '車両運搬具', 15: '工具器具備品', 16: '土地', 24: '事業主貸',
}
const LIAB_LABEL: Record<number, string> = {
  1: '支払手形', 2: '買掛金', 3: '借入金', 4: '未払金', 5: '前受金', 6: '預り金', 14: '貸倒引当金',
  22: '事業主借', 23: '元入金', 24: '青色申告特別控除前の所得金額',
}

/** 損益の様式ボックス行（強調行は0も表示・それ以外は0空欄）。 */
function PlLine({ b, strong }: { b: FormBox; strong?: boolean }) {
  return (
    <tr className={strong ? 'gov-emph' : undefined}>
      <td className="gov-no">{b.box ?? ''}</td>
      <td className="gov-label">{b.label}</td>
      <td className="gov-amount">{strong ? money(b.amount) : moneyOrBlank(b.amount)}</td>
    </tr>
  )
}

function PlTable({ rows }: { rows: { b: FormBox; strong?: boolean }[] }) {
  return (
    <table className="gov-table">
      <colgroup>
        <col style={{ width: '34px' }} />
        <col />
        <col style={{ width: '170px' }} />
      </colgroup>
      <tbody>
        {rows.map((r) => (
          <PlLine key={r.b.code} b={r.b} strong={r.strong} />
        ))}
      </tbody>
    </table>
  )
}

/** 内訳テーブル（氏名/支払先 × 金額 ＋ 計）。 */
function Breakdown({ title, nameHeader, amountHeader = '金額', data }: { title: string; nameHeader: string; amountHeader?: string; data: ExpenseBreakdown }) {
  return (
    <>
      <div className="gov-section">{title}</div>
      <table className="gov-table">
        <colgroup>
          <col />
          <col style={{ width: '170px' }} />
        </colgroup>
        <thead>
          <tr>
            <th>{nameHeader}</th>
            <th>{amountHeader}</th>
          </tr>
        </thead>
        <tbody>
          {data.rows.length === 0 ? (
            <tr>
              <td className="gov-empty" colSpan={2}>
                該当なし
              </td>
            </tr>
          ) : (
            data.rows.map((r, idx) => (
              <tr key={r.key ?? `row-${idx}`}>
                <td className="gov-label">{r.name}</td>
                <td className="gov-amount">{money(r.amount)}</td>
              </tr>
            ))
          )}
          <tr className="gov-total">
            <td>計</td>
            <td className="gov-amount">{money(data.total)}</td>
          </tr>
        </tbody>
      </table>
    </>
  )
}

/** 貸借対照表の片側（資産 or 負債・資本）。 */
function BsSide({ title, rows, total, labelMap }: { title: string; rows: BsFormRow[]; total: { opening: number; closing: number }; labelMap: Record<number, string> }) {
  return (
    <div>
      <table className="gov-table">
        <colgroup>
          <col />
          <col style={{ width: '90px' }} />
          <col style={{ width: '90px' }} />
        </colgroup>
        <thead>
          <tr>
            <th>{title}</th>
            <th>期首</th>
            <th>期末</th>
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td className="gov-empty" colSpan={3}>
                残高なし
              </td>
            </tr>
          ) : (
            rows.map((r) => (
              <tr key={r.row}>
                <td className="gov-label">{r.label ?? labelMap[r.row] ?? `行${r.row}`}</td>
                <td className="gov-amount">{moneyOrBlank(r.opening)}</td>
                <td className="gov-amount">{moneyOrBlank(r.closing)}</td>
              </tr>
            ))
          )}
          <tr className="gov-total">
            <td>合計</td>
            <td className="gov-amount">{money(total.opening)}</td>
            <td className="gov-amount">{money(total.closing)}</td>
          </tr>
        </tbody>
      </table>
    </div>
  )
}

export function BlueStatementForm({ data }: { data: BlueStatementReport }) {
  const header = useFormHeader()
  const { pl, balanceSheet: bs, summary, monthly, salary, senju, rent, depreciation: dep, reserveAllowance: ra } = data

  const costRows = [
    { b: pl.sales }, { b: pl.openStock }, { b: pl.purchase }, { b: pl.subtotalCost }, { b: pl.closeStock },
    { b: pl.costOfSales }, { b: pl.grossProfit, strong: true },
  ]
  const expenseRows = [...pl.expenses.map((b) => ({ b })), { b: pl.expenseTotal, strong: true }]
  const incomeRows = [
    { b: pl.netBeforeAdjust, strong: true }, { b: pl.reserveBack }, { b: pl.reserveIn }, { b: pl.senju },
    { b: pl.incomeBeforeDeduction, strong: true }, { b: pl.blueDeduction }, { b: pl.income, strong: true },
  ]

  return (
    <div className="gov-wrap">
      <PrintToolbar />

      {/* ===== P1 損益計算書 ===== */}
      <Sheet title="青色申告決算書（損益計算書）" subtitle="一般用" header={header}>
        <div className="gov-section">売上（収入）金額・売上原価</div>
        <PlTable rows={costRows} />
        <div className="gov-section">経費</div>
        <PlTable rows={expenseRows} />
        <div className="gov-section">差引金額・各種引当金・所得金額</div>
        <PlTable rows={incomeRows} />
      </Sheet>

      {/* ===== P2 月別・内訳・控除額計算 ===== */}
      <Sheet title="青色申告決算書（2ページ）" subtitle="月別売上仕入・各種内訳・青色申告特別控除額の計算">
        <div className="gov-section">月別の売上（収入）金額及び仕入金額</div>
        <table className="gov-table">
          <colgroup>
            <col style={{ width: '60px' }} />
            <col />
            <col />
          </colgroup>
          <thead>
            <tr>
              <th>月</th>
              <th>売上（収入）金額</th>
              <th>仕入金額</th>
            </tr>
          </thead>
          <tbody>
            {monthly.rows.map((m) => (
              <tr key={m.month}>
                <td style={{ textAlign: 'center' }}>{m.month}月</td>
                <td className="gov-amount">{moneyOrBlank(m.sales)}</td>
                <td className="gov-amount">{moneyOrBlank(m.purchases)}</td>
              </tr>
            ))}
            <tr className="gov-total">
              <td style={{ textAlign: 'center' }}>計</td>
              <td className="gov-amount">{money(monthly.salesTotal)}</td>
              <td className="gov-amount">{money(monthly.purchasesTotal)}</td>
            </tr>
          </tbody>
        </table>

        <Breakdown title="給料賃金の内訳" nameHeader="氏名（補助科目）" data={salary} />
        <Breakdown title="専従者給与の内訳" nameHeader="氏名（専従者）" data={senju} />
        <Breakdown title="地代家賃の内訳" nameHeader="支払先" amountHeader="本年中の必要経費算入額" data={rent} />

        <div className="gov-section">青色申告特別控除額の計算</div>
        <table className="gov-table">
          <colgroup>
            <col style={{ width: '34px' }} />
            <col />
            <col style={{ width: '170px' }} />
          </colgroup>
          <tbody>
            <tr>
              <td className="gov-no">㊸</td>
              <td className="gov-label">青色申告特別控除前の所得金額</td>
              <td className="gov-amount">{money(summary.incomeBeforeDeduction)}</td>
            </tr>
            <tr className="gov-emph">
              <td className="gov-no">㊹</td>
              <td className="gov-label">
                青色申告特別控除額<span className="hint">{summary.basis}</span>
              </td>
              <td className="gov-amount">{money(summary.deduction)}</td>
            </tr>
          </tbody>
        </table>

        <div className="gov-section">貸倒引当金繰入額の計算（一括評価）</div>
        {ra.total > 0 ? (
          <table className="gov-table">
            <colgroup>
              <col style={{ width: '34px' }} />
              <col />
              <col style={{ width: '170px' }} />
            </colgroup>
            <tbody>
              <tr>
                <td className="gov-no">②</td>
                <td className="gov-label">年末における一括評価による貸金の合計額</td>
                <td className="gov-amount">{money(ra.grossReceivables)}</td>
              </tr>
              <tr>
                <td className="gov-no">③</td>
                <td className="gov-label">
                  本年分繰入限度額<span className="hint">②×{(ra.rate * 100).toFixed(1)}%</span>
                </td>
                <td className="gov-amount">{money(ra.limit)}</td>
              </tr>
              <tr>
                <td className="gov-no">④</td>
                <td className="gov-label">本年分繰入額（一括評価）</td>
                <td className="gov-amount">{money(ra.lumpReserve)}</td>
              </tr>
              <tr className="gov-emph">
                <td className="gov-no">⑤</td>
                <td className="gov-label">本年分貸倒引当金繰入額</td>
                <td className="gov-amount">{money(ra.total)}</td>
              </tr>
            </tbody>
          </table>
        ) : (
          <p className="gov-empty">貸倒引当金の繰入はありません。</p>
        )}
      </Sheet>

      {/* ===== P3 減価償却費の計算 ===== */}
      <Sheet title="青色申告決算書（3ページ）" subtitle="減価償却費の計算">
        <div className="gov-section">減価償却費の計算</div>
        <table className="gov-table dense">
          <thead>
            <tr>
              <th>減価償却資産の名称等</th>
              <th>面積又は数量</th>
              <th>取得年月</th>
              <th>取得価額</th>
              <th>償却の基礎になる金額</th>
              <th>償却方法</th>
              <th>耐用年数</th>
              <th>償却率</th>
              <th>本年分の普通償却費</th>
              <th>事業専用割合</th>
              <th>本年分の必要経費算入額</th>
              <th>未償却残高（期末）</th>
            </tr>
          </thead>
          <tbody>
            {dep.rows.length === 0 ? (
              <tr>
                <td className="gov-empty" colSpan={12}>
                  減価償却資産がありません
                </td>
              </tr>
            ) : (
              dep.rows.map((r) => (
                <tr key={r.fixedAssetId}>
                  <td className="gov-label">{r.name}</td>
                  <td style={{ textAlign: 'center' }}>{r.quantityOrArea || ''}</td>
                  <td style={{ textAlign: 'center' }}>{r.acquiredDate ? r.acquiredDate.slice(0, 7) : ''}</td>
                  <td className="gov-amount">{money(r.acquisitionCost)}</td>
                  <td className="gov-amount">{money(r.openingBookValue)}</td>
                  <td style={{ textAlign: 'center' }}>{METHOD_LABEL[r.depreciationMethod] ?? r.depreciationMethod}</td>
                  <td style={{ textAlign: 'center' }}>{r.usefulLife ?? ''}</td>
                  <td style={{ textAlign: 'center' }}>{r.depreciationRate ?? ''}</td>
                  <td className="gov-amount">{money(r.depreciationAmount)}</td>
                  <td style={{ textAlign: 'center' }}>{Math.round(r.businessUseRatio * 100)}%</td>
                  <td className="gov-amount">{money(r.businessAmount)}</td>
                  <td className="gov-amount">{money(r.closingBookValue)}</td>
                </tr>
              ))
            )}
            <tr className="gov-total">
              <td colSpan={8} style={{ textAlign: 'right' }}>
                計
              </td>
              <td className="gov-amount">{money(dep.depreciationTotal)}</td>
              <td />
              <td className="gov-amount">{money(dep.businessAmountTotal)}</td>
              <td />
            </tr>
          </tbody>
        </table>
        <p style={{ fontSize: 11, color: COLORS.muted, marginTop: 8 }}>
          ※ 必要経費算入額の計（{money(dep.businessAmountTotal)}）は損益計算書の減価償却費⑱に一致します。
        </p>
      </Sheet>

      {/* ===== P4 貸借対照表 ===== */}
      <Sheet title="青色申告決算書（4ページ）" subtitle="貸借対照表（資産負債調）">
        <div className="gov-section">貸借対照表{bs.balanced ? '' : '（⚠ 期末の貸借が一致していません）'}</div>
        <div className="gov-twocol">
          <BsSide title="資産の部" rows={bs.assets} total={bs.assetTotal} labelMap={ASSET_LABEL} />
          <BsSide title="負債・資本の部" rows={bs.liabilities} total={bs.liabTotal} labelMap={LIAB_LABEL} />
        </div>
      </Sheet>
    </div>
  )
}
