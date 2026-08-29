import { useState, useEffect, useRef } from 'react'
import { COLORS, SELECT_FIXED } from '../../lib/styles.js'
import { listDate, type DateScope } from '../../lib/format.js'
import { Msg, okMsg, errMsg } from '../../components/common.js'
import { useRefreshOnFocus } from '../../lib/hooks.js'
import { useListFilter } from '../../lib/useListFilter.js'
import type { MsgState } from '../../components/common.js'
import { api } from '../../api.js'
import type { Account, TaxCategory, DraftView, DraftOrigin, ListDraftsOpts } from '../../api.js'

/**
 * draft レビュー（確認待ち仕訳の一覧・精査・確定）。ServicesTab から分割（issue #152）。
 * 例外ベースレビュー: AI 分類の確信度（high/medium/low）と根拠を各行に示し、
 * high を一括選択→一括確定して、低確信度だけを精査する流れを支える。
 */

type ConfidenceFilter = '' | 'high' | 'medium' | 'low'

/**
 * draft 一覧パネル（全件・サービス毎で共有）。loadKey 変化とフィルタ変更で再取得、確定で自身＋親を更新。
 * 例外ベースレビュー: 「high をすべて選択」→「選択を一括確定」で高確信度をまとめて片付け、
 * 残った medium/low（と手動分）だけ根拠を見ながら1件ずつ精査する。
 */
