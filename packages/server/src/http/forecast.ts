import { Hono } from 'hono'
import { type Yen, yen } from '@kanean/shared'
import type { DbRouter, DataDb } from '../db/router.js'
import type { BookVariables } from '../books/middleware.js'
import { getOpenFiscalYear } from '../db/lookups.js'
import { buildTaxForecast } from '../taxreturn/forecast.js'

/**
 * 納税予測・期中 what-if シミュレーション API（本システムの差別化機能）。
 * /api 配下にマウントされる想定（認証は無い。対象帳簿はマウント側の withBook が解決し、
 * ec.ts と違い本ルータ自身はミドルウェアを持たない）。エラー形式は /api 系と同じ
 * flat な { error: string } の 400。
 */

// 円整数の安全上限（ec.ts と同じ天井。これを超える額は domain 層に渡さず 400 で弾く）。
const YEN_MAX = 999_999_999_999

/**
 * 非負円整数クエリの解釈。未指定・空文字（?extraExpense= の形）は undefined＝what-if なし、
 * 不正（非数字・小数・指数表記・負・上限超）は null＝400。Number('') が 0 に化ける黙変換を
 * 防ぐため、数字のみの形を先に検査する。
 */
function yenQuery(raw: string | undefined): Yen | null | undefined {
  if (raw == null || raw === '') return undefined
  if (!/^\d+$/.test(raw)) return null
  const n = Number(raw)
  if (!Number.isSafeInteger(n) || n > YEN_MAX) return null
  return yen(n)
}

export function forecastRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const dbOf = (c: { get: (k: 'bookId') => string }) => router.bookDb(c.get('bookId'))
  const openYear = (db: DataDb) => getOpenFiscalYear(db)

  // 年間税負担の予測（open 年度・confirmed 集計）。?extraExpense=&extraDeduction= で what-if。
  // open 年度なしは他の参照系（/reports/pl 等の withOpenYear）と同じ 200 + null 契約
  // （オンボーディング前の正常状態であり、ダッシュボードがエラー扱いしないため）。
  app.get('/tax-forecast', (c) => {
    const db = dbOf(c)
    const fy = openYear(db)
    if (!fy) return c.json({ forecast: null })

    const extraExpense = yenQuery(c.req.query('extraExpense'))
    const extraDeduction = yenQuery(c.req.query('extraDeduction'))
    if (extraExpense === null || extraDeduction === null) {
      return c.json({ error: 'extraExpense / extraDeduction は0以上の整数（円）で指定してください' }, 400)
    }

    try {
      return c.json({ forecast: buildTaxForecast(db, fy.id, { extraExpense, extraDeduction }) })
    } catch (err) {
      return c.json({ error: (err as Error).message }, 400)
    }
  })

  return app
}
