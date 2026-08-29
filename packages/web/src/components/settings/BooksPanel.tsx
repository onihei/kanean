import { useEffect, useState } from 'react'
import { api, type AppMode, type BookInfo } from '../../api.js'
import { COLORS, SECTION } from '../../lib/styles.js'

/**
 * 帳簿の管理（books spec）。SettingsTab から分割（issue #153）。
 * 作成・改名・アーカイブ・復帰。**削除は提供しない**
 * （不可逆で、消えるのは税務データ。必要ならファイルを手で消す）。
 * アーカイブは control plane の状態変更だけで、データファイルは残る＝いつでも戻せる。
 */
export function BooksPanel({ mode, onChanged }: { mode: AppMode; onChanged: (books: BookInfo[]) => void }) {
  const [all, setAll] = useState<BookInfo[] | null>(null)
  const [newName, setNewName] = useState('')
  const [editing, setEditing] = useState<{ id: string; name: string } | null>(null)
  const [confirming, setConfirming] = useState<BookInfo | null>(null)
  const [error, setError] = useState<string | null>(null)

  // アーカイブ済みも含めて1回で取り、アクティブ分だけ App へ返す（App はアクティブしか扱わない）。
  const reload = () =>
    api.books(true).then((list) => {
      setAll(list)
      onChanged(list.filter((b) => b.archivedAt == null))
    })
  useEffect(() => {
    reload().catch((e: Error) => setError(e.message))
    // 初回読込のみ。reload は親コールバック onChanged（毎レンダー再生成）を閉じ込むため列挙しない。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /**
   * 操作 → 一覧再読込 → エラー表示クリア。**成功したかを返す**。
   * catch で終わるため戻りは常に fulfilled — 後始末（編集欄を閉じる・入力をクリアする等）を
   * 無条件の .then で繋ぐと、失敗時にも走って「失敗が成功に見える」（issue #154）。
   */
  const run = (p: Promise<unknown>): Promise<boolean> =>
    p
      .then(reload)
      .then(() => {
        setError(null)
        return true
      })
      .catch((e: Error) => {
        setError(e.message)
        return false
      })

  if (all === null) return <section style={SECTION}>…</section>
  const active = all.filter((b) => b.archivedAt == null)
  const archived = all.filter((b) => b.archivedAt != null)

  return (
    <section style={SECTION}>
      <h3 style={{ margin: '0 0 8px' }}>帳簿</h3>
      <p style={{ color: COLORS.muted, fontSize: 13, marginTop: 0 }}>
        1つの帳簿＝1つの会計データファイルです。
        {mode === 'office'
          ? '複数持てます（顧問先ごと 等）。'
          : '「じぶんの帳簿」モードでは1冊だけ扱います（作成は事務所モードで）。'}
        削除はできません。使わなくなった帳簿は<strong>アーカイブ</strong>で一覧から下げられます
        （データは残り、いつでも戻せます）。
      </p>
      {error && <p style={{ color: COLORS.error, fontSize: 13 }}>{error}</p>}

      <ul style={{ listStyle: 'none', padding: 0, margin: '0 0 16px' }}>
        {active.map((b) => (
          <li key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0' }}>
            {editing?.id === b.id ? (
              <>
                <input
                  value={editing.name}
                  onChange={(e) => setEditing({ id: b.id, name: e.target.value })}
                  style={{ flex: 1, maxWidth: 280 }}
                />
                <button
                  onClick={() => run(api.renameBook(b.id, editing.name)).then((ok) => ok && setEditing(null))}
                  disabled={!editing.name.trim()}
                  className="btn btn-ok"
                >
                  保存
                </button>
                <button onClick={() => setEditing(null)} className="btn">取消</button>
              </>
            ) : (
              <>
                <span style={{ flex: 1, maxWidth: 280 }}>{b.name}</span>
                <button onClick={() => setEditing({ id: b.id, name: b.name })} className="btn">名前を変更</button>
                {/* 最後の1冊はアーカイブできない（開ける帳簿が無くなる）。サーバも 409 で拒否する。 */}
                <button onClick={() => setConfirming(b)} disabled={active.length <= 1} className="btn btn-danger">
                  アーカイブ
                </button>
              </>
            )}
          </li>
        ))}
      </ul>

      {confirming && (
        <div style={{ border: `1px solid ${COLORS.warnBorder}`, background: COLORS.warnBg, borderRadius: 6, padding: '10px 12px', marginBottom: 16 }}>
          <p style={{ margin: '0 0 8px', fontSize: 13, color: COLORS.warn }}>
            「{confirming.name}」をアーカイブします。<strong>データは削除されません</strong>
            （一覧から下がるだけで、データファイルはそのまま残ります）。このパネルからいつでも戻せます。
          </p>
          <button onClick={() => run(api.archiveBook(confirming.id)).then((ok) => ok && setConfirming(null))} className="btn btn-danger">
            アーカイブする
          </button>
          <button onClick={() => setConfirming(null)} className="btn" style={{ marginLeft: 8 }}>
            取消
          </button>
        </div>
      )}

      {archived.length > 0 && (
        <div style={{ marginBottom: 16 }}>
          <h4 style={{ margin: '0 0 4px', fontSize: 13, color: COLORS.muted }}>アーカイブ済み（{archived.length}）</h4>
          <ul style={{ listStyle: 'none', padding: 0, margin: 0 }}>
            {archived.map((b) => (
              <li key={b.id} style={{ display: 'flex', gap: 8, alignItems: 'center', padding: '4px 0', color: COLORS.muted }}>
                <span style={{ flex: 1, maxWidth: 280 }}>{b.name}</span>
                {mode === 'office' ? (
                  <button onClick={() => run(api.unarchiveBook(b.id))} className="btn">戻す</button>
                ) : (
                  <span style={{ fontSize: 13 }}>戻すには「事務所」モードへ切り替えてください</span>
                )}
              </li>
            ))}
          </ul>
        </div>
      )}

      {/* じぶんの帳簿モードではアクティブ1冊が不変条件なので、作成の導線を出さない。 */}
      {mode === 'office' && (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <input
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            placeholder="新しい帳簿の名前"
            style={{ maxWidth: 280 }}
          />
          <button
            onClick={() => run(api.createBook(newName.trim())).then((ok) => ok && setNewName(''))}
            disabled={!newName.trim()}
            className="btn btn-ok"
          >
            帳簿を追加
          </button>
        </div>
      )}
    </section>
  )
}
