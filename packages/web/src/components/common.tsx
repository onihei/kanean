/** 画面横断の小コンポーネント（科目リンク・注意書き・CSVボタン・セグメントタブ・確認ダイアログ・メッセージ）。 */
import { useCallback, useEffect, useRef, useState } from 'react'
import { api } from '../api.js'
import { COLORS, WARN_BANNER } from '../lib/styles.js'
import { formatHash, useHashRoute, type Route } from '../nav/route.js'

/**
 * 科目名 → 総勘定元帳の実アンカー（`#<現在タブ>/ledger/<id>`・issue #135）。
 * 現在タブはルートから自分で読む＝呼び出し側の中継プロップは不要。タブセグメントを保持するのは
 * 元帳が「開いた帳票タブに重なる」オーバーレイだから（nav/route.ts）。
 * 実アンカーなので中クリック・新規ウィンドウで開ける（desktop は自スキームの窓を許可済み）。
 */
export function AccountLink({ id, name }: { id: number; name: string }) {
  const { tab } = useHashRoute()
  return (
    <a href={formatHash({ tab, ledgerAccountId: id })} style={{ color: COLORS.accent, textDecoration: 'none' }}>
      {name}
    </a>
  )
}

/** 「← 戻る」の実アンカー（issue #248。onBack 中継を撤去し、中クリック・履歴と自然に整合）。 */
export function BackLink({ to }: { to: Route }) {
  return (
    <a href={formatHash(to)} className="btn-link" style={{ padding: 0, textDecoration: 'none', display: 'inline-block' }}>
      ← 戻る
    </a>
  )
}

export function NoYear() {
  return <p style={{ color: COLORS.muted }}>会計年度がありません。CSVを取り込むと自動で当年度が作成されます。</p>
}

/** legalRisk:high の帳票・決算整理に出す注意書き（税理士サインオフ前は提出不可）。 */
export function TaxAdvisorBanner({ note }: { note?: string }) {
  return (
    <p style={{ ...WARN_BANNER, margin: '0 0 12px' }}>
      ⚠ 確定申告前・税理士確認前の参考値です（提出可能を意味しません）。{note ? ` ${note}` : ''}
    </p>
  )
}

