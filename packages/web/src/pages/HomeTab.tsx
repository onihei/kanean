/** ホーム: ダッシュボード（KPI・月次収支・納税予測）と初回セットアップ・「今やること」の導線。 */
import { COLORS, SECTION, VIZ } from '../lib/styles.js'
import { useEffect, useState } from 'react'
import { api } from '../api.js'
import type { BalanceSheet, McpLinkStatus, MonthlyTrend, ProfitAndLoss, TaxForecast } from '../api.js'
import type { TabKey } from '../nav/nav.js'
import { formatHash } from '../nav/route.js'
import type { SettingsKey } from './SettingsTab.js'
import { yen, deltaColor } from '../lib/format.js'
import { parseYenInput } from '../lib/money.js'
import { Msg, errMsg } from '../components/common.js'
import type { MsgState } from '../components/common.js'
import { BarChart } from '../components/charts.js'

// カードは共通 SECTION（issue #278 で radius 10 のローカル定義を統合）。警告カードは色だけ差し替える。
const WARN_CARD: React.CSSProperties = { ...SECTION, background: COLORS.warnBg, border: `1px solid ${COLORS.warnBorder}` }

/**
 * タブへ跳ぶボタン風の実アンカー（中クリック・新規ウィンドウが効く。issue #135）。
 * 設定タブのセクション指定も URL に載る（`#settings/<section>`・issue #136）＝純アンカー。
 */
function GoButton({ label, tab, section }: { label: string; tab: TabKey; section?: SettingsKey }) {
  return (
    <a
      href={formatHash({ tab, settingsSection: section })}
      className="btn btn-ok" style={{ display: 'inline-block', padding: '4px 12px', fontSize: 13, textDecoration: 'none' }}
    >
      {label} →
    </a>
  )
}

// section は設定タブ内で開くセクション（go: 'settings' のときだけ意味を持つ）。
// 「開始残高を登録」で飛んだのに事業者設定が開く、という迷子を作らない。
type Row = { label: string; action: string; go: TabKey; section?: SettingsKey }

// --- ダッシュボード用の集計（純関数） ----------------------------------------

/** BS の資産から「現金及び預金」区分の合計（現預金残高）を出す。評価勘定（貸方）は控除。 */
export function cashBalance(bs: BalanceSheet): number {
  let total = 0
  for (const sec of bs.assets)
    for (const r of sec.rows)
      if (r.categoryName === '現金及び預金') total += r.normalBalance === 'debit' ? r.balance : -r.balance
  return total
}

/**
 * 月次推移から売上・経費（売上原価含む）・差額の月次配列を作る。
 * PL 行のみを section の自然側（収益=貸方 / 費用=借方）に正規化して合算する
 * （売上値引などの評価勘定は符号反転で相殺。「その他（繰戻額等）」は稀なので除外）。
 */
export function monthlySeries(trend: MonthlyTrend): { sales: number[]; expenses: number[]; net: number[] } {
  const n = trend.months.length
  const sales = new Array<number>(n).fill(0)
  const expenses = new Array<number>(n).fill(0)
  for (const r of trend.rows) {
    if (r.reportType !== 'PL') continue
    if (r.section === '売上') {
      const sign = r.normalBalance === 'credit' ? 1 : -1
      r.monthly.forEach((v, i) => (sales[i] += sign * v))
    } else if (r.section === '売上原価' || r.section === '経費') {
      const sign = r.normalBalance === 'debit' ? 1 : -1
      r.monthly.forEach((v, i) => (expenses[i] += sign * v))
    }
  }
  return { sales, expenses, net: sales.map((s, i) => s - expenses[i]) }
}

/**
 * AI 連携の疎通案内（web-app spec「AI 連携の疎通案内」）。案内が要らなければ null。
 *
 * 取込の科目分類は Claude Desktop に委ねられる。その相手と繋がっているかはセットアップの一部
 * なので、初期設定の並びに出す。ただし**導入の有無は断定しない** — アプリはサーバ側にいるため、
 * クライアントが入っているかは判別できない。書けるのは観測できた到達と版の一致だけ。
 *
 * 同梱版が分からないとき（開発時・ブラウザ）は比較対象が無いので何も言わない。
 */
