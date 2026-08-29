import type { OpeningBalancesResponse } from '@kanean/shared'
import { Hono } from 'hono'
import type { DbRouter } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import {
  listProrationSettings,
  upsertProrationSetting,
  deleteProrationSetting,
  postProration,
  type UpsertProrationInput,
} from '../../proration/proration.js'
import {
  listOpeningBalances,
  listBalanceSheetAccounts,
  listBalanceSheetSubAccounts,
  openingBalanceTotals,
  upsertOpeningBalance,
  deleteOpeningBalance,
  type UpsertOpeningBalanceInput,
} from '../../closing/openingBalances.js'
import { previewCapitalTransfer } from '../../closing/capitalTransfer.js'
import { executeRollover, reopenFiscalYear, rolloverPrecheck } from '../../closing/rollover.js'
import { bookHelpers, intParam } from '../helpers.js'

/**
 * 決算整理ルート（家事按分・開始残高・元入金振替・年度繰越）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 */
export function closingRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf, withOpenYearOrNull, requireOpenYear } = bookHelpers(router)

  // 家事按分設定。
  app.get('/proration-settings', (c) => {
    const settings = withOpenYearOrNull(c, (db, fyId) => listProrationSettings(db, fyId))
    return c.json({ settings: settings ?? [] })
  })
  app.post('/proration-settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Omit<UpsertProrationInput, 'fiscalYearId'> | null
    if (!body?.accountId) return c.json({ error: 'accountId が必要' }, 400)
    const { db, fyId } = requireOpenYear(c)
    return c.json({ id: upsertProrationSetting(db, { ...body, fiscalYearId: fyId }) })
  })
  app.delete('/proration-settings/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    deleteProrationSetting(dbOf(c), id)
    return c.json({ ok: true })
  })
  app.post('/proration/post', (c) => {
    const { db, fyId } = requireOpenYear(c)
    return c.json({ result: postProration(db, fyId) })
  })

  // --- 決算整理（開始残高・元入金振替。roadmap Phase4・accounting-spec §1.3） ----
  // 開始残高（青色決算書4ページ目 貸借の期首列を実値で駆動）。
  app.get('/opening-balances', (c) => {
    const balances = withOpenYearOrNull(c, (db, fyId) => listOpeningBalances(db, fyId)) ?? []
    return c.json({
      balances,
      accounts: listBalanceSheetAccounts(dbOf(c)),
      subAccounts: listBalanceSheetSubAccounts(dbOf(c)),
      totals: openingBalanceTotals(balances),
    } satisfies OpeningBalancesResponse)
  })
  app.post('/opening-balances', async (c) => {
    const body = (await c.req.json().catch(() => null)) as Omit<UpsertOpeningBalanceInput, 'fiscalYearId'> | null
    if (!body?.accountId) return c.json({ error: 'accountId が必要' }, 400)
    const { db, fyId } = requireOpenYear(c)
    return c.json({ id: upsertOpeningBalance(db, { ...body, fiscalYearId: fyId }) })
  })
  app.delete('/opening-balances/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    deleteOpeningBalance(dbOf(c), id)
    return c.json({ ok: true })
  })
  // 元入金振替プレビュー（計算のみ・起票しない。legalRisk:high＝税理士サインオフ前）。
  app.get('/closing/capital-transfer/preview', (c) => {
    const { db, fyId } = requireOpenYear(c)
    return c.json({ preview: previewCapitalTransfer(db, fyId) })
  })
  // 繰越前の警告（read-only）。当期に未処理のまま残る取込明細の件数。繰越はブロックしない。
  app.get('/closing/rollover/precheck', (c) => {
    const { db, fyId } = requireOpenYear(c)
    return c.json(rolloverPrecheck(db, fyId))
  })
  // 年度繰越（当期を closed にし翌期を作成・繰越。legalRisk:high＝明示確認 {confirm:true} 必須）。
  app.post('/closing/rollover', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { confirm?: boolean } | null
    if (body?.confirm !== true) return c.json({ error: 'confirm:true が必要（年度繰越は確定操作）' }, 400)
    const { db, fyId } = requireOpenYear(c)
    return c.json({ result: executeRollover(db, fyId) })
  })
  // 年度繰越の取消（翌期が仕訳ゼロ件のときのみ）。
  app.post('/closing/reopen/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    reopenFiscalYear(dbOf(c), id)
    return c.json({ ok: true })
  })

  return app
}
