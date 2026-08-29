/**
 * 帳簿（顧問先）選択画面（web-app spec「帳簿選択画面」）。事務所モードの起点。
 *
 * **前回の帳簿を自動では開かない**のがこの画面の本体。黙って開いていると、別の顧問先の帳簿に
 * 気づかず仕訳を打つ事故が起きる。前回分はハイライトするに留め、選択の操作を必ず経る。
 * 帳簿が1冊しかなくてもこの画面を出す（「必ず選んでから触る」規律を崩さない）。
 */
import { COLORS, selectableRow } from '../lib/styles.js'
import { useState } from 'react'
import { api, type BookInfo } from '../api.js'

export function BookPicker({
  books,
  lastOpenedId,
  onSelect,
  onCreated,
  onCancel,
}: {
  /** アクティブな帳簿のみ。 */
  books: BookInfo[]
  /** 前回開いた帳簿（ハイライトのみ。自動では開かない）。 */
  lastOpenedId: string | null
  onSelect: (id: string) => void
  onCreated: (books: BookInfo[], created: BookInfo) => void
  /** 業務画面から開いたとき（帳簿の切替）だけ「戻る」を出す。起動直後は戻り先が無いので null。 */
  onCancel?: () => void
}) {
  const [newName, setNewName] = useState('')
  const [adding, setAdding] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const create = () => {
    setError(null)
    api
      .createBook(newName.trim())
      .then((created) => api.books().then((list) => onCreated(list, created)))
      .then(() => {
        setNewName('')
        setAdding(false)
      })
      .catch((e: Error) => setError(e.message))
  }

  return (
    <main style={{ padding: 32, maxWidth: 720, margin: '0 auto' }}>
      <h1 style={{ color: COLORS.ok, margin: '0 0 4px' }}>Kanean</h1>
      <h2 style={{ margin: '0 0 4px', fontSize: 20 }}>どの帳簿を開きますか？</h2>
      <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 0 }}>
        選んだ帳簿だけが以降のすべての操作の対象になります。
      </p>
      {error && <p style={{ color: COLORS.error, fontSize: 13 }}>{error}</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: '20px 0 0' }}>
        {books.map((b) => {
          const last = b.id === lastOpenedId
          return (
            <li key={b.id} style={{ marginBottom: 8 }}>
              <button
                onClick={() => onSelect(b.id)}
                style={{ ...selectableRow(last), fontSize: 15, fontWeight: last ? 600 : 400, color: COLORS.text }}
              >
                <span style={{ flex: 1 }}>{b.name}</span>
                {last && <span style={{ color: COLORS.ok, fontSize: 13, fontWeight: 600 }}>前回開いた帳簿</span>}
              </button>
            </li>
          )
        })}
      </ul>

      <div style={{ marginTop: 20, display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        {adding ? (
          <>
            <input
              value={newName}
              onChange={(e) => setNewName(e.target.value)}
              placeholder="新しい帳簿の名前（顧問先名など）"
              style={{ maxWidth: 280, flex: 1 }}
              autoFocus
            />
            <button onClick={create} disabled={!newName.trim()} className="btn btn-ok">
              作成
            </button>
            <button onClick={() => setAdding(false)} className="btn">取消</button>
          </>
        ) : (
          <button onClick={() => setAdding(true)} className="btn">帳簿を追加</button>
        )}
        {onCancel && <button onClick={onCancel} className="btn">戻る</button>}
      </div>
    </main>
  )
}
