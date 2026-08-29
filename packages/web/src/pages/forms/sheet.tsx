/**
 * 官製様式プレビューの共通プリミティブ。
 * 各様式コンポーネント（IncomeTaxForm / ConsumptionTaxForm / BlueStatementForm）が共有する
 * シート枠・ヘッダ（屋号/氏名/年分）・金額整形・印刷ボタンを提供する。スタイルは styles/forms.css。
 */
import { COLORS } from '../../lib/styles.js'
import { useEffect, useState, type ReactNode } from 'react'
import { api, type BusinessSettingsView, type FiscalYearView } from '../../api.js'
import { yen } from '../../lib/format.js'
import { reiwa } from '../../lib/japaneseEra.js'

/** 金額（円整形）。 */
export const money = (n: number) => yen(n)
/** 金額（0・未設定は空欄。官製様式は0欄を空白にする慣習）。 */
export const moneyOrBlank = (n: number | null | undefined) => (n ? yen(n) : '')

export interface FormHeader {
  /** 令和N年分。 */
  period: string
  /** 課税期間（YYYY-MM-DD 〜 YYYY-MM-DD）。 */
  rangeLabel: string
  businessName: string
  ownerName: string
  /** ヘッダ情報の取得失敗（空欄のまま黙って描かない。Sheet が警告を出す）。 */
  err: string
}

/** プレビュー様式の共通ヘッダ情報（open 年度＋事業者設定）。 */
export function useFormHeader(): FormHeader {
  const [settings, setSettings] = useState<BusinessSettingsView | null>(null)
  const [years, setYears] = useState<FiscalYearView[]>([])
  const [err, setErr] = useState('')
  useEffect(() => {
    let alive = true
    // 失敗を握りつぶすと屋号・氏名・年分が空欄のまま様式が静かに描かれる（issue #160）。
    api.businessSettings().then((v) => alive && setSettings(v)).catch((e) => alive && setErr(String(e)))
    api.fiscalYears().then((v) => alive && setYears(v)).catch((e) => alive && setErr(String(e)))
    return () => {
      alive = false
    }
  }, [])
  const open = years.find((y) => y.status === 'open')
  return {
    period: open ? `${reiwa(open.startDate)}分` : '',
    rangeLabel: open ? `${open.startDate} 〜 ${open.endDate}` : '',
    businessName: settings?.businessName ?? '',
    ownerName: settings?.ownerName ?? '',
    err,
  }
}

/** 1 枚の様式シート（A4 1ページ相当）。title/subtitle と屋号/氏名/年分メタを描く。 */
export function Sheet({
  title,
  subtitle,
  header,
  periodLabel = '年分',
  extraMeta,
  children,
}: {
  title: string
  subtitle?: string
  header?: FormHeader
  /** メタ行の年分ラベル（確定申告書=「年分」・消費税=「課税期間」）。 */
  periodLabel?: string
  /** 事業区分・みなし仕入率など様式固有のメタ。 */
  extraMeta?: { k: string; v: string }[]
  children: ReactNode
}) {
  return (
    <div className="gov-page">
      <h3 className="gov-title">{title}</h3>
      {subtitle && <div className="gov-subtitle">{subtitle}</div>}
      {header?.err && (
        <p style={{ color: COLORS.error, fontSize: 13 }}>
          ヘッダ情報（屋号・氏名・年分）を取得できませんでした: {header.err}
        </p>
      )}
      {header && (
        <div className="gov-meta">
          {header.period && (
            <span>
              <span className="k">{periodLabel}</span>
              {header.period}
              {header.rangeLabel && <span className="hint">（{header.rangeLabel}）</span>}
            </span>
          )}
          <span>
            <span className="k">屋号</span>
            {header.businessName || '—'}
          </span>
          <span>
            <span className="k">氏名</span>
            {header.ownerName || '—'}
          </span>
          {extraMeta?.map((m) => (
            <span key={m.k}>
              <span className="k">{m.k}</span>
              {m.v}
            </span>
          ))}
        </div>
      )}
      {children}
    </div>
  )
}

/** 印刷ボタン＋注意書きのツールバー（画面のみ・印刷時は非表示）。 */
export function PrintToolbar({ children }: { children?: ReactNode }) {
  return (
    <div className="gov-toolbar no-print">
      <button type="button" className="gov-print-btn" onClick={() => window.print()}>
        🖨 印刷 / PDF保存
      </button>
      {children}
    </div>
  )
}
