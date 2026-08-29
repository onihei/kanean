import { useState, useEffect } from 'react'
import { COLORS, SECTION, WARN_BANNER } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { NoYear, TaxAdvisorBanner, PdfButton, SegTabs } from '../components/common.js'
import { ExpenseBreakdownPanel, MonthlySalesPurchasePanel } from '../components/breakdownPanels.js'
import { useReport } from '../lib/hooks.js'
import { BlueStatementForm } from './forms/BlueStatementForm.js'
import { FormPreviewSwitch } from './forms/PdfFormPreview.js'
import { api } from '../api.js'
import type { BlueReturnSummary, BlueStatementReport, CapitalTransferPreview, RolloverPrecheck, RolloverResult } from '../api.js'

export function ClosingTab() {
  const [view, setView] = useState<'closing' | 'preview'>('closing')
  return (
    <>
      <SegTabs
        value={view}
        onChange={setView}
        options={[{ value: 'closing', label: '決算整理' }, { value: 'preview', label: '青色決算書プレビュー' }]}
      />
      {view === 'preview' ? (
        <BlueStatementPreview />
      ) : (
        <>
          <TaxAdvisorBanner note="元入金振替は計算のみ（仕訳起票はしません）。翌期 opening_balances の元入金を決める参考値です。" />
          <CapitalTransferPanel onRolled={() => {}} />
          <BlueDeductionPanel />
          <ExpenseBreakdownPanel
            title="給料賃金の内訳（決算書2ページ目）"
            note="従業員（補助科目）別。合計は損益の給料賃金⑳に一致します。"
            nameHeader="従業員（補助科目）"
            load={api.salaryBreakdown}
          />
          <ExpenseBreakdownPanel
            title="地代家賃の内訳（決算書3ページ目）"
            note="支払先（取引先）別・家事按分後の計上額。合計は損益の地代家賃㉓に一致します。"
            nameHeader="支払先（取引先）"
            load={api.rentBreakdown}
          />
          <ExpenseBreakdownPanel
            title="専従者給与の内訳（決算書2ページ目）"
            note="専従者（補助科目）別。合計は損益の専従者給与に一致します。"
            nameHeader="専従者（補助科目）"
            load={api.senjuBreakdown}
          />
          <MonthlySalesPurchasePanel />
        </>
      )}
    </>
  )
}

/** 青色申告決算書（一般用・4ページ）の官製様式 HTML プレビュー。 */
function BlueStatementPreview() {
  const { data, err, loading } = useReport<BlueStatementReport>(api.blueStatement)
  if (loading) return <p>…</p>
  if (err) return <p style={{ color: COLORS.error }}>{err}</p>
  if (!data) return <NoYear />
  return (
    <FormPreviewSwitch
      pdfPath="/api/tax-return/blue-statement-official.pdf"
      pdfFilename="青色申告決算書_公式様式.pdf"
      htmlNote="官製様式（青色申告決算書 一般用・損益／内訳／減価償却／貸借対照表の4ページ）の HTML 再現です。金額は「公式様式PDF」と同一集計。参考帳票につき税理士確認のうえ提出してください。"
    >
      <BlueStatementForm data={data} />
    </FormPreviewSwitch>
  )
}

function BlueDeductionPanel() {
  const [data, setData] = useState<BlueReturnSummary | null>(null)
  const [err, setErr] = useState('')
  const [busy, setBusy] = useState(false)

  const reload = () => {
    api.blueDeduction().then(setData).catch((e) => setErr(String(e)))
  }
  useEffect(reload, [])

  const toggle65 = async (qualifies: boolean) => {
    setBusy(true)
    setErr('')
    try {
      await api.setBlueDeduction65(qualifies)
      reload()
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={SECTION}>
      <h2>
        青色申告特別控除・所得金額（㊸㊹㊺）
        <PdfButton path="/api/tax-return/blue-statement.pdf" filename="青色申告決算書_損益.pdf" />
        <PdfButton path="/api/tax-return/blue-statement-official.pdf" filename="青色申告決算書_公式様式.pdf" label="公式様式PDF" />
      </h2>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 12px' }}>
        ㊸控除前所得 − ㊹青色申告特別控除 = ㊺所得金額（確定申告書の事業所得へ転記）。本システムは複式簿記前提。
        「公式様式PDF」は国税庁様式に座標差込（損益＝1枚目・月別売上仕入／各種内訳／控除計算＝2枚目・減価償却＝3枚目・貸借対照表＝4枚目を記入）。
      </p>
      {err && <p style={{ color: COLORS.error }}>{err}</p>}
      {!data ? (
        <p style={{ color: COLORS.muted }}>…</p>
      ) : (
        <>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', color: COLORS.sub, fontSize: 13, marginBottom: 12 }}>
            <input type="checkbox" checked={data.qualifiesFor65} disabled={busy} onChange={(e) => toggle65(e.target.checked)} />
            e-Tax電子申告 または 優良な電子帳簿の保存（65万円控除の要件を満たす）
          </label>
          <table className="tbl" style={{ maxWidth: 440 }}>
            <tbody>
              <tr>
                <td>㊸ 控除前所得金額</td>
                <td className="num">{yen(data.incomeBeforeDeduction)}</td>
              </tr>
              <tr>
                <td>㊹ 青色申告特別控除額<span style={{ color: COLORS.muted, fontSize: 13 }}>（限度 {yen(data.deductionLimit)}）</span></td>
                <td className="num">− {yen(data.deduction)}</td>
              </tr>
              <tr style={{ fontWeight: 600, color: COLORS.ok, borderTop: `2px solid ${COLORS.border}` }}>
                <td>㊺ 所得金額</td>
                <td className="num">{yen(data.income)}</td>
              </tr>
            </tbody>
          </table>
          <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 8 }}>判定: {data.basis}</p>
        </>
      )}
    </section>
  )
}

