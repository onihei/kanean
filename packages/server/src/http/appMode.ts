import { Hono } from 'hono'
import { z } from 'zod'
import type { DbRouter } from '../db/router.js'
import { getAppMode, setAppMode, APP_MODES } from '../appMode/appMode.js'
import { listBooks } from '../books/resolve.js'

/**
 * アプリモードの取得・変更（app-mode spec）。
 * `withBook` の**外側**に置く＝モードの取得に帳簿の指定を要求しない
 * （起動シーケンスの最初に呼ばれ、その時点ではまだ対象帳簿が決まっていない）。
 */

const modeSchema = z.object({ mode: z.enum(APP_MODES) })

export function appModeRoutes(router: DbRouter): Hono {
  const app = new Hono()

  // 未設定は mode:null で返す（「選んでいない」を呼び出し側が区別できるようにする）。
  app.get('/app-mode', (c) => c.json({ mode: getAppMode(router) }))

  app.put('/app-mode', async (c) => {
    const parsed = modeSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) {
      return c.json({ error: { code: 'validation_error', message: `mode は ${APP_MODES.join(' / ')} のいずれか` } }, 400)
    }
    const next = parsed.data.mode

    // personal の不変条件＝アクティブちょうど1冊。2冊以上のまま切り替えると「どれが自分の帳簿か」が
    // 決まらないので拒否し、帳簿をアーカイブして1冊にしてもらう（データは消さない。design 参照）。
    const active = listBooks(router)
    if (next === 'personal' && active.length > 1) {
      return c.json(
        {
          error: {
            code: 'books_not_single',
            message: `アクティブな帳簿が${active.length}冊あります。1冊だけ残して他をアーカイブしてから「じぶんの帳簿」へ切り替えてください（データは削除されません）`,
          },
          books: active.map((b) => ({ id: b.id, name: b.name })),
        },
        409,
      )
    }

    setAppMode(router, next)
    return c.json({ mode: next })
  })

  return app
}