export function mcpLinkRow(status: McpLinkStatus | null): Row | null {
  if (!status || status.bundledVersion === null) return null

  if (!status.seen) {
    return {
      label: 'Claude Desktop との連携がまだ確認できていません（取込明細の科目分類を任せられます）',
      action: '連携を確認する',
      go: 'settings',
      section: 'ai',
    }
  }
  if (status.matches) return null

  // **過去形で書く**。Claude Desktop が起動していなければ観測は増えないので、
  // 「いま古い版が入っている」とは言えない。言えるのは「いつ何が使われたか」だけ。
  const used = status.lastVersion === 'unknown' ? '版を名乗らない拡張' : `拡張 ${status.lastVersion}`
  const when = status.lastSeenAt ? `${status.lastSeenAt.slice(0, 10)} に` : ''
  return {
    label: `Claude Desktop で ${when}${used} が使われました（同梱は ${status.bundledVersion}）。入れ直しが必要です`,
    action: '連携ファイルを書き出す',
    go: 'settings',
    section: 'ai',
  }
}

// --- 部品 ---------------------------------------------------------------------

/** KPI カード（value 未定 = ロード中は「…」）。 */
function Kpi({ label, value, color }: { label: string; value?: string; color?: string }) {
  return (
    <div style={{ border: `1px solid ${COLORS.border}`, borderRadius: 8, padding: '12px 14px' }}>
      <div style={{ color: COLORS.muted, fontSize: 13, marginBottom: 4 }}>{label}</div>
      <div style={{ fontSize: 20, fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: color ?? COLORS.text }}>
        {value ?? '…'}
      </div>
    </div>
  )
}