function CapitalTransferPanel({ onRolled }: { onRolled: () => void }) {
  const [preview, setPreview] = useState<CapitalTransferPreview | null>(null)
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [confirming, setConfirming] = useState(false)
  const [rolled, setRolled] = useState<RolloverResult | null>(null)
  // 繰越前の警告（[[web-app]]「繰越前の未処理明細の提示」）。繰越はブロックしない。
  const [precheck, setPrecheck] = useState<RolloverPrecheck | null>(null)

  useEffect(() => {
    api.rolloverPrecheck().then(setPrecheck).catch(() => setPrecheck(null))
  }, [rolled])

  const run = async () => {
    setBusy(true)
    setErr('')
    try {
      setPreview(await api.capitalTransferPreview())
    } catch (e) {
      setErr(`エラー: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  const rollover = async () => {
    setBusy(true)
    setErr('')
    try {
      const result = await api.executeRollover()
      setRolled(result)
      setConfirming(false)
      setPreview(null)
      onRolled()
    } catch (e) {
      setErr(`エラー: ${e}`)
    } finally {
      setBusy(false)
    }
  }

  const Row = ({ label, amount, sign }: { label: string; amount: number; sign?: '+' | '−' }) => (
    <tr>
      <td>{sign ? `${sign} ` : ''}{label}</td>
      <td className="num">{yen(amount)}</td>
    </tr>
  )

  return (
    <section style={SECTION}>
      <h2>元入金振替（期末処理）</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 12px' }}>
        翌期首元入金 ＝ 前期末元入金 ＋ 当期所得 ＋ 事業主借 − 事業主貸。<b>計算のみで仕訳は起票しません</b>
        （翌期 opening_balances の元入金を決める値。年度繰越での反映は別途）。
      </p>
      <button disabled={busy} onClick={run} className="btn btn-ok">振替を計算</button>
      {err && <p style={{ color: COLORS.error }}>{err}</p>}
      {preview && (
        <table className="tbl" style={{ width: '100%', maxWidth: 480, marginTop: 12 }}>
          <tbody>
            <Row label="前期末元入金" amount={preview.priorMotoire} />
            <Row label="当期所得（控除前所得金額）" amount={preview.incomeBeforeDeduction} sign="+" />
            <Row label="事業主借 期末残高" amount={preview.ownerLoan} sign="+" />
            <Row label="事業主貸 期末残高" amount={preview.ownerDraw} sign="−" />
            <tr style={{ fontWeight: 600, color: COLORS.ok, borderTop: `2px solid ${COLORS.border}` }}>
              <td>翌期首元入金</td>
              <td className="num">{yen(preview.nextMotoire)}</td>
            </tr>
          </tbody>
        </table>
      )}

      <h3 style={{ color: COLORS.sub, marginTop: '1.5rem' }}>年度繰越（当期を確定し翌期へ）</h3>
      <p style={WARN_BANNER}>
        ⚠ この操作は当期を <b>確定（closed）</b> し編集をロックします。翌期を作成し、資産・負債の期末残高と
        元入金（＝翌期首元入金）を翌期の開始残高として繰越します。<b>確定申告内容の税理士確認後</b>に実行してください。
      </p>
      {!rolled && precheck && precheck.unprocessedRaw.pending + precheck.unprocessedRaw.ignored > 0 && (
        <p style={{ color: COLORS.warn, fontSize: 13, margin: '8px 0' }}>
          当期に未処理の取込明細が {precheck.unprocessedRaw.pending + precheck.unprocessedRaw.ignored} 件あります
          （未仕訳 {precheck.unprocessedRaw.pending} ／ 除外 {precheck.unprocessedRaw.ignored}）。
          <b>繰越後は仕訳化できなくなります</b>（明細は証跡として残ります）。必要なら先に取込明細タブで処理してください。
        </p>
      )}
      {rolled && (
        <p style={{ color: COLORS.ok }}>
          繰越しました（翌期 開始残高 {rolled.generated} 件・元入金 {yen(rolled.nextMotoire)}）。
        </p>
      )}
      {!confirming ? (
        <button disabled={busy} onClick={() => setConfirming(true)} className="btn btn-ok">年度繰越を実行…</button>
      ) : (
        <span style={{ display: 'inline-flex', gap: 8, alignItems: 'center' }}>
          <span style={{ color: COLORS.error, fontSize: 13 }}>当期を確定して翌期へ繰越します。よろしいですか？</span>
          <button disabled={busy} onClick={rollover} style={{ background: COLORS.error, color: '#fff', border: 'none', borderRadius: 6, padding: '4px 12px', cursor: 'pointer' }}>確定して繰越</button>
          <button disabled={busy} onClick={() => setConfirming(false)} className="btn">キャンセル</button>
        </span>
      )}
    </section>
  )
}
