import type { MiddlewareHandler } from 'hono'
import type { DbRouter } from '../db/router.js'
import { listBooks, findBook } from './resolve.js'

export const BOOK_HEADER = 'X-Book-Id'

export interface BookVariables {
  bookId: string
}

/** data plane を書き換えうるメソッド。アーカイブ済み帳簿に対しては拒否する。 */
const MUTATING = new Set(['POST', 'PUT', 'PATCH', 'DELETE'])

/**
 * 対象帳簿を解決して `c.set('bookId')` する（books spec「対象帳簿の解決」・design D1）。
 * 認証は行わない。アクセス制御は 127.0.0.1 限定バインド（index.ts）が担う。
 *
 * 解決順:
 *   1. `X-Book-Id` ヘッダ         … 通常の API 呼び出し
 *   2. `?bookId=` クエリ          … ブラウザネイティブの GET（エクスポート zip・証憑ダウンロード）
 *   3. アクティブが1冊だけならその帳簿 … 単一帳簿運用・curl・既存の取込スキルが無改造で動く
 *   4. どれでも定まらなければ 400  … どの帳簿か推測しない（「黙って落とさない」）
 *
 * 暗黙解決（3）と 400 の候補（4）は**アクティブな帳簿だけ**を数える。アーカイブ済みは選択候補ではない
 * ＝1冊に整理したのに 400 が返り続ける、という不合理を避ける（アーカイブ0件なら従来と同一挙動）。
 *
 * 指定された id が存在しなければ 404。アーカイブ済みを明示指定した場合、参照系は通し、
 * 更新系は 409 で拒否する（**この1箇所に集約**する。ルートごとに書くと必ず漏れ、
 * 漏れた1本が「アーカイブしたはずの帳簿が書き換わる」を生む）。
 */
export function withBook(router: DbRouter): MiddlewareHandler<{ Variables: BookVariables }> {
  return async (c, next) => {
    const requested = c.req.header(BOOK_HEADER) ?? c.req.query('bookId')
    const active = listBooks(router)

    if (requested) {
      const book = findBook(router, requested)
      if (!book) {
        return c.json({ error: { code: 'book_not_found', message: '指定された帳簿が存在しません' } }, 404)
      }
      if (book.archivedAt != null && MUTATING.has(c.req.method)) {
        return c.json(
          {
            error: {
              code: 'book_archived',
              message: `帳簿「${book.name}」はアーカイブ済みです。変更するには復帰してください（参照は可能です）`,
            },
          },
          409,
        )
      }
      c.set('bookId', requested)
      await next()
      return
    }

    if (active.length === 1) {
      c.set('bookId', active[0].id)
      await next()
      return
    }

    // 0冊は起動時の ensureAtLeastOneBook で起きない想定だが、握りつぶさず同じ形で返す。
    return c.json(
      {
        error: {
          code: 'book_required',
          message: `帳簿が${active.length}冊あります。${BOOK_HEADER} ヘッダまたは ?bookId= で対象を指定してください`,
        },
        books: active.map((b) => ({ id: b.id, name: b.name })),
      },
      400,
    )
  }
}