/** 帳票の CSV ダウンロードボタン（RFC4180・UTF-8 BOM）。 */
export function CsvButton({ path, filename, label = 'CSV出力' }: { path: string; filename: string; label?: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const [warn, setWarn] = useState('')
  const dl = async () => {
    setBusy(true)
    setErr('')
    setWarn('')
    try {
      const w = await api.downloadCsv(path, filename)
      if (w) setWarn(w)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <span style={{ marginLeft: 12, fontWeight: 400, fontSize: 13 }}>
      <button disabled={busy} onClick={dl} className="btn btn-ok">
        {busy ? '出力中…' : label}
      </button>
      {err && <span style={{ color: COLORS.error, marginLeft: 6 }}>{err}</span>}
      {warn && <span style={{ color: COLORS.warn, marginLeft: 6 }}>{warn}</span>}
    </span>
  )
}

export function PdfButton({ path, filename, label = 'PDF出力' }: { path: string; filename: string; label?: string }) {
  const [busy, setBusy] = useState(false)
  const [err, setErr] = useState('')
  const dl = async () => {
    setBusy(true)
    setErr('')
    try {
      // downloadCsv は拡張子非依存の汎用 Blob ダウンロード（PDF も同経路）。
      await api.downloadCsv(path, filename)
    } catch (e) {
      setErr(String(e))
    } finally {
      setBusy(false)
    }
  }
  return (
    <span style={{ marginLeft: 12, fontWeight: 400, fontSize: 13 }}>
      <button disabled={busy} onClick={dl} className="btn btn-accent">
        {busy ? '出力中…' : label}
      </button>
      {err && <span style={{ color: COLORS.error, marginLeft: 6 }}>{err}</span>}
    </span>
  )
}

export function SegTabs<T extends string>({ value, onChange, options }: { value: T; onChange: (v: T) => void; options: { value: T; label: string }[] }) {
  return (
    <section style={{ display: 'flex', gap: 4, marginBottom: 8 }}>
      {options.map((o) => (
        <button key={o.value} onClick={() => onChange(o.value)} className={value === o.value ? 'seg-tab active' : 'seg-tab'}>{o.label}</button>
      ))}
    </section>
  )
}

/**
 * 上ラベル付きフィールド（issue #277。事業者設定と同型の「上ラベル＋入力」）。
 * label が入力を**包む**ため htmlFor 無しでクリック・支援技術の紐付けが効く。
 * placeholder は項目名でなく入力例に使う（値を入れた後も項目名が見えることが目的）。
 */
export function Field({ label, style, children }: { label: React.ReactNode; style?: React.CSSProperties; children: React.ReactNode }) {
  return (
    <label style={{ display: 'flex', flexDirection: 'column', gap: 4, color: COLORS.sub, fontSize: 13, ...style }}>
      {label}
      {children}
    </label>
  )
}

/** 確認の結果。note は noteLabel を渡したときだけ意味を持つ（空入力は null）。 */
export type ConfirmResult = { ok: boolean; note: string | null }

/** useConfirm の1回分の要求（メッセージ・実行ボタン文言・任意メモ欄・Promise の解決関数）。 */
type ConfirmRequest = { message: string; okLabel: string; noteLabel?: string; resolve: (r: ConfirmResult) => void }

/**
 * 破壊的操作の確認ダイアログ（issue #280。window.confirm / window.prompt の置換）。
 * ネイティブ <dialog>.showModal() を使う＝フォーカストラップと Esc は仕様で付いてくる。
 * 初期フォーカスは実行でなく**キャンセル**（Enter 連打で破壊操作が走らないように）。
 */
function ConfirmDialog({ req }: { req: ConfirmRequest }) {
  const ref = useRef<HTMLDialogElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const [note, setNote] = useState('')
  const done = useRef(false)
  const finish = (ok: boolean) => {
    if (done.current) return
    done.current = true
    req.resolve({ ok, note: note.trim() || null })
  }
  useEffect(() => {
    ref.current?.showModal()
    cancelRef.current?.focus()
  }, [])
  return (
    // onClose は Esc・close() の両方で発火する。ボタン経由なら done 済みなので二重解決しない。
    <dialog ref={ref} className="confirm" onClose={() => finish(false)}>
      <div style={{ whiteSpace: 'pre-wrap', lineHeight: 1.6 }}>{req.message}</div>
      {req.noteLabel != null && (
        <Field label={req.noteLabel} style={{ marginTop: 12 }}>
          <input value={note} onChange={(e) => setNote(e.target.value)} />
        </Field>
      )}
      <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', marginTop: 16 }}>
        <button ref={cancelRef} className="btn" onClick={() => finish(false)}>
          キャンセル
        </button>
        <button className="btn btn-danger" onClick={() => finish(true)}>
          {req.okLabel}
        </button>
      </div>
    </dialog>
  )
}

/**
 * 確認ダイアログのフック。`const [confirmDialog, ask] = useConfirm()` して
 * confirmDialog を JSX に置き、`if (!(await ask('…しますか？'))) return` で使う。
 * 理由等の任意メモも取るときは `askWithNote(message, noteLabel)` → `{ ok, note }`。
 */
export function useConfirm(): [
  React.ReactNode,
  (message: string, okLabel?: string) => Promise<boolean>,
  (message: string, noteLabel: string, okLabel?: string) => Promise<ConfirmResult>,
] {
  const [req, setReq] = useState<ConfirmRequest | null>(null)
  const open = useCallback(
    (r: Omit<ConfirmRequest, 'resolve'>) =>
      new Promise<ConfirmResult>((resolve) => {
        setReq({ ...r, resolve: (result) => (setReq(null), resolve(result)) })
      }),
    [],
  )
  const ask = useCallback(
    (message: string, okLabel = '削除する') => open({ message, okLabel }).then((r) => r.ok),
    [open],
  )
  const askWithNote = useCallback(
    (message: string, noteLabel: string, okLabel = '削除する') => open({ message, okLabel, noteLabel }),
    [open],
  )
  // key で毎回マウントし直す＝done/showModal/メモ入力の状態を持ち越さない。
  return [req && <ConfirmDialog key={req.message} req={req} />, ask, askWithNote]
}

/** 操作結果メッセージの状態（kind で赤/緑を決める。null は非表示）。 */
export type MsgState = { kind: 'ok' | 'error'; text: string } | null

/** 成功メッセージ（緑）。 */
export const okMsg = (text: string): MsgState => ({ kind: 'ok', text })

/** エラーメッセージ（赤）。Error は message のみ表示。prefix があれば「prefix: 」を前置。 */
export const errMsg = (e: unknown, prefix?: string): MsgState => {
  const text = e instanceof Error ? e.message : String(e)
  return { kind: 'error', text: prefix ? `${prefix}: ${text}` : text }
}

/** 操作結果メッセージ（エラーは赤・成功は緑）。 */
export function Msg({ msg }: { msg: MsgState }) {
  if (!msg) return null
  return <p style={{ color: msg.kind === 'error' ? COLORS.error : COLORS.ok }}>{msg.text}</p>
}
