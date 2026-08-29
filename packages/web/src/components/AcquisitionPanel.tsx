import { COLORS } from '../lib/styles.js'
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import type { AcquisitionJob, JobState, LinkedService } from '../api.js'

/**
 * 連携サービスの取込（[acquisition spec]「取込の開始と進行の提示」）。
 *
 * 取込は人のログイン待ちを含む長い仕事なので、**進行中であることが分からないまま待たせない**。
 * 何を待っているのか・どこで失敗したのか・結果は何件だったのかを、この panel が受け持つ。
 *
 * 取り込んだ明細は**分類を待たずに** draft として下の一覧へ並ぶ。科目が決まらなかったものは
 * 未確定勘定の draft になり、人が画面で選ぶか Claude Desktop に「仕訳して」と頼んで埋める。
 */

const STATE_LABEL: Record<JobState, string> = {
  starting: '開始しています…',
  awaiting_login: 'ログイン待ち',
  fetching: '明細を取得しています…',
  done: '取り込みました',
  failed: '失敗',
  aborted: '中断しました',
}

const TONE: Record<JobState, { bg: string; border: string; fg: string }> = {
  starting: { bg: COLORS.accentBg, border: COLORS.accentBorder, fg: COLORS.sub },
  fetching: { bg: COLORS.accentBg, border: COLORS.accentBorder, fg: COLORS.sub },
  awaiting_login: { bg: COLORS.warnBg, border: COLORS.warnBorder, fg: COLORS.warn },
  done: { bg: COLORS.okBg, border: COLORS.okBorder, fg: COLORS.ok },
  failed: { bg: COLORS.errorBg, border: COLORS.errorBorder, fg: COLORS.error },
  aborted: { bg: COLORS.bgSubtle, border: COLORS.border, fg: COLORS.sub },
}

const RUNNING: JobState[] = ['starting', 'fetching', 'awaiting_login']
const POLL_MS = 1500
/** 進行問い合わせがこの回数連続で失敗したらポーリングを諦める（サーバ再起動・ジョブ消失）。 */
const POLL_MAX_FAILURES = 4

