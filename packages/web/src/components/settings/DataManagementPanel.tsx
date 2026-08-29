import { useState } from 'react'
import {
  api,
  bookQuery,
  ApiError,
  type BookInfo,
  type ImportConflict,
  type ImportMode,
  type ImportBookResult,
} from '../../api.js'
import { COLORS, SECTION } from '../../lib/styles.js'

/**
 * データ管理: エクスポート（持ち出し）とその取り込み（復帰）。SettingsTab から分割（issue #153）。
 * この2つが揃って初めて「データの所有者はあなた」が成立する — 書き出せても戻せないなら、
 * エクスポートは保険になっていない（data-ops spec「フルデータエクスポート」）。
 */
export function DataManagementPanel({ onBooksChanged }: { onBooksChanged: (books: BookInfo[]) => void }) {
  return (
    <section>
      <h3 style={{ marginTop: 0 }}>データ管理</h3>
      <div style={SECTION}>
        <h4 style={{ marginTop: 0 }}>全データのエクスポート</h4>
        <p style={{ color: COLORS.sub, fontSize: 13, marginTop: 0 }}>
          会計データ（SQLite）と証憑ファイル一式を manifest 付き zip でそのままダウンロードします。
          バックアップ・他環境への移行にどうぞ。
        </p>
        <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 0 }}>
          このボタンが「データの所有者はあなた」の実装です。ロックインなし・いつでも全量を持ち出せます。
        </p>
        {/* fetch+blob だと zip 全体をメモリに載せてしまうため、<a href> のネイティブダウンロードで
            ストリーム受信する（ファイル名はサーバの Content-Disposition）。ネイティブ GET は
            X-BookInfo-Id ヘッダを載せられないので ?bookId= で対象帳簿を指定する（books spec）。 */}
        <a
          href={`/api/export${bookQuery()}`}
          download
          className="btn btn-ok" style={{ display: 'inline-block', fontWeight: 600, padding: '6px 14px', textDecoration: 'none' }}
        >
          全データをエクスポート（zip）
        </a>
      </div>
      <ImportPanel onBooksChanged={onBooksChanged} />
    </section>
  )
}

/**
 * エクスポート zip の取り込み。**別の環境から持ってきた帳簿を1冊増やす**操作であって、
 * いま開いている帳簿を巻き戻すものではない（restorable-export design.md §3）。
 * 帳簿IDが衝突したときは黙って倒さず、2つの扱いを提示して利用者に選ばせる（同 §5）。
 */
function ImportPanel({ onBooksChanged }: { onBooksChanged: (books: BookInfo[]) => void }) {
  const [file, setFile] = useState<File | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [conflict, setConflict] = useState<ImportConflict | null>(null)
  const [done, setDone] = useState<ImportBookResult | null>(null)

  const run = (mode?: ImportMode) => {
    if (!file) return
    setBusy(true)
    setError(null)
    setConflict(null)
    setDone(null)
    api
      .importBook(file, mode)
      .then((result) => {
        setDone(result)
        setFile(null)
        // 取り込みは帳簿を1冊増やす（または中身を差し替える）ので、帳簿一覧を取り直す。
        return api.books().then(onBooksChanged)
      })
      .catch((e: Error) => {
        if (e instanceof ApiError && e.code === 'book_id_conflict' && e.conflict) setConflict(e.conflict)
        else setError(e.message)
      })
      .finally(() => setBusy(false))
  }

  return (
    <div style={SECTION}>
      <h4 style={{ marginTop: 0 }}>エクスポートの取り込み</h4>
      <p style={{ color: COLORS.sub, fontSize: 13, marginTop: 0 }}>
        別の環境で書き出した zip を、この環境の帳簿として取り込みます。
        新しいマシンに移すとき・預けた帳簿を受け取るときに使います。
      </p>
      <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 0 }}>
        いま開いている帳簿は書き換わりません（取り込んだ帳簿が一覧に増えます）。
        <br />
        誤操作の巻き戻し（バックアップからの復元）は用途が別で、こことは違う操作です。
      </p>

      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <input
          type="file"
          accept=".zip,application/zip"
          disabled={busy}
          onChange={(e) => {
            setFile(e.target.files?.[0] ?? null)
            setError(null)
            setConflict(null)
            setDone(null)
          }}
        />
        <button
          onClick={() => run()}
          disabled={!file || busy}
          className="btn btn-ok" style={{ color: file && !busy ? COLORS.ok : COLORS.muted, fontWeight: 600, padding: '6px 14px', cursor: file && !busy ? 'pointer' : 'default' }}
        >
          {busy ? '取り込み中…' : '取り込む'}
        </button>
      </div>

      {conflict && (
        <div style={{ marginTop: 12, border: `1px solid ${COLORS.warnBorder}`, borderRadius: 6, padding: '10px 12px', background: COLORS.warnBg }}>
          <p style={{ margin: '0 0 6px', fontWeight: 600 }}>同じ帳簿IDがこの環境にもあります</p>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: COLORS.sub }}>
            取り込もうとしている帳簿「{conflict.incomingName}」は、既にある「{conflict.existingName}」と
            同じ帳簿です。どちらの扱いにするか選んでください。
          </p>
          <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
            <button onClick={() => run('new')} disabled={busy} className="btn btn-muted" style={CONFLICT_BTN}>
              別の帳簿として取り込む
            </button>
            <button onClick={() => run('replace')} disabled={busy} className="btn btn-danger" style={{ ...CONFLICT_BTN, color: COLORS.error }}>
              既存を置き換える
            </button>
            <button onClick={() => setConflict(null)} disabled={busy} className="btn btn-muted" style={CONFLICT_BTN}>
              やめる
            </button>
          </div>
          <p style={{ margin: '8px 0 0', fontSize: 13, color: COLORS.sub }}>
            「置き換える」を選んでも、置換前のデータはデータフォルダに退避されます（消えません）。
          </p>
        </div>
      )}

      {done && (
        <p style={{ marginTop: 12, color: COLORS.ok, fontSize: 13 }}>
          「{done.bookName}」を取り込みました
          {done.attachmentCount > 0 && `（証憑 ${done.attachmentCount} 件）`}。
          {done.outcome === 'new-id' && ' 既存と重ならないよう、新しい帳簿として追加しました。'}
          {done.outcome === 'replaced' && ` 置換前のデータは ${done.preImportDir ?? ''} に退避しました。`}
          {' 帳簿の切替から開けます。'}
        </p>
      )}
      {error && <p style={{ marginTop: 12, color: COLORS.error, fontSize: 13 }}>{error}</p>}
    </div>
  )
}

const CONFLICT_BTN: React.CSSProperties = { color: 'inherit', padding: '5px 12px' }
