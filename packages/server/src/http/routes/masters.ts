import type { Account, TaxCategory, FiscalYearView } from '@kanean/shared'
import { Hono } from 'hono'
import { asc, eq } from 'drizzle-orm'
import type { DbRouter, DataDb } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import { fiscalYears, accounts, taxCategories, statementItems, accountCategories } from '../../db/data/schema.js'
import { suggestInitialFiscalYear, createInitialFiscalYear } from '../../fiscalYear/setup.js'
import { SERVICE_CATALOG } from '../../services/catalog.js'
import { registerService, listServices } from '../../masters/services.js'
import {
  listCounterparties,
  createCounterparty,
  updateCounterparty,
  setCounterpartyActive,
  type CounterpartyInput,
} from '../../masters/counterparties.js'
import {
  listSubAccounts,
  createSubAccount,
  getOrCreateCounterpartySubAccount,
  updateSubAccount,
  setSubAccountActive,
  listImportAccounts,
  createImportAccount,
  type SubAccountInput,
  type SubAccountPatch,
} from '../../masters/subAccounts.js'
import {
  listImportFormats,
  createImportFormat,
  updateImportFormat,
  setImportFormatActive,
} from '../../masters/importFormats.js'
import {
  listDepartments,
  createDepartment,
  updateDepartment,
  setDepartmentActive,
} from '../../masters/departments.js'
import { listItems, createItem, updateItem, setItemActive, type ItemInput } from '../../masters/items.js'
import { listTags, createTag, deleteTag } from '../../masters/tags.js'
import { listRules, createRule, updateRule, setRuleActive, deleteRule, type RuleInput } from '../../journal/rules.js'
import { getBusinessSettings, updateBusinessSettings, type BusinessSettingsPatch } from '../../masters/businessSettings.js'
import { bookHelpers, intParam } from '../helpers.js'

/**
 * マスタ系ルート（科目・年度・税区分・事業者設定・連携サービス・各種マスタ CRUD）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 */