export function AcquisitionPanel({
  service,
  onDone,
  hasCsvFallback = false,
}: {
  service: LinkedService
  onDone: () => void
  /** このサービスは CSV 取込も持つか。持つなら、巡回できないときの案内を短く済ませる。 */
  hasCsvFallback?: boolean
}) {
  const [available, setAvailable] = useState<boolean | null>(null)
  const [hasCrawler, setHasCrawler] = useState(false)
  const [job, setJob] = useState<AcquisitionJob | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const notified = useRef<string | null>(null)

  const loadTargets = useCallback(async () => {
    try {
      const t = await api.acquisitionTargets()
      setAvailable(t.crawlerAvailable)
      setHasCrawler(t.targets.some((x) => x.source === service.serviceKey && x.hasCrawler))
    } catch {
      // 開発時（server 単体）はこのルートが無い。押せない理由を出せればよいので黙って倒す。
      setAvailable(false)
    }
  }, [service.serviceKey])

  // 進行中のジョブがあれば引き継ぐ（画面を開き直しても追える）。終了済みも結果表示として
  // 引き継ぐが、onDone は発火させない（発火するとマウントのたびに draft 一覧を余分に取り直す）。
  const loadCurrent = useCallback(async () => {
    try {
      const jobs = await api.acquisitionJobs()
      const mine = jobs.find((j) => j.source === service.serviceKey)
      if (mine) {
        if (!RUNNING.includes(mine.state)) notified.current = mine.jobId
        setJob(mine)
      }
    } catch {
      /* 取れなくても開始はできる */
    }
  }, [service.serviceKey])

  useEffect(() => {
    void loadTargets()
    void loadCurrent()
  }, [loadTargets, loadCurrent])

  // 進行中だけポーリングする（終わったら止める）。
  // - 依存は jobId/state に絞る: [job] だと応答のたびに interval が再生成され、実効周期が
  //   POLL_MS + RTT に伸びる（issue #156）。
  // - 失敗は連続回数を数えて諦める: 握りつぶすだけだと job が更新されず停止条件に到達しない
  //   ため、サーバ再起動・ジョブ消失時に画面を閉じるまで叩き続け、エラー表示も出なかった。
  const jobId = job?.jobId
  const jobState = job?.state
  useEffect(() => {
    if (!jobId || !jobState || !RUNNING.includes(jobState)) return
    let failures = 0
    const id = setInterval(() => {
      api
        .acquisitionJob(jobId)
        .then((j) => {
          failures = 0
          setJob(j)
        })
        .catch(() => {
          failures++
          if (failures < POLL_MAX_FAILURES) return
          clearInterval(id)
          setJob(null)
          setError(
            '取込の進行状態を確認できなくなりました（アプリの再起動などでジョブが見つかりません）。もう一度「明細を取り込む」からやり直せます。',
          )
        })
    }, POLL_MS)
    return () => clearInterval(id)
  }, [jobId, jobState])

  // 完了したら draft 一覧を更新する（1つのジョブにつき1回だけ）
  useEffect(() => {
    if (job?.state === 'done' && notified.current !== job.jobId) {
      notified.current = job.jobId
      onDone()
    }
  }, [job, onDone])

  const start = async () => {
    setBusy(true)
    setError(null)
    try {
      setJob(await api.startAcquisition(service.serviceKey))
    } catch (e) {
      setError(String(e))
      void loadCurrent() // 二重起動なら進行中のジョブを拾い直す
    } finally {
      setBusy(false)
    }
  }

  const abort = async () => {
    if (!job) return
    setBusy(true)
    try {
      setJob(await api.abortAcquisition(job.jobId))
    } catch (e) {
      setError(String(e))
    } finally {
      setBusy(false)
    }
  }

  if (available === null) return null // 判定中は何も出さない（一瞬だけ案内が出るのを避ける）

  if (available === false || !hasCrawler) {
    // CSV 取込がある場合は、その入口がすぐ下にあるので短く済ませる（同じことを二度言わない）。
    if (hasCsvFallback) {
      return (
        <p style={{ ...NOTE, fontSize: 13 }}>
          明細の自動巡回は <strong>Kanean デスクトップアプリ</strong> から行えます
          {available === false && '（ブラウザ表示からは実行できません）'}。
          下の CSV 取込はいつでも使えます。
        </p>
      )
    }
    return (
      <p style={NOTE}>
        このサービスの明細取込は <strong>Kanean デスクトップアプリ</strong> から行います
        {available === false && '（ブラウザの窓を開く操作のため、開発用のブラウザ表示からは実行できません）'}。
        アプリで開始すると、ログインと2要素認証を入力する窓が開きます。
        <br />
        科目の分類は Claude Desktop に任せられます（各種設定 → Claude Desktop 連携）。
      </p>
    )
  }

  const running = job != null && RUNNING.includes(job.state)

  return (
    <section style={{ margin: '0 0 1rem' }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <button onClick={start} disabled={busy || running} className="btn btn-ok">
          {running ? '取込中…' : '明細を取り込む'}
        </button>
        {running && (
          <button onClick={abort} disabled={busy} className="btn">
            中断する
          </button>
        )}
        <span style={{ fontSize: 13, color: COLORS.muted }}>
          取得範囲は「開いている会計年度 ∩ 前回取得以降」。ログインは開いた窓にご自身で入力してください。
          取り込んだ明細は分類を待たずに下の一覧へ並びます。
        </span>
      </div>

      {error && <p style={{ ...box(TONE.failed), marginTop: 10 }}>{error}</p>}

      {job && (
        <div style={{ ...box(TONE[job.state]), marginTop: 10 }}>
          <strong>{STATE_LABEL[job.state]}</strong>
          <span style={{ marginLeft: 8, fontSize: 13 }}>
            {job.range.since} 〜 {job.range.until}
            {job.rangeLimited && '（範囲を限定）'}
          </span>

          {job.state === 'awaiting_login' && (
            <p style={{ margin: '6px 0 0' }}>
              {job.waitingFor ?? 'ログインを待っています'}
              <br />
              <small>開いたウィンドウで ID・パスワード・ワンタイムパスワードを入力してください（アプリは受け取りません）。</small>
            </p>
          )}

          {job.state === 'done' && job.counts && <Counts counts={job.counts} />}

          {job.state === 'failed' && (
            <p style={{ margin: '6px 0 0' }}>
              {job.failedStep && <>手順「{job.failedStep}」で失敗しました。</>}
              {job.message}
              <br />
              <small>もう一度「明細を取り込む」を押すと最初からやり直せます。原因の詳細は Claude Desktop から確認できます。</small>
            </p>
          )}

          {job.state === 'aborted' && (
            <p style={{ margin: '6px 0 0' }}>{job.message ?? '中断しました（何も取り込んでいません）。'}</p>
          )}
        </div>
      )}
    </section>
  )
}

function Counts({ counts }: { counts: NonNullable<AcquisitionJob['counts']> }) {
  return (
    <div style={{ marginTop: 6 }}>
      <div>
        受理 {counts.accepted} 件 ／ 重複 {counts.duplicated} 件 ／ 期間外 {counts.outOfPeriod} 件 ／ 未確定{' '}
        {counts.unresolved} 件{counts.failed > 0 && <> ／ 取得できず {counts.failed} 件</>}
      </div>
      {counts.unresolved > 0 && (
        <div style={{ fontSize: 13, marginTop: 4 }}>
          うち {counts.unresolved} 件は科目が決まっていません（未確定勘定）。下の一覧で科目を選ぶか、
          Claude Desktop で「仕訳して」と頼むと候補が入ります。
        </div>
      )}
      {counts.failed > 0 && (
        <div style={{ fontSize: 13, marginTop: 4 }}>
          {counts.failed} 件は取得できませんでした（下の警告に理由があります）。取り込み済みの分は
          重複として自動でスキップされるので、もう一度取込を実行すると再取得を試みます。
        </div>
      )}
      {counts.warnings.length > 0 && (
        <ul style={{ margin: '6px 0 0', paddingLeft: '1.2rem', fontSize: 13 }}>
          {counts.warnings.map((w, i) => (
            <li key={i}>{w}</li>
          ))}
        </ul>
      )}
      <div style={{ fontSize: 13, marginTop: 4 }}>
        取り込んだ仕訳は<strong>すべて未確定（draft）</strong>です。下の一覧で内容を確認して確定してください。
      </div>
    </div>
  )
}

const NOTE: React.CSSProperties = {
  color: COLORS.warn,
  background: COLORS.warnBg,
  border: `1px solid ${COLORS.warnBorder}`,
  borderRadius: 6,
  padding: '8px 10px',
}

function box(tone: { bg: string; border: string; fg: string }): React.CSSProperties {
  return {
    background: tone.bg,
    border: `1px solid ${tone.border}`,
    color: tone.fg,
    borderRadius: 6,
    padding: '8px 10px',
    margin: 0,
  }
}
