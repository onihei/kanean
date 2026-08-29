import { useState } from 'react'
import { COLORS } from '../lib/styles.js'
import { okMsg, errMsg } from './common.js'
import type { MsgState } from './common.js'
import { api } from '../api.js'
import type { LinkedService, CsvImportResult } from '../api.js'

/** サービス毎の CSV取込（口座/形式はサービス固定。file＋取込のみ）。ServicesTab から分割（issue #152）。 */
export function CsvImportPanel({ service, onDone }: { service: LinkedService; onDone: (msg: MsgState) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [imp, setImp] = useState<CsvImportResult['import'] | null>(null)

  const submit = async () => {
    if (!file) return
    setBusy(true)
    setImp(null)
    try {
      const r = await api.importCsv(service.serviceKey, service.accountRef, file)
      setImp(r.import)
      const st = r.import.status === 'partial' ? '（一部失敗 partial）' : r.import.status === 'failed' ? '（失敗 failed）' : ''
      onDone(
        okMsg(
          `取込 ${r.import.inserted}件${st}（重複${r.import.skippedDup}・期間外${r.import.skippedOutOfPeriod}・失敗${r.import.errorCount}）／draft生成 ${r.journalized.drafted}件`,
        ),
      )
    } catch (e) {
      onDone(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <section style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '12px 16px', margin: '0.5rem 0 1rem' }}>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <strong style={{ color: COLORS.sub }}>CSV取込</strong>
        <input type="file" accept=".csv" onChange={(e) => { setFile(e.target.files?.[0] ?? null); setImp(null) }} />
        <button disabled={busy || !file} onClick={submit} className="btn btn-ok">取込</button>
      </div>
      {imp && <ImportResultDetails imp={imp} />}
    </section>
  )
}

/** 取込結果の内訳（失敗行・重複行を黙って落とさず表示）。 */
function ImportResultDetails({ imp }: { imp: CsvImportResult['import'] }) {
  return (
    <>
      {imp.errorCount > 0 && (
        <details open style={{ marginTop: 10, fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: COLORS.error }}>
            {imp.errorCount} 行を取り込めませんでした（{imp.status === 'failed' ? '全行失敗' : '正常行は取込済み・部分取込'}・行単位の内訳）
          </summary>
          <p style={{ color: COLORS.muted, margin: '6px 0' }}>
            日付・金額が解釈できない行です。元CSVの該当行を修正して再取込してください（正常行は取り込まれています）。
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>行</th>
                <th>原因</th>
                <th>元データ</th>
              </tr>
            </thead>
            <tbody>
              {imp.errors.map((e, i) => (
                <tr key={i}>
                  <td>{e.rowNo > 0 ? e.rowNo : '—'}</td>
                  <td style={{ color: COLORS.error }}>{e.message}</td>
                  <td style={{ color: COLORS.muted, maxWidth: 360, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{e.raw}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {imp.errorCount > imp.errors.length && (
            <p style={{ color: COLORS.muted, marginTop: 4 }}>…他 {imp.errorCount - imp.errors.length} 件（先頭 {imp.errors.length} 件のみ表示）</p>
          )}
        </details>
      )}
      {imp.skippedDup > 0 && (
        <details style={{ marginTop: 10, fontSize: 13 }}>
          <summary style={{ cursor: 'pointer', color: COLORS.warn }}>
            重複として {imp.skippedDup} 件をスキップ（黙って落としていません・内訳を表示）
          </summary>
          <p style={{ color: COLORS.muted, margin: '6px 0' }}>
            既に取込済み、または<strong>同日・同額・同摘要の別取引</strong>の可能性があります（内容だけでは再取込と区別できません）。
            別取引なら手入力で追加してください。
          </p>
          <table className="tbl">
            <thead>
              <tr>
                <th>日付</th>
                <th className="num">金額</th>
                <th>摘要</th>
              </tr>
            </thead>
            <tbody>
              {imp.duplicates.map((d, i) => (
                <tr key={i}>
                  <td>{d.txnDate}</td>
                  <td className="num">{d.direction === 'out' ? '−' : '+'}¥{d.amount.toLocaleString()}</td>
                  <td>{d.description}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {imp.skippedDup > imp.duplicates.length && (
            <p style={{ color: COLORS.muted, marginTop: 4 }}>…他 {imp.skippedDup - imp.duplicates.length} 件（先頭 {imp.duplicates.length} 件のみ表示）</p>
          )}
        </details>
      )}
    </>
  )
}
