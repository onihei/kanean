import { useState, useEffect } from 'react'
import { COLORS } from '../lib/styles.js'
import { yen, listDate, inScope, type DateScope } from '../lib/format.js'
import { RAW_STATUS_LABEL, RAW_LIST_LIMIT, SOURCES } from '../lib/labels.js'
import { errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import { api } from '../api.js'
import type { RawStatus, RawTransactionView, ImportFormat } from '../api.js'

/**
 * 列幅の宣言（[[web-app]]「一覧行の折り返し」）。
 *
 * `table-layout: fixed` と対で使う。auto のままだと摘要がセル内で折り返して行高が可変になり、
 * 行ごとに高さが違う表になる。幅を宣言して摘要だけ残り幅を取らせ、溢れた分は省略する。
 * 日付が 90px あるのは、「過年度も表示」で会計年度の外の行が混ざると `YYYY-MM-DD` が出るため（listDate 参照）。
 * 状態は最長の「仕訳済（draft）」が入る幅を確保する（ここは切れても title で開く先が無いので、
 * 省略させてはいけない列）。摘要だけが auto ＝残り幅を取り、溢れたら省略して title に全文を残す。
 */
const COL_W = ['90px', '180px', 'auto', '110px', '130px', '70px']

export function RawTransactionsTab({ fiscalYear }: { fiscalYear: DateScope }) {
  const [status, setStatus] = useState<RawStatus | ''>('')
  // 年スコープ（[[web-app]]「取込明細の年スコープ」）。既定は開いている会計年度に閉じる。
  const [allYears, setAllYears] = useState(false)
  const [rows, setRows] = useState<RawTransactionView[]>([])
  const [total, setTotal] = useState(0)
  const [truncated, setTruncated] = useState(false)
  const [outOfYear, setOutOfYear] = useState(0)
  const [formats, setFormats] = useState<ImportFormat[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<MsgState>(null)

  // 組込3形式＋ユーザー定義フォーマット（format:{id}）の表示名を解決（ImportForm の labelOf と同等）。
  const labelOf = (v: string) =>
    v.startsWith('format:') ? formats.find((f) => `format:${f.id}` === v)?.name ?? v : SOURCES.find((s) => s.value === v)?.label ?? v

  const reload = () => {
    setLoading(true)
    api.rawTransactions(status || undefined, allYears ? 'all' : 'open')
      .then((d) => { setRows(d.rawTransactions); setTotal(d.total); setTruncated(d.truncated); setOutOfYear(d.outOfYearTotal) })
      .catch((e) => setMsg(errMsg(e)))
      .finally(() => setLoading(false))
  }
  useEffect(reload, [status, allYears])
  useEffect(() => { api.importFormats().then(setFormats).catch((e) => setMsg(errMsg(e))) }, [])

  const act = async (fn: Promise<unknown>) => {
    setMsg(null)
    try { await fn; reload() } catch (e) { setMsg(errMsg(e)) }
  }

  return (
    <>
      <h2>取込明細</h2>
      <p style={{ color: COLORS.muted, fontSize: 13 }}>
        取込明細を状態別に確認し、事業の取引でないものを<strong>除外(ignored)</strong>へ退避できます。
        除外しても元データは保持され、いつでも<strong>復帰</strong>（再仕訳）できます。確定済みの仕訳がある明細は先に確定取消が必要です。
        既定では<strong>開いている会計年度</strong>の明細だけを表示します（過年度の行は証跡として残りますが、繰越後は仕訳化できません）。
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: '8px 0' }}>
        <label style={{ color: COLORS.sub }}>状態{' '}
          <select value={status} onChange={(e) => setStatus(e.target.value as RawStatus | '')}>
            <option value="">すべて</option>
            <option value="pending">未仕訳</option>
            <option value="journalized">仕訳済</option>
            <option value="ignored">除外</option>
          </select>
        </label>
        <label style={{ color: COLORS.sub }}>
          <input type="checkbox" checked={allYears} onChange={(e) => setAllYears(e.target.checked)} /> 過年度も表示
        </label>
        {!loading && <span style={{ color: COLORS.muted, fontSize: 13 }}>全 {total} 件</span>}
        {!loading && outOfYear > 0 && (
          <span style={{ color: COLORS.warn, fontSize: 13 }}>他の年度に {outOfYear} 件（「過年度も表示」で確認できます）</span>
        )}
        {msg && <span style={{ color: msg.kind === 'error' ? COLORS.error : COLORS.ok, fontSize: 13 }}>{msg.text}</span>}
      </div>
      {truncated && (
        <p style={{ color: COLORS.warn, fontSize: 13, margin: '0 0 6px' }}>
          全 {total} 件のうち新しい順に先頭 {RAW_LIST_LIMIT} 件を表示しています（古い明細は状態で絞り込んでください）。
        </p>
      )}
      {loading ? (
        <p>…</p>
      ) : rows.length === 0 ? (
        <p style={{ color: COLORS.muted }}>該当する取込明細がありません。</p>
      ) : (
        <table className="tbl" style={{ width: '100%', tableLayout: 'fixed' }}>
          <colgroup>
            {COL_W.map((w, i) => (
              <col key={i} style={{ width: w }} />
            ))}
          </colgroup>
          <thead>
            <tr>
              <th>日付</th>
              <th>口座 / 形式</th>
              <th>摘要</th>
              <th className="num">金額</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {rows.map((r) => {
              const confirmed = r.entryStatus === 'confirmed'
              // 開いている会計年度の外の行は仕訳化できない（サーバの会計期間ゲート）。押せるボタンにしない。
              const outOfPeriod = !inScope(r.txnDate, fiscalYear)
              const origin = `${r.accountRef ?? '—'} / ${labelOf(r.sourceType)}`
              return (
                <tr key={r.id}>
                  <td className="ellipsis">{listDate(r.txnDate, fiscalYear)}</td>
                  <td className="ellipsis" style={{ color: COLORS.muted }} title={origin}>{origin}</td>
                  <td className="ellipsis" title={r.description ?? undefined}>{r.description ?? '—'}</td>
                  <td className="num" style={{ whiteSpace: 'nowrap' }}>{r.direction === 'out' ? '−' : '+'}{yen(r.amount)}</td>
                  <td className="ellipsis">
                    {RAW_STATUS_LABEL[r.status] ?? r.status}
                    {r.status === 'journalized' && r.entryStatus && <span style={{ color: COLORS.muted }}>（{confirmed ? '確定' : 'draft'}）</span>}
                  </td>
                  <td style={{ whiteSpace: 'nowrap' }}>
                    {r.status === 'ignored' ? (
                      <button
                        type="button"
                        disabled={outOfPeriod}
                        title={outOfPeriod ? '開いている会計年度の範囲外です（繰越を取り消すか、当期の日付で手入力してください）' : ''}
                        onClick={() => act(api.restoreRaw(r.id))}
                        className="btn"
                      >
                        復帰
                      </button>
                    ) : (
                      <button type="button" disabled={confirmed} title={confirmed ? '確定済みは先に確定取消が必要' : ''} onClick={() => act(api.ignoreRaw(r.id))} className="btn">除外</button>
                    )}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      )}
    </>
  )
}