export function mastersRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf } = bookHelpers(router)

  /** 論理削除トグル（POST /:id/active {isActive}）。5マスタで一字一句同型だった（B8=#120）。 */
  const activeRoute = (path: string, setActive: (db: DataDb, id: number, isActive: boolean) => void): void => {
    app.post(path, async (c) => {
      const id = intParam(c)
      if (id == null) return c.json({ error: 'id が不正' }, 400)
      const body = (await c.req.json().catch(() => null)) as { isActive?: boolean } | null
      if (typeof body?.isActive !== 'boolean') return c.json({ error: 'isActive (boolean) が必要' }, 400)
      setActive(dbOf(c), id, body.isActive)
      return c.json({ ok: true })
    })
  }

  /**
   * 素直なマスタ CRUD の一括登録（B8=#120。取引先・部門・品目）:
   * GET 一覧（?includeInactive=1）/ POST 201 {id} / PUT /:id {ok} / POST /:id/active {ok}。
   * body 検証は「name 必須」で共通（メッセージ・ステータスは従来と同一。詳細検証はドメイン層）。
   * rules / sub-accounts は固有ルート・固有検証があるため対象外（tags は物理削除で別形）。
   */
  const masterCrud = <B extends { name?: string }>(spec: {
    path: string
    listKey: string
    list: (db: DataDb, includeInactive: boolean) => unknown
    create: (db: DataDb, body: B) => number
    update: (db: DataDb, id: number, body: B) => void
    setActive: (db: DataDb, id: number, isActive: boolean) => void
  }): void => {
    app.get(spec.path, (c) => c.json({ [spec.listKey]: spec.list(dbOf(c), c.req.query('includeInactive') === '1') }))
    app.post(spec.path, async (c) => {
      const body = (await c.req.json().catch(() => null)) as B | null
      if (!body?.name) return c.json({ error: 'name が必要' }, 400)
      return c.json({ id: spec.create(dbOf(c), body) }, 201)
    })
    app.put(`${spec.path}/:id`, async (c) => {
      const id = intParam(c)
      if (id == null) return c.json({ error: 'id が不正' }, 400)
      const body = (await c.req.json().catch(() => null)) as B | null
      if (!body?.name) return c.json({ error: 'name が必要' }, 400)
      spec.update(dbOf(c), id, body)
      return c.json({ ok: true })
    })
    activeRoute(`${spec.path}/:id/active`, spec.setActive)
  }

  app.get('/accounts', (c) => {
    // category（分類: 現金及び預金/経費 等）と reportType（BS/PL）は web のかんたん入力が
    // 科目候補（支出科目・収入科目・決済口座）を絞り込むのに使う。
    const rows = dbOf(c)
      .select({
        id: accounts.id,
        name: accounts.name,
        normalBalance: accounts.normalBalance,
        category: accountCategories.name,
        reportType: accountCategories.reportType,
      })
      .from(accounts)
      .innerJoin(statementItems, eq(accounts.statementItemId, statementItems.id))
      .innerJoin(accountCategories, eq(statementItems.categoryId, accountCategories.id))
      .where(eq(accounts.isActive, true))
      .all()
    return c.json({ accounts: rows } satisfies { accounts: Account[] })
  })

  // --- 事業者設定（business_settings 単一行。roadmap Phase4 各種設定） -----------
  app.get('/business-settings', (c) => c.json({ settings: getBusinessSettings(dbOf(c)) }))
  app.put('/business-settings', async (c) => {
    const body = (await c.req.json().catch(() => null)) as BusinessSettingsPatch | null
    if (!body || typeof body !== 'object') return c.json({ error: 'リクエストボディが不正' }, 400)
    updateBusinessSettings(dbOf(c), body)
    return c.json({ settings: getBusinessSettings(dbOf(c)) })
  })

  app.get('/fiscal-years', (c) =>
    c.json({
      fiscalYears: dbOf(c).select().from(fiscalYears).orderBy(asc(fiscalYears.startDate)).all(),
    } satisfies { fiscalYears: FiscalYearView[] }),
  )

  // 初回セットアップの推奨年度（1〜4月は前年・それ以外は当年）。サーバ時刻を正とする。
  app.get('/fiscal-years/suggested', (c) => c.json({ year: suggestInitialFiscalYear(new Date()) }))

  // 初回の会計年度を明示作成（暦年1本・open）。CSV先頭行からの自動確定は廃止。既存があれば 400。
  app.post('/fiscal-years', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { year?: number } | null
    if (!body || typeof body.year !== 'number') return c.json({ error: 'year（西暦）が必要' }, 400)
    return c.json({ fiscalYear: createInitialFiscalYear(dbOf(c), body.year) })
  })

  app.get('/tax-categories', (c) => {
    const rows = dbOf(c)
      .select({ id: taxCategories.id, code: taxCategories.code, label: taxCategories.label, taxability: taxCategories.taxability, direction: taxCategories.direction, rate: taxCategories.rate })
      .from(taxCategories)
      .where(eq(taxCategories.isActive, true))
      .all()
    return c.json({ taxCategories: rows } satisfies { taxCategories: TaxCategory[] })
  })

  // 連携サービス（口座マスタをカタログ駆動に拡張）。登録で補助科目を自動作成し、取込・仕訳確認をサービス毎に行う。
  app.get('/services/catalog', (c) => c.json({ catalog: SERVICE_CATALOG }))
  app.get('/services', (c) => c.json({ services: listServices(dbOf(c)) }))
  app.post('/services', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { serviceKey?: string; name?: string | null } | null
    if (!body || typeof body.serviceKey !== 'string') return c.json({ error: 'serviceKey が必要' }, 400)
    const service = registerService(dbOf(c), { serviceKey: body.serviceKey, name: body.name ?? null })
    return c.json({ service }, 201)
  })

  // --- マスタ管理（取引先・補助科目・部門・品目・タグ。roadmap Phase1） -------
  // 削除は論理削除（POST /:id/active {isActive}）。物理削除はタグのみ。

  // 取引先（counterparties）。
  masterCrud<CounterpartyInput>({
    path: '/counterparties',
    listKey: 'counterparties',
    list: listCounterparties,
    create: createCounterparty,
    update: updateCounterparty,
    setActive: setCounterpartyActive,
  })

  // 補助科目（sub_accounts）。?accountId= でその勘定配下のみ。
  app.get('/sub-accounts', (c) => {
    const accountId = c.req.query('accountId')
    return c.json({
      subAccounts: listSubAccounts(dbOf(c), {
        accountId: accountId ? Number(accountId) : undefined,
        includeInactive: c.req.query('includeInactive') === '1',
      }),
    })
  })
  app.post('/sub-accounts', async (c) => {
    const body = (await c.req.json().catch(() => null)) as SubAccountInput | null
    if (!body?.accountId || !body?.name) return c.json({ error: 'accountId と name が必要' }, 400)
    return c.json({ id: createSubAccount(dbOf(c), body) }, 201)
  })
  // 取引先別の補助科目を get-or-create（開始残高から売掛/買掛の取引先別繰越を作る導線。請求書起票と同じ補助科目に収束）。
  app.post('/sub-accounts/by-counterparty', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { accountId?: number; counterpartyId?: number } | null
    if (!body?.accountId || !body?.counterpartyId) return c.json({ error: 'accountId と counterpartyId が必要' }, 400)
    return c.json({ id: getOrCreateCounterpartySubAccount(dbOf(c), body.accountId, body.counterpartyId) })
  })
  app.put('/sub-accounts/:id', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as SubAccountPatch | null
    if (!body?.name) return c.json({ error: 'name が必要' }, 400)
    updateSubAccount(dbOf(c), id, body)
    return c.json({ ok: true })
  })
  activeRoute('/sub-accounts/:id/active', setSubAccountActive)

  // 口座マスタ（取込口座 = linked_account_ref を持つ補助科目。F-IMP-8・account_ref 手入力廃止）。
  app.get('/import-accounts', (c) => c.json({ accounts: listImportAccounts(dbOf(c)) }))
  app.post('/import-accounts', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { sourceType?: string; accountRef?: string; accountId?: number; name?: string | null } | null
    if (!body?.sourceType || !body?.accountRef || !body?.accountId) return c.json({ error: 'sourceType・accountRef・accountId が必要' }, 400)
    return c.json({ id: createImportAccount(dbOf(c), { sourceType: body.sourceType, accountRef: body.accountRef, accountId: body.accountId, name: body.name ?? null }) }, 201)
  })

  // 取込フォーマット定義（汎用列マッピング・ユーザー定義の新フォーマット。Phase3「対応フォーマット拡充」）。
  app.get('/import-formats', (c) => c.json({ formats: listImportFormats(dbOf(c), c.req.query('includeInactive') === '1') }))
  app.post('/import-formats', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string; config?: unknown } | null
    if (!body?.name || body.config == null) return c.json({ error: 'name・config が必要' }, 400)
    return c.json({ id: createImportFormat(dbOf(c), { name: body.name, config: body.config }) }, 201)
  })
  app.patch('/import-formats/:id', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as { name?: string; config?: unknown; isActive?: boolean } | null
    if (!body || typeof body !== 'object') return c.json({ error: 'JSON body が必要' }, 400)
    // name/config いずれかがあれば内容更新（未指定フィールドは既存値を保持＝部分更新）。isActive があれば切替。
    if (body.name !== undefined || body.config !== undefined) {
      updateImportFormat(dbOf(c), id, { name: body.name, config: body.config })
    }
    if (body.isActive !== undefined) setImportFormatActive(dbOf(c), id, body.isActive)
    return c.json({ ok: true })
  })

  // 部門（departments）。ドメイン層の入出力が name 文字列なのでここで詰め替える。
  masterCrud<{ name?: string }>({
    path: '/departments',
    listKey: 'departments',
    list: listDepartments,
    create: (db, body) => createDepartment(db, body.name ?? ''),
    update: (db, id, body) => updateDepartment(db, id, body.name ?? ''),
    setActive: setDepartmentActive,
  })

  // 品目（items）。
  masterCrud<ItemInput>({
    path: '/items',
    listKey: 'items',
    list: listItems,
    create: createItem,
    update: updateItem,
    setActive: setItemActive,
  })

  // タグ（tags）。物理削除。
  app.get('/tags', (c) => c.json({ tags: listTags(dbOf(c)) }))
  app.post('/tags', async (c) => {
    const body = (await c.req.json().catch(() => null)) as { name?: string } | null
    if (!body?.name) return c.json({ error: 'name が必要' }, 400)
    return c.json({ id: createTag(dbOf(c), body.name) }, 201)
  })
  app.delete('/tags/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    deleteTag(dbOf(c), id)
    return c.json({ ok: true })
  })

  // 自動仕訳ルール（auto_journal_rules）。取込時の相手科目を自動付与する設定。
  app.get('/rules', (c) => c.json({ rules: listRules(dbOf(c), c.req.query('includeInactive') === '1') }))
  app.post('/rules', async (c) => {
    const body = (await c.req.json().catch(() => null)) as RuleInput | null
    if (!body?.name || !body?.matchValue || !body?.resultAccountId) {
      return c.json({ error: 'name / matchValue / resultAccountId が必要' }, 400)
    }
    return c.json({ id: createRule(dbOf(c), body) }, 201)
  })
  app.put('/rules/:id', async (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    const body = (await c.req.json().catch(() => null)) as RuleInput | null
    if (!body?.name || !body?.matchValue || !body?.resultAccountId) {
      return c.json({ error: 'name / matchValue / resultAccountId が必要' }, 400)
    }
    updateRule(dbOf(c), id, body)
    return c.json({ ok: true })
  })
  activeRoute('/rules/:id/active', setRuleActive)
  app.delete('/rules/:id', (c) => {
    const id = intParam(c)
    if (id == null) return c.json({ error: 'id が不正' }, 400)
    deleteRule(dbOf(c), id)
    return c.json({ ok: true })
  })

  return app
}
