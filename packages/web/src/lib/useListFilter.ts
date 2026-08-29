import { useEffect, useState } from 'react'
import { monthBounds } from './format.js'

export interface ListFilterApplied {
  from: string
  to: string
  q: string
}

/**
 * 一覧の「期間(from/to)＋キーワード(q)」フィルタ（issue #158）。
 * 操作モデルはアプリ内で1本: **変更は即時適用・q だけ 300ms デバウンス**（打鍵ごとの連続フェッチ回避）。
 * 従来は 仕訳帳=検索ボタンで適用 / draft レビュー=即時適用 と食い違っていた。
 *
 * applied は「いま一覧に効いている値」。再取得の effect 依存にも CSV 出力パスの組み立てにも
 * これを使うと、表示中の一覧と出力条件が必ず一致する（旧 JournalTab の applied スナップショットが
 * ボタン適用で担っていた保証を、即時適用モデルでは applied がそのまま与える）。
 */
export function useListFilter() {
  const [from, setFrom] = useState('')
  const [to, setTo] = useState('')
  const [q, setQ] = useState('')
  const [qDeb, setQDeb] = useState('')

  useEffect(() => {
    const t = setTimeout(() => setQDeb(q), 300)
    return () => clearTimeout(t)
  }, [q])

  const applied: ListFilterApplied = { from, to, q: qDeb.trim() }
  const filtering = Boolean(from || to || qDeb.trim())
  const clear = () => {
    setFrom('')
    setTo('')
    setQ('')
    setQDeb('')
  }
  return { from, setFrom, to, setTo, q, setQ, applied, filtering, clear }
}

/**
 * 帳票の「月次ショートカット付き期間フィルタ」（issue #249。試算表・部門別が持っていた
 * 適用ボタン式の旧機械を、アプリ共通の即時適用モデル＝useListFilter へ統合）。
 * キーワード q は使わない（帳票に検索は無い）。月次を選ぶと from/to をその月に設定し、
 * from/to を手で触る・全期間に戻すと月次選択は外れる。
 */
export function usePeriodFilter() {
  const list = useListFilter()
  const [month, setMonth] = useState('')
  const pickMonth = (ym: string) => {
    setMonth(ym)
    if (!ym) return list.clear()
    const b = monthBounds(ym)
    list.setFrom(b.from)
    list.setTo(b.to)
  }
  const setFrom = (v: string) => {
    setMonth('')
    list.setFrom(v)
  }
  const setTo = (v: string) => {
    setMonth('')
    list.setTo(v)
  }
  const clear = () => {
    setMonth('')
    list.clear()
  }
  /** API・CSV パスへ渡す適用済み期間（空は undefined に落とし、表示中の一覧と出力条件を一致させる）。 */
  const period: { from?: string; to?: string } = {
    from: list.applied.from || undefined,
    to: list.applied.to || undefined,
  }
  return { from: list.from, setFrom, to: list.to, setTo, month, pickMonth, clear, period }
}