export function DraftListPanel({
  loadKey,
  subAccountId,
  accounts,
  taxCats,
  fiscalYear,
  onChanged,
  emptyHint,
}: {
  loadKey: string
  subAccountId?: number
  accounts: Account[]
  taxCats: TaxCategory[]
  fiscalYear: DateScope
  onChanged: () => void
  emptyHint: string
}) {
  const [drafts, setDrafts] = useState<DraftView[]>([])
  const [msg, setMsg] = useState<MsgState>(null)
  const [selected, setSelected] = useState<Set<number>>(new Set())
  const [busy, setBusy] = useState(false)
  // フィルタ（即時適用・q は 300ms デバウンス。アプリ共通の操作モデル＝lib/useListFilter）。
  const { from, setFrom, to, setTo, q, setQ, applied, filtering: dateOrQ, clear } = useListFilter()
  const [conf, setConf] = useState<ConfidenceFilter>('')

  const filter = (): ListDraftsOpts => ({
    subAccountId,
    from: applied.from || undefined,
    to: applied.to || undefined,
    q: applied.q || undefined,
    confidence: conf || undefined,
  })
  const filtering = dateOrQ || Boolean(conf)

  // 一覧差し替え時に、消えた行（確定済み等）の選択を落とす（存在しない id を溜めない）。
  const applyDrafts = (ds: DraftView[]) => {
    setDrafts(ds)
    setSelected((prev) => new Set(ds.filter((d) => prev.has(d.id)).map((d) => d.id)))
  }

  // 再取得は全経路（フィルタ変更・前面復帰・確定後）この reload 1本。世代カウンタで
  // 遅延応答の追い越しを無視する: フィルタ変更直後にウィンドウ復帰が重なっても、
  // 古いフィルタの応答が新しい一覧を上書きしない（issue #152 で二重実装を一本化）。
  const gen = useRef(0)
  const reload = () => {
    const g = ++gen.current
    return api
      .drafts(filter())
      .then((ds) => gen.current === g && applyDrafts(ds))
      .catch((e) => gen.current === g && setMsg(errMsg(e)))
  }

  // Claude Desktop で科目を当てたあと Kanean に戻ってきた瞬間に読み直す
  // （この画面は開きっぱなしのまま、外で帳簿が変わる）。
  useRefreshOnFocus(reload)

  // loadKey（全件/サービス/取込トークン）・フィルタが変わったら読み直す。
  useEffect(() => {
    setMsg(null)
    void reload()
    // アンマウント後の遅延応答を無効化（依存変化時は次の reload が世代を進めるので実質アンマウント用）。
    return () => {
      // 意図的に「最新の」世代を進める（DOM ref ではないので誤検知）。
      // eslint-disable-next-line react-hooks/exhaustive-deps
      gen.current++
    }
    // 再読込条件はこの列挙が正。reload は毎レンダー再生成＝列挙すると毎レンダー再取得になるため抑止。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [loadKey, subAccountId, applied.from, applied.to, applied.q, conf])

  const confirm = (id: number) =>
    api
      .confirm(id)
      .then(() => {
        void reload()
        onChanged()
      })
      .catch((e) => setMsg(errMsg(e)))

  // 選択操作。「high をすべて選択」は例外ベースレビューの中核ショートカット。
  const toggle = (id: number) =>
    setSelected((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })
  const allSelected = drafts.length > 0 && drafts.every((d) => selected.has(d.id))
  const toggleAll = () => setSelected(allSelected ? new Set() : new Set(drafts.map((d) => d.id)))
  const highIds = drafts.filter((d) => d.origin.confidence === 'high').map((d) => d.id)

  /** 選択分を一括確定（部分成功あり）。失敗行はリストに残し、選択も残して再試行・精査しやすくする。 */
  const confirmSelected = async () => {
    const ids = drafts.filter((d) => selected.has(d.id)).map((d) => d.id) // 表示順で送る
    if (ids.length === 0 || busy) return
    setBusy(true)
    try {
      const r = await api.confirmBatch(ids)
      const failures = r.results.filter((x) => !x.ok)
      if (r.failed === 0) {
        setMsg(okMsg(`${r.confirmed}件を確定しました。`))
      } else {
        const head = failures
          .slice(0, 3)
          .map((f) => `#${f.id} ${f.error ?? '不明なエラー'}`)
          .join(' / ')
        const rest = failures.length > 3 ? `（他${failures.length - 3}件）` : ''
        setMsg(
          errMsg(
            `${r.confirmed}件確定・${r.failed}件失敗: ${head}${rest}。失敗した行はリストに残っています。`,
          ),
        )
      }
      setSelected(new Set(failures.map((f) => f.id)))
      await reload()
      onChanged()
    } catch (e) {
      setMsg(errMsg(e))
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <h4 style={{ marginBottom: 6 }}>
        確認待ち（draft）
        {drafts.length > 0 ? `：${drafts.length}件` : ''}
        {filtering ? '（絞り込み中）' : ''}
      </h4>
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 8px', fontSize: 13 }}>
        <span style={{ color: COLORS.sub }}>絞り込み:</span>
        <input type="date" value={from} onChange={(e) => setFrom(e.target.value)} title="期間（自）" />
        <span style={{ color: COLORS.muted }}>〜</span>
        <input type="date" value={to} onChange={(e) => setTo(e.target.value)} title="期間（至）" />
        <input placeholder="キーワード（摘要）" value={q} onChange={(e) => setQ(e.target.value)} />
        <select value={conf} onChange={(e) => setConf(e.target.value as ConfidenceFilter)}>
          <option value="">確信度: すべて</option>
          <option value="high">high のみ</option>
          <option value="medium">medium のみ</option>
          <option value="low">low のみ</option>
        </select>
        {filtering && (
          <button
            type="button"
            className="btn-link"
            onClick={() => {
              clear()
              setConf('')
            }}
          >
            クリア
          </button>
        )}
      </div>
      <Msg msg={msg} />
      {drafts.length === 0 ? (
        <p style={{ color: COLORS.muted }}>{filtering ? '条件に一致する draft はありません。' : emptyHint}</p>
      ) : (
        <>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center', margin: '0 0 6px' }}>
            <label style={{ display: 'flex', alignItems: 'center', gap: 4, color: COLORS.sub, fontSize: 13, cursor: 'pointer' }}>
              <input type="checkbox" checked={allSelected} onChange={toggleAll} />
              全選択
            </label>
            <button type="button" disabled={highIds.length === 0} onClick={() => setSelected(new Set(highIds))} className="btn">
              high をすべて選択（{highIds.length}件）
            </button>
            <button type="button" disabled={busy || selected.size === 0} onClick={confirmSelected} className="btn btn-ok" style={{ fontWeight: 600 }}>
              {busy ? '確定中…' : `選択を一括確定（${selected.size}件）`}
            </button>
            <span style={{ color: COLORS.muted, fontSize: 13 }}>
              high を一括確定し、残った medium/low だけ根拠を見て精査するのが近道です。
            </span>
          </div>
          {drafts.map((d) => (
            <DraftRow
              key={d.id}
              draft={d}
              accounts={accounts}
              taxCats={taxCats}
              fiscalYear={fiscalYear}
              showSource={subAccountId == null}
              selected={selected.has(d.id)}
              onToggle={() => toggle(d.id)}
              onConfirm={() => confirm(d.id)}
              onChanged={() => void reload()}
              onError={(e) => setMsg(errMsg(e))}
            />
          ))}
        </>
      )}
    </>
  )
}

/** 確信度バッジの配色（high=緑 / medium=黄 / low=赤。null＝手動/CSV等は非表示）。 */
const CONF_STYLE: Record<'high' | 'medium' | 'low', { label: string; color: string; bg: string; border: string }> = {
  high: { label: '高', color: COLORS.ok, bg: COLORS.okBg, border: COLORS.okBorder },
  medium: { label: '中', color: COLORS.warn, bg: COLORS.warnBg, border: COLORS.warnBorder },
  low: { label: '低', color: COLORS.error, bg: COLORS.errorBg, border: COLORS.errorBorder },
}

/**
 * AI 分類の確信度バッジ（confidence=null は何も出さない）。
 *
 * 「確信度: 」の前置きは全行で同じ＝行ごとに変わらないので出さない（[[web-app]]「一覧行の表記規則」）。
 * 色と一文字で区別できる。読み上げや初見のために、語としての意味は title に残す。
 */
function ConfidenceBadge({ origin }: { origin: DraftOrigin }) {
  if (!origin.confidence) return null
  const s = CONF_STYLE[origin.confidence]
  return (
    <span
      title={[`確信度: ${s.label}`, origin.evidence].filter(Boolean).join('\n')}
      style={{
        flexShrink: 0,
        fontSize: 11,
        fontWeight: 600,
        color: s.color,
        background: s.bg,
        border: `1px solid ${s.border}`,
        borderRadius: 8,
        padding: '1px 8px',
        whiteSpace: 'nowrap',
      }}
    >
      {s.label}
    </span>
  )
}

/**
 * 行の寸法（[[web-app]]「一覧行の折り返し」）。
 *
 * 主行は折り返さない＝可変なのは摘要だけで、他は固定幅か flexShrink:0 で確定させる。
 * SUB_INDENT は「チェックボックス＋gap＋日付＋gap」の実測合計で、従属行の開始位置を主行の摘要に
 * 揃えるためのもの。全行で同じ値なので、行ごとに折り返し位置が動く現象が起きない。
 */
const DATE_W = 46 // MM-DD（tabular-nums で全行同幅）
const AMOUNT_W = 92
const SUB_INDENT = 83

/**
 * draft 1件の確認・確定（相手科目＝line_no=2 を修正して確定）。
 *
 * 主行＝決めるための情報（日付・摘要・確信度・金額・科目・確定）。従属行＝精査するための情報
 * （分類の根拠・証跡・税区分・税額）。**従属行は常に出す**: 税区分は根拠が無い draft（手入力・CSV等）
 * でも触れる必要があり、出したり出さなかったりすると行ごとに位置が動いてしまうため
 * （[[web-app]]「一覧行の折り返し」）。
 */
function DraftRow({
  draft,
  accounts,
  taxCats,
  fiscalYear,
  showSource,
  selected,
  onToggle,
  onConfirm,
  onChanged,
  onError,
}: {
  draft: DraftView
  accounts: Account[]
  taxCats: TaxCategory[]
  fiscalYear: DateScope
  /** 相手科目を行に出すか（サービス横断の全件表示のみ true。サービス毎は見出しに既出）。 */
  showSource: boolean
  selected: boolean
  onToggle: () => void
  onConfirm: () => void
  onChanged: () => void
  /** 科目・税区分変更の失敗を親のメッセージ欄へ届ける（無反応で選択が戻るだけにしない）。 */
  onError: (e: unknown) => void
}) {
  // 相手科目＝line_no=2（journalize の相手側）。props 制御（変更→サーバ更新→reload で追随）。
  const counter = draft.lines.find((l) => l.lineNo === 2) ?? draft.lines[draft.lines.length - 1]
  const source = draft.lines.find((l) => l !== counter)

  // 科目変更は accountId のみ送信（税区分はサーバ側で新科目の既定に追随）。税区分変更は taxCategoryId のみ送信。
  // 失敗時は onError（catch が無いと reload されず、制御 select が元に戻るだけの無反応になる）。
  const changeAccount = (id: number) =>
    counter && api.setLine(counter.id, { accountId: id }).then(onChanged).catch(onError)
  const changeTax = (tcId: number) =>
    counter && api.setLine(counter.id, { taxCategoryId: tcId || null }).then(onChanged).catch(onError)

  // 相手行の通常方向（入金=貸方→売上系 / 出金=借方→仕入系）に合う税区分のみ提示（誤分類の防止）。
  const dir = counter?.side === 'credit' ? 'sale' : 'purchase'
  const taxOptions = taxCats.filter((t) => t.taxability !== 'taxable' || t.direction === dir)

  // 相手行が借方＝出金（資産が減る）、貸方＝入金。借/貸の語ではなく符号で示し、語は title に残す。
  const outgoing = counter?.side === 'debit'
  const accountName = accounts.find((a) => a.id === counter?.accountId)?.name
  const taxLabel = taxCats.find((t) => t.id === counter?.taxCategoryId)?.label ?? '（自動）'

  const { origin } = draft
  return (
    <div style={{ borderBottom: `1px solid ${COLORS.borderFaint}`, padding: '8px 0' }}>
      {/* 主行は折り返さない。可変なのは摘要だけで、他は固定幅・flexShrink:0 で確定させる。 */}
      <div style={{ display: 'flex', gap: 12, alignItems: 'center' }}>
        <input type="checkbox" checked={selected} onChange={onToggle} style={{ flexShrink: 0 }} />
        <span style={{ width: DATE_W, color: COLORS.sub, flexShrink: 0, whiteSpace: 'nowrap', fontVariantNumeric: 'tabular-nums' }}>
          {listDate(draft.entryDate, fiscalYear)}
        </span>
        <span
          title={draft.description ?? undefined}
          style={{ flex: 1, minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
        >
          {draft.description}
        </span>
        <ConfidenceBadge origin={origin} />
        <span
          title={outgoing ? '借方' : '貸方'}
          style={{ width: AMOUNT_W, flexShrink: 0, textAlign: 'right', color: COLORS.sub, fontVariantNumeric: 'tabular-nums' }}
        >
          {outgoing ? '−' : '+'}¥{counter?.amount.toLocaleString()}
        </span>
        <select
          value={counter?.accountId ?? 0}
          onChange={(e) => changeAccount(Number(e.target.value))}
          title={accountName}
          style={SELECT_FIXED}
        >
          {accounts.map((a) => (
            <option key={a.id} value={a.id}>{a.name}</option>
          ))}
        </select>
        <button onClick={onConfirm} className="btn btn-ok" style={{ flexShrink: 0 }}>確定</button>
      </div>
      {/* 従属行: 精査のための情報。開始位置は全行で同じ（SUB_INDENT）＝主行の摘要に揃う。 */}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', margin: `4px 0 0 ${SUB_INDENT}px`, fontSize: 13, color: COLORS.muted }}>
        <select
          value={counter?.taxCategoryId ?? 0}
          onChange={(e) => changeTax(Number(e.target.value))}
          title={`税区分: ${taxLabel}`}
          style={{ ...SELECT_FIXED, color: COLORS.sub, fontSize: 13 }}
        >
          <option value={0}>（自動）</option>
          {taxOptions.map((t) => (
            <option key={t.id} value={t.id}>{t.label}</option>
          ))}
        </select>
        <span style={{ width: 70, flexShrink: 0, textAlign: 'right', fontVariantNumeric: 'tabular-nums' }}>
          {counter?.taxAmount ? `税${counter.taxAmount.toLocaleString()}` : ''}
        </span>
        {origin.reason && (
          <span
            title={origin.evidence ?? undefined}
            style={{ minWidth: 0, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
          >
            根拠: {origin.reason}
            {origin.evidence && <span style={{ marginLeft: 8, color: COLORS.muted }}>証跡: {origin.evidence}</span>}
          </span>
        )}
        {/* 相手科目はサービス毎の一覧では見出しに既出＝全行同じなので出さない。
            全件（サービス横断）では行ごとに変わるので出す（[[web-app]]「一覧行の表記規則」）。 */}
        {showSource && (
          <span style={{ marginLeft: 'auto', flexShrink: 0, color: COLORS.muted }}>相手: {source?.accountName}</span>
        )}
      </div>
    </div>
  )
}
