/** 前期比較（複数年度比較）の共通部品: 年度セレクタ・比較セル・列見出し・読込フック。 */
import { useEffect, useState } from 'react'
import { qsOf } from '../api.js'
import type { FiscalYearView, CompareCell } from '../api.js'
import { COLORS, WARN_BANNER } from '../lib/styles.js'
import { yen, fmtPct, deltaColor, signedYen, fyLabel } from '../lib/format.js'
import { useReport, useFiscalYears } from '../lib/hooks.js'

/** 当期・比較対象（前期）の年度セレクタ。比較対象 '' は「自動（前期）」。 */
export function YearComparePicker({
  years, current, compareTo, onCurrent, onCompareTo,
}: {
  years: FiscalYearView[]
  current: number | ''
  compareTo: number | ''
  onCurrent: (v: number) => void
  onCompareTo: (v: number | '') => void
}) {
  return (
    <section style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap', margin: '0.25rem 0 0.75rem', color: COLORS.sub }}>
      <label>当期{' '}
        <select value={current} onChange={(e) => onCurrent(Number(e.target.value))}>
          {years.map((y) => <option key={y.id} value={y.id}>{fyLabel(y)}</option>)}
        </select>
      </label>
      <label>比較対象{' '}
        <select value={compareTo} onChange={(e) => onCompareTo(e.target.value === '' ? '' : Number(e.target.value))}>
          <option value="">自動（前期）</option>
          {years.map((y) => <option key={y.id} value={y.id}>{fyLabel(y)}</option>)}
        </select>
      </label>
    </section>
  )
}

/** 比較4列（当期/前期/増減/増減率）の td 群。 */
export function CompareCells({ c }: { c: CompareCell }) {
  return (
    <>
      <td className="num">{c.current ? yen(c.current) : ''}</td>
      <td className="num" style={{ color: COLORS.muted }}>{c.prior ? yen(c.prior) : ''}</td>
      <td className="num" style={{ color: deltaColor(c.delta) }}>{c.delta ? signedYen(c.delta) : ''}</td>
      <td className="num" style={{ color: COLORS.muted }}>{fmtPct(c.deltaPct)}</td>
    </>
  )
}

export const COMPARE_TH = (
  <>
    <th className="num">当期</th>
    <th className="num">前期</th>
    <th className="num">増減</th>
    <th className="num">増減率</th>
  </>
)

/** 前期データが無いときの注意書き（比較対象が初年度等で前期0）。 */
export function NoPriorNote() {
  return (
    <p style={WARN_BANNER}>
      比較対象（前期）のデータがありません。前期列は 0、増減率は「—」で表示しています。
    </p>
  )
}

/** 比較ビュー共通: 年度セレクタ状態と読込（current は years 取得時に open 年度へ初期化）。 */
export function useCompare<T>(load: (cur?: number, cmp?: number) => Promise<T | null>) {
  const years = useFiscalYears()
  const [current, setCurrent] = useState<number | ''>('')
  const [compareTo, setCompareTo] = useState<number | ''>('')
  useEffect(() => {
    if (years.length && current === '') {
      const open = years.find((y) => y.status === 'open') ?? years[years.length - 1]
      setCurrent(open.id)
    }
  }, [years, current])
  // current が確定（years 取得後）してから1回だけ取得。未確定時の冗長フェッチを避ける
  // （年度が1件も無ければ current は '' のままで null＝NoYear 表示）。
  const { data, err, loading } = useReport<T>(
    () => (current === '' ? Promise.resolve(null) : load(current, compareTo || undefined)),
    [current, compareTo],
  )
  const csvQs = () => qsOf({ fiscalYearId: current, compareTo })
  const picker = (
    <YearComparePicker years={years} current={current} compareTo={compareTo} onCurrent={setCurrent} onCompareTo={setCompareTo} />
  )
  return { data, err, loading, picker, csvQs }
}
