/**
 * じぶんの帳簿モードの不変条件（アクティブちょうど1冊）が壊れているときの修復導線
 * （app-mode spec「じぶんの帳簿ではアクティブが常に1冊である」・design 参照）。
 *
 * 外からファイルを足した・バックアップから復元した等で2冊以上になった状態で、
 * `list[0]` を黙って選んで進むのは「気づかないうちにどれかの帳簿へ書き込む」そのもの。
 * どれを自分の帳簿として残すかを人に選ばせ、残りはアーカイブする（**削除はしない**）。
 */
import { COLORS, selectableRow } from '../lib/styles.js'
import { useState } from 'react'
import { api, type BookInfo } from '../api.js'

export function PersonalBookRepair({ books, onDone }: { books: BookInfo[]; onDone: () => void }) {
  const [keepId, setKeepId] = useState<string>(books[0]?.id ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const apply = async () => {
    setBusy(true)
    setError(null)
    try {
      for (const b of books) {
        if (b.id !== keepId) await api.archiveBook(b.id)
      }
      onDone()
    } catch (e) {
      setError((e as Error).message)
      setBusy(false)
    }
  }

  return (
    <main style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ color: COLORS.ok, margin: '0 0 4px' }}>Kanean</h1>
      <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>帳簿が{books.length}冊あります</h2>
      <p style={{ color: COLORS.sub, fontSize: 13, marginTop: 0, lineHeight: 1.7 }}>
        「じぶんの帳簿」モードでは帳簿を1冊だけ扱います。どれを使うか選んでください。
        <br />
        選ばなかった帳簿は<strong>アーカイブ</strong>されます（一覧から下がるだけで、データは削除されません。
        「各種設定 → 帳簿」からいつでも戻せます）。
      </p>
      {error && <p style={{ color: COLORS.error, fontSize: 13 }}>{error}</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: '20px 0 0' }}>
        {books.map((b) => (
          <li key={b.id} style={{ marginBottom: 8 }}>
            <label style={{ ...selectableRow(keepId === b.id), fontSize: 15 }}>
              <input type="radio" name="keep" checked={keepId === b.id} onChange={() => setKeepId(b.id)} />
              <span style={{ flex: 1 }}>{b.name}</span>
              {keepId === b.id && <span style={{ color: COLORS.ok, fontSize: 13, fontWeight: 600 }}>これを使う</span>}
            </label>
          </li>
        ))}
      </ul>

      <button
        onClick={apply}
        disabled={busy || !keepId}
        className="btn btn-ok" style={{ marginTop: 16, fontWeight: 600, padding: '8px 16px', cursor: busy ? 'default' : 'pointer' }}
      >
        {busy ? '処理中…' : `この帳簿を使う（他の${books.length - 1}冊をアーカイブ）`}
      </button>
    </main>
  )
}
