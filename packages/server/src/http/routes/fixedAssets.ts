import { Hono } from 'hono'
import type { DbRouter } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import { usedAssetUsefulLife } from '@kanean/core'
import { listFixedAssets, fixedAssetSchedule, createFixedAsset, type CreateFixedAssetInput } from '../../fixedAssets/register.js'
import { postDepreciation } from '../../fixedAssets/posting.js'
import { retireFixedAsset, sellFixedAsset } from '../../fixedAssets/retirement.js'
import { bookHelpers, intParam } from '../helpers.js'

/**
 * 固定資産ルート（台帳・登録・償却起票・除却・売却）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 */
export function fixedAssetsRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf, requireOpenYear } = bookHelpers(router)

  // 固定資産台帳（定額法・open 年度の暦年で償却を算定）。
  app.get('/fixed-assets', (c) => c.json({ assets: listFixedAssets(dbOf(c)) }))
  // 中古資産の簡便法による見積耐用年数（depreciation-spec §3.1・耐用年数省令§3）。
  app.get('/fixed-assets/used-useful-life', (c) => {
    const usefulLife = usedAssetUsefulLife(Number(c.req.query('legalYears')), Number(c.req.query('elapsedMonths')))
    return c.json({ usefulLife })
  })
  app.get('/fixed-assets/:id/schedule', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    return c.json({ schedule: fixedAssetSchedule(dbOf(c), id) })
  })
  app.post('/fixed-assets', async (c) => {
    const body = (await c.req.json().catch(() => null)) as CreateFixedAssetInput | null
    if (!body) return c.json({ error: 'JSON body が必要' }, 400)
    const id = createFixedAsset(dbOf(c), body)
    return c.json({ id }, 201)
  })

  // 当 open 年度の減価償却を仕訳起票（洗い替え）。
  app.post('/fixed-assets/post-depreciation', (c) => {
    const { db, fyId } = requireOpenYear(c)
    return c.json({ result: postDepreciation(db, fyId) })
  })
  // 固定資産の除却（除却損を起票し status=retired・depreciation-spec §7）。
  app.post('/fixed-assets/:id/retire', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as { retiredDate?: string } | null
    if (!body?.retiredDate) return c.json({ error: 'retiredDate が必要' }, 400)
    const { db, fyId } = requireOpenYear(c)
    return c.json({ result: retireFixedAsset(db, fyId, id, body.retiredDate as string) })
  })
  // 固定資産の売却（未償却残高を事業主貸へ振替・status=sold。譲渡所得は手計算＝スコープ外・§7）。
  app.post('/fixed-assets/:id/sell', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as { soldDate?: string } | null
    if (!body?.soldDate) return c.json({ error: 'soldDate が必要' }, 400)
    const { db, fyId } = requireOpenYear(c)
    return c.json({ result: sellFixedAsset(db, fyId, id, body.soldDate as string) })
  })

  return app
}