/** 納税予測の内訳 1 項目。 */
function TaxItem({ label, amount }: { label: string; amount: number }) {
  return (
    <div style={{ minWidth: 130 }}>
      <div style={{ color: COLORS.muted, fontSize: 13 }}>{label}</div>
      <div style={{ fontSize: 15, fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>{yen(amount)}</div>
    </div>
  )
}

const INPUT: React.CSSProperties = {
  border: `1px solid ${COLORS.border}`,
  borderRadius: 6,
  padding: '4px 8px',
  width: 110,
  textAlign: 'right',
  font: 'inherit',
}

/** what-if ミニシミュレータ（経費/所得控除の追加額 → 税額差分）。 */
function WhatIfSimulator() {
  const [expense, setExpense] = useState('')
  const [deduction, setDeduction] = useState('')
  const [busy, setBusy] = useState(false)
  const [msg, setMsg] = useState<MsgState>(null)
  const [result, setResult] = useState<TaxForecast | null>(null)

  const run = async () => {
    const extraExpense = parseYenInput(expense)
    const extraDeduction = parseYenInput(deduction)
    if (extraExpense == null || extraDeduction == null) {
      setMsg(errMsg('金額は数字（円）で入力してください'))
      return
    }
    if (extraExpense === 0 && extraDeduction === 0) {
      setMsg(errMsg('追加の経費または所得控除の金額を入力してください'))
      return
    }
    setBusy(true)
    setMsg(null)
    setResult(null)
    try {
      const f = await api.taxForecast({ extraExpense, extraDeduction })
      if (f?.whatIf) setResult(f)
      else setMsg(errMsg('試算結果を取得できませんでした'))
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  const w = result?.whatIf
  return (
    <div style={{ borderTop: `1px solid ${COLORS.borderFaint}`, marginTop: 14, paddingTop: 12 }}>
      <h4 style={{ margin: '0 0 8px', fontSize: 15 }}>もしもの試算（what-if）</h4>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', alignItems: 'center', fontSize: 13, color: COLORS.text }}>
        <label>
          経費をあと <input value={expense} onChange={(e) => setExpense(e.target.value)} placeholder="100,000" style={INPUT} /> 円使うと
        </label>
        <label>
          所得控除をあと <input value={deduction} onChange={(e) => setDeduction(e.target.value)} placeholder="0" style={INPUT} /> 円増やすと
        </label>
        <button
          disabled={busy}
          onClick={run}
          className="btn btn-ok" style={{ padding: '4px 12px', fontSize: 13 }}
        >
          {busy ? '試算中…' : '試算する'}
        </button>
      </div>
      <Msg msg={msg} />
      {w && result && (
        // 矢印の左辺は**同じ応答**の projected を使う（ページ読込時の予測カードと時点がずれても、
        // この一文の中では「→」と delta が必ず算術的に整合する）。
        <p style={{ margin: '10px 0 0', fontSize: 13, fontVariantNumeric: 'tabular-nums' }}>
          年間税負担 {yen(result.projected.totalTax)} → {yen(w.totalTax)}（
          <span style={{ color: w.delta < 0 ? COLORS.ok : w.delta > 0 ? COLORS.error : COLORS.muted, fontWeight: 600 }}>
            {w.delta < 0 ? `税額 ▲${(-w.delta).toLocaleString()}円` : w.delta > 0 ? `税額 +${w.delta.toLocaleString()}円` : '税額 変わらず'}
          </span>
          ）
        </p>
      )}
    </div>
  )
}

// --- ページ本体 -----------------------------------------------------------------

/**
 * ホームのデータ読み込み（issue #157 で集約）。10 API を並列に発火し、各カードは独立に埋まる
 * （1本の失敗が他カードを道連れにしない＝Promise.all にしない）。失敗・年度なしは null で
 * 「非表示 or 案内を出さない」に落ちる。アンマウント後の遅延応答は alive ガードで無視する
 * （ServicesTab 側の draft 一覧と同方針。ローカル socket ＋同期 SQLite なので 10 本の並列
 * リクエスト自体は安価 — 集約エンドポイント化（10→2）は測って問題になってから）。
 */
function useHomeData() {
  const [businessName, setBusinessName] = useState<string | null | undefined>(undefined)
  const [configured, setConfigured] = useState<boolean | null>(null)
  const [serviceCount, setServiceCount] = useState<number | null>(null)
  const [openingCount, setOpeningCount] = useState<number | null>(null)
  const [draftCount, setDraftCount] = useState<number | null>(null)
  const [pendingCount, setPendingCount] = useState<number | null>(null)
  // 取れなければ null のまま＝案内を出さない（連携の状態が分からないことを問題として見せない）。
  const [mcpLink, setMcpLink] = useState<McpLinkStatus | null>(null)
  // ダッシュボードデータ（undefined=ロード中 / null=年度なし or 取得失敗 → 非表示）。
  const [pl, setPl] = useState<ProfitAndLoss | null | undefined>(undefined)
  const [bs, setBs] = useState<BalanceSheet | null | undefined>(undefined)
  const [trend, setTrend] = useState<MonthlyTrend | null | undefined>(undefined)
  const [forecast, setForecast] = useState<TaxForecast | null | undefined>(undefined)

  useEffect(() => {
    let alive = true
    const load = <T,>(p: Promise<T>, ok: (v: T) => void, fail: () => void) =>
      p.then((v) => alive && ok(v)).catch(() => alive && fail())

    load(api.businessSettings(), (s) => { setBusinessName(s.businessName); setConfigured(s.configured) }, () => { setBusinessName(null); setConfigured(null) })
    load(api.services(), (s) => setServiceCount(s.length), () => setServiceCount(null))
    load(api.openingBalances(), (d) => setOpeningCount(d.balances.length), () => setOpeningCount(null))
    load(api.drafts(), (d) => setDraftCount(d.length), () => setDraftCount(null))
    load(api.rawTransactions('pending'), (d) => setPendingCount(d.total), () => setPendingCount(null))
    load(api.mcpLink(), setMcpLink, () => setMcpLink(null))
    load(api.pl(), setPl, () => setPl(null))
    load(api.bs(), setBs, () => setBs(null))
    load(api.monthlyTrend(), setTrend, () => setTrend(null))
    load(api.taxForecast(), setForecast, () => setForecast(null))
    return () => {
      alive = false
    }
  }, [])

  return { businessName, configured, serviceCount, openingCount, draftCount, pendingCount, mcpLink, pl, bs, trend, forecast }
}

export function HomeTab() {
  const { businessName, configured, serviceCount, openingCount, draftCount, pendingCount, mcpLink, pl, bs, trend, forecast } = useHomeData()

  // 初回セットアップ（未完了のものだけ並べる）。屋号は任意なので「保存済みか（configured）」で判定する。
  const setup: Row[] = []
  if (configured === false) setup.push({ label: '事業者設定（屋号・申告区分・経理方式）が未入力です', action: '設定を開く', go: 'settings', section: 'business' })
  if (openingCount === 0) setup.push({ label: '開始残高（期首残高）が未登録です', action: '開始残高を登録', go: 'settings', section: 'opening' })
  if (serviceCount === 0) setup.push({ label: '連携サービス（銀行・カード・EC）が未登録です', action: '連携サービスを追加', go: 'services' })
  // 固定資産は任意（持たないユーザーも多い）。「未登録」が永久に残るのを避け、初期設定からは外す。
  // 登録導線はクイックアクションと固定資産タブに残している。
  // AI 連携は**最後**に置く。上の3つは欠けると帳簿が作れないが、連携は欠けても人が画面で分類できる。
  const linkRow = mcpLinkRow(mcpLink)
  if (linkRow) setup.push(linkRow)

  // 今やること。
  const todo: Row[] = []
  if (draftCount && draftCount > 0) todo.push({ label: `確認待ちの仕訳が ${draftCount} 件あります`, action: '確認する', go: 'services' })
  if (pendingCount && pendingCount > 0) todo.push({ label: `未仕訳の取込明細が ${pendingCount} 件あります`, action: '取込明細を見る', go: 'raw' })

  const loaded =
    configured !== null && serviceCount !== null && openingCount !== null && draftCount !== null && pendingCount !== null

  const monthly = trend ? monthlySeries(trend) : null
  const hasPlRows = trend ? trend.rows.some((r) => r.reportType === 'PL') : false

  return (
    <>
      <h2 style={{ margin: '0 0 4px' }}>ホーム</h2>
      <p style={{ color: COLORS.muted, margin: '0 0 18px' }}>
        {businessName ? `${businessName} さんの会計` : 'Kanean — 個人事業主の確定申告・会計'}
      </p>

      {loaded && setup.length > 0 && (
        <section style={WARN_CARD}>
          <h3 style={{ margin: '0 0 4px', color: COLORS.warn }}>はじめに（初期設定）</h3>
          <p style={{ color: COLORS.warn, fontSize: 13, margin: '0 0 10px' }}>
            乗り換え・新規利用の最初に、下記を済ませると帳票・申告が正しく出ます。
          </p>
          {setup.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
              <span style={{ color: COLORS.sub }}>⚠ {r.label}</span>
              <GoButton label={r.action} tab={r.go} section={r.section} />
            </div>
          ))}
        </section>
      )}

      {/* 上段 KPI（年初来）。年度なし（null）は非表示 = 初期設定ガイドに任せる。 */}
      {pl !== null && (
        <section style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(170px, 1fr))', gap: 12, marginBottom: 16 }}>
          <Kpi label="売上（年初来）" value={pl && yen(pl.sales.total)} />
          <Kpi label="経費（年初来・原価含む）" value={pl && yen(pl.costOfSales.total + pl.expenses.total)} />
          <Kpi label="当期所得" value={pl && yen(pl.netIncome)} color={pl ? deltaColor(pl.netIncome) : undefined} />
          <Kpi label="現預金残高" value={bs === undefined ? undefined : bs === null ? '—' : yen(cashBalance(bs))} />
        </section>
      )}

      {/* 納税予測（年間着地の概算）。本システムの差別化機能なので前面に出す。 */}
      {forecast !== null && (
        <section style={SECTION}>
          <h3 style={{ margin: '0 0 6px' }}>納税予測</h3>
          {forecast === undefined ? (
            <p style={{ color: COLORS.muted }}>…</p>
          ) : (
            <>
              <p style={{ color: COLORS.muted, fontSize: 13, margin: '0 0 10px' }}>
                経過 {forecast.elapsedMonths} ヶ月の実績（売上 {yen(forecast.actual.sales)}・事業所得 {yen(forecast.actual.businessIncome)}）を年換算した概算です。
              </p>
              <p style={{ margin: '0 0 12px', fontSize: 15 }}>
                このままいくと 年間税負担 合計{' '}
                <strong style={{ fontSize: 20, fontVariantNumeric: 'tabular-nums' }}>{yen(forecast.projected.totalTax)}</strong>
              </p>
              <div style={{ display: 'flex', gap: 24, flexWrap: 'wrap', marginBottom: 12 }}>
                <TaxItem label="所得税" amount={forecast.projected.incomeTax} />
                <TaxItem label="住民税（概算）" amount={forecast.projected.residentTax} />
                <TaxItem label="個人事業税（概算）" amount={forecast.projected.businessTax} />
                <TaxItem label="消費税" amount={forecast.projected.consumptionTax} />
              </div>
              <p
                style={{
                  background: COLORS.warnBg,
                  border: `1px solid ${COLORS.warnBorder}`,
                  borderRadius: 6,
                  color: COLORS.warn,
                  fontSize: 13,
                  padding: '6px 10px',
                  margin: 0,
                }}
              >
                {forecast.disclaimer}
              </p>
              <WhatIfSimulator />
            </>
          )}
        </section>
      )}

      {/* 月次収支（確定済み仕訳の発生高）。 */}
      {trend !== null && (
        <section style={SECTION}>
          <h3 style={{ margin: '0 0 10px' }}>月次収支</h3>
          {trend === undefined || !monthly ? (
            <p style={{ color: COLORS.muted }}>…</p>
          ) : !hasPlRows ? (
            <p style={{ color: COLORS.muted, margin: 0 }}>確定済みの仕訳がまだありません。取込・確認を進めるとグラフが埋まります。</p>
          ) : (
            <>
              <BarChart
                labels={trend.months.map((m) => `${Number(m.slice(5))}月`)}
                series={[
                  { label: '売上', color: VIZ.s1, values: monthly.sales },
                  { label: '経費', color: VIZ.s2, values: monthly.expenses },
                  { label: '差額', color: VIZ.s3, values: monthly.net },
                ]}
              />
              <p style={{ color: COLORS.muted, fontSize: 13, margin: '6px 0 0' }}>
                確定済み仕訳の月次発生高。経費は売上原価を含み、差額 = 売上 − 経費。
              </p>
            </>
          )}
        </section>
      )}

      <section style={SECTION}>
        <h3 style={{ margin: '0 0 10px' }}>今やること</h3>
        {!loaded ? (
          <p style={{ color: COLORS.muted }}>…</p>
        ) : todo.length === 0 ? (
          <p style={{ color: COLORS.muted, margin: 0 }}>未処理の仕訳はありません。CSVを取り込むと自動仕訳の候補が並びます。</p>
        ) : (
          todo.map((r, i) => (
            <div key={i} style={{ display: 'flex', gap: 12, alignItems: 'center', justifyContent: 'space-between', padding: '6px 0' }}>
              <span style={{ color: COLORS.text }}>• {r.label}</span>
              <GoButton label={r.action} tab={r.go} section={r.section} />
            </div>
          ))
        )}
      </section>

      <section style={SECTION}>
        <h3 style={{ margin: '0 0 10px' }}>クイックアクション</h3>
        <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
          <GoButton label="CSVを取り込む" tab="services" />
          <GoButton label="仕訳を手入力" tab="entry" />
          <GoButton label="請求書を作成" tab="invoices" />
          <GoButton label="固定資産を登録" tab="assets" />
          <GoButton label="決算・申告へ" tab="closing" />
        </div>
      </section>
    </>
  )
}
