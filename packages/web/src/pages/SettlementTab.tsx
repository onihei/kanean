import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { TransferCandidateView, LinkedTransferView } from '../api.js'
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'
import { errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'

export function SettlementTab() {
  const [candidates, setCandidates] = useState<TransferCandidateView[]>([])
  const [links, setLinks] = useState<LinkedTransferView[]>([])
  const [loading, setLoading] = useState(true)
  const [msg, setMsg] = useState<MsgState>(null)

  const reload = () => {
    setLoading(true)
    Promise.all([api.transferCandidates(), api.linkedTransfers()])
      .then(([c, l]) => { setCandidates(c); setLinks(l) })
      .catch((e) => setMsg(errMsg(e)))
      .finally(() => setLoading(false))
  }
  useEffect(() => { reload() }, [])

  const act = async (fn: Promise<unknown>) => {
    setMsg(null)
    try { await fn; reload() } catch (e) { setMsg(errMsg(e)) }
  }

  const sideCell = (s: { label: string; txnDate: string; description: string | null }) => (
    <td>
      {s.label}
      <br />
      <span style={{ color: COLORS.muted, fontSize: 13 }}>{s.txnDate} {s.description ?? ''}</span>
    </td>
  )

  if (loading) return <p>…</p>
  return (
    <>
      <h2>名寄せ（口座間振替）</h2>
      <p style={{ color: COLORS.muted, fontSize: 13 }}>
        同額・逆方向・日付近接の<strong>別口座ペア</strong>を口座間振替の候補として検知します。名寄せすると2本の未確定明細を
        1本の振替仕訳（<strong>借)入金側口座 / 貸)出金側口座</strong>）にまとめ、振替が両口座のCSVで二重に計上されるのを防ぎます。
        生成は draft で、確定は確認画面で行います。<strong>会計的妥当性（二重計上防止）は税理士の確認を前提とします。</strong>
      </p>
      {msg && <p style={{ color: msg.kind === 'error' ? COLORS.error : COLORS.ok, fontSize: 13 }}>{msg.text}</p>}

      <h3>振替候補</h3>
      {candidates.length === 0 ? (
        <p style={{ color: COLORS.muted }}>振替候補はありません（同額・逆方向・別口座・日付近接のペア）。</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th className="num">金額</th>
              <th>出金（貸方）</th>
              <th>入金（借方）</th>
              <th>日付差</th>
              <th>裏付け</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {candidates.map((c) => (
              <tr key={`${c.out.id}-${c.in.id}`}>
                <td className="num">{yen(c.amount)}</td>
                {sideCell(c.out)}
                {sideCell(c.in)}
                <td>{c.dateDiffDays}日</td>
                <td>
                  {c.confidence === 'weak'
                    ? <span style={{ color: COLORS.warn }} title="摘要に振替系の語が無く、偶然の同額一致の可能性があります。要確認。">⚠ 裏付けなし</span>
                    : <span style={{ color: COLORS.ok }}>振替系摘要あり</span>}
                </td>
                <td><button type="button" onClick={() => act(api.linkTransfer(c.out.id, c.in.id))}>振替として名寄せ</button></td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      <h3 style={{ marginTop: 16 }}>名寄せ済み振替</h3>
      {links.length === 0 ? (
        <p style={{ color: COLORS.muted }}>名寄せ済みの振替はありません。</p>
      ) : (
        <table className="tbl">
          <thead>
            <tr>
              <th className="num">金額</th>
              <th>出金（貸方）</th>
              <th>入金（借方）</th>
              <th>状態</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {links.map((l) => {
              const confirmed = l.entryStatus === 'confirmed'
              return (
                <tr key={`${l.out.id}-${l.in.id}`}>
                  <td className="num">{yen(l.amount)}</td>
                  {sideCell(l.out)}
                  {sideCell(l.in)}
                  <td>{confirmed ? '確定' : 'draft'}</td>
                  <td>
                    <button type="button" disabled={confirmed} title={confirmed ? '確定済みは先に確定取消が必要' : ''} onClick={() => act(api.unlinkTransfer(l.out.id))} className="btn">解除</button>
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
