/** 帳票読込・会計年度取得の共通フック（JSX を含まない純フック）。 */
import { useEffect, useRef, useState } from 'react'
import { api, type FiscalYearView } from '../api.js'

/**
 * ウィンドウが前面に戻ったときに読み直す。
 *
 * 帳簿は**この画面の外からも変わる**（Claude Desktop から科目を当てる・取込が完了する）。
 * 変わったことを知る手段としてポーリングを常時回すより、「利用者が戻ってきた瞬間」に
 * 読み直すほうが素直で、編集中の画面を勝手に差し替えることもない
 * （戻ってきた時点では、開いているドロップダウンも無い）。
 */
export function useRefreshOnFocus(refresh: () => void, enabled = true): void {
  // 毎レンダーで作り直される関数を deps に入れると購読し直しになるので、最新版を ref で持つ。
  const latest = useRef(refresh)
  latest.current = refresh

  useEffect(() => {
    if (!enabled) return
    let lastRun = 0
    const run = () => {
      if (document.visibilityState !== 'visible') return
      // focus と visibilitychange が続けて飛ぶことがある。二重フェッチを避ける。
      const now = Date.now()
      if (now - lastRun < 500) return
      lastRun = now
      latest.current()
    }
    window.addEventListener('focus', run)
    document.addEventListener('visibilitychange', run)
    return () => {
      window.removeEventListener('focus', run)
      document.removeEventListener('visibilitychange', run)
    }
  }, [enabled])
}

/**
 * 単一リソースの読込フック（loading / err / data ＋ reload。issue #160 で拡張）。
 * - reload: 確定・更新操作の後に同じ読込を手で再実行する（マスタキャッシュ（C11）を
 *   入れる場合もこの関数が唯一の差し込み口になる）
 * - 追い越しガード: deps 変更・reload・アンマウントで世代を進め、古い応答は反映しない
 * - err は成功時にクリアする（エラー後の再読込成功で赤帯が残らない）
 */
export function useReport<T>(load: () => Promise<T | null>, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null)
  const [err, setErr] = useState('')
  const [loading, setLoading] = useState(true)
  const gen = useRef(0)
  const reload = () => {
    const g = ++gen.current
    setLoading(true)
    load()
      .then((d) => {
        if (gen.current !== g) return
        setData(d)
        setErr('')
      })
      .catch((e) => gen.current === g && setErr(String(e)))
      .finally(() => gen.current === g && setLoading(false))
  }
  useEffect(() => {
    reload()
    return () => {
      // 意図的に「最新の」世代を進めてアンマウント後の応答を無効化する（DOM ref ではないので誤検知）。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gen.current++
    }
    // 依存は呼び出し側が列挙する（load クロージャが読む値。useMasterCrud と同じ設計）。
    // リテラル配列でない deps と reload（毎レンダー再生成）非列挙への警告は意図的なので抑止。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, deps)
  return { data, err, loading, reload }
}

export function useFiscalYears() {
  const [years, setYears] = useState<FiscalYearView[]>([])
  useEffect(() => {
    let alive = true
    // 取れなければ空のまま＝一覧の日付から年を省かないだけ（表示の補助情報なので黙って劣化させる）。
    api.fiscalYears().then((ys) => alive && setYears(ys)).catch(() => {})
    return () => {
      alive = false
    }
  }, [])
  return years
}
