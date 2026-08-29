/** ホームのダッシュボード集計（純関数）と AI 連携案内（web-app spec「AI 連携の疎通案内」）。 */
import { describe, expect, it } from 'vitest'
import { cashBalance, mcpLinkRow, monthlySeries } from '../HomeTab.js'
import type { BalanceSheet, McpLinkStatus, MonthlyTrend } from '../../api.js'

const status = (over: Partial<McpLinkStatus>): McpLinkStatus => ({
  seen: false,
  lastVersion: null,
  lastSeenAt: null,
  bundledVersion: '0.2.0',
  matches: null,
  ...over,
})

describe('mcpLinkRow', () => {
  it('到達を観測していなければ、確認を促す（導入の有無は書かない）', () => {
    const row = mcpLinkRow(status({}))
    expect(row?.label).toContain('まだ確認できていません')
    // 「入っていない」と断定しない。アプリからは判別できないため。
    expect(row?.label).not.toContain('入っていません')
    expect(row?.label).not.toContain('未導入')
    // 設定タブの中でも Claude Desktop 連携のセクションを直接開く（事業者設定に落とさない）。
    expect(row?.go).toBe('settings')
    expect(row?.section).toBe('ai')
  })

  it('一致しない版が使われていれば、観測した版と時点を添えて入れ直しへ誘導する', () => {
    const row = mcpLinkRow(
      status({ seen: true, lastVersion: '0.1.0', lastSeenAt: '2026-08-13T09:30:00.000Z', matches: false }),
    )
    expect(row?.label).toContain('0.1.0')
    expect(row?.label).toContain('2026-08-13')
    expect(row?.label).toContain('0.2.0')
    expect(row?.action).toContain('書き出す')
    expect(row?.section).toBe('ai')
  })

  it('過去の観測として書く（いま古い版が入っているとは断定しない）', () => {
    const row = mcpLinkRow(
      status({ seen: true, lastVersion: '0.1.0', lastSeenAt: '2026-08-13T09:30:00.000Z', matches: false }),
    )
    expect(row?.label).toContain('使われました')
    expect(row?.label).not.toContain('入っています')
  })

  it('版を名乗らない到達も一致しないものとして案内する', () => {
    const row = mcpLinkRow(
      status({ seen: true, lastVersion: 'unknown', lastSeenAt: '2026-08-13T09:30:00.000Z', matches: false }),
    )
    expect(row?.label).toContain('版を名乗らない')
    expect(row?.action).toContain('書き出す')
  })

  it('疎通が確認できていれば案内しない', () => {
    expect(mcpLinkRow(status({ seen: true, lastVersion: '0.2.0', matches: true }))).toBeNull()
  })

  it('同梱版が分からなければ案内しない（開発時・ブラウザ）', () => {
    expect(mcpLinkRow(status({ bundledVersion: null }))).toBeNull()
    expect(
      mcpLinkRow(status({ seen: true, lastVersion: '0.1.0', bundledVersion: null, matches: null })),
    ).toBeNull()
  })

  it('状態が取れなければ案内しない', () => {
    expect(mcpLinkRow(null)).toBeNull()
  })
})

describe('monthlySeries', () => {
  it('PL 行を自然側に正規化して売上/経費/差額に集計する（評価勘定は相殺・BS 行は無視）', () => {
    const trend = {
      months: ['2026-01', '2026-02'],
      rows: [
        { accountId: 1, accountName: '売上高', reportType: 'PL', section: '売上', normalBalance: 'credit', monthly: [100, 200], total: 300 },
        { accountId: 2, accountName: '売上値引', reportType: 'PL', section: '売上', normalBalance: 'debit', monthly: [5, 0], total: 5 },
        { accountId: 3, accountName: '仕入高', reportType: 'PL', section: '売上原価', normalBalance: 'debit', monthly: [10, 0], total: 10 },
        { accountId: 4, accountName: '消耗品費', reportType: 'PL', section: '経費', normalBalance: 'debit', monthly: [30, 50], total: 80 },
        { accountId: 5, accountName: '普通預金', reportType: 'BS', section: '流動資産', normalBalance: 'debit', monthly: [999, 999], total: 1998 },
      ],
    } as MonthlyTrend
    const m = monthlySeries(trend)
    expect(m.sales).toEqual([95, 200])
    expect(m.expenses).toEqual([40, 50])
    expect(m.net).toEqual([55, 150])
  })
})

describe('cashBalance', () => {
  it('資産の「現金及び預金」区分のみを合計する', () => {
    const bs = {
      assets: [
        {
          section: '流動資産',
          total: 1500,
          rows: [
            { categoryName: '現金及び預金', normalBalance: 'debit', balance: 1000 },
            { categoryName: '現金及び預金', normalBalance: 'debit', balance: 500 },
            { categoryName: '売上債権', normalBalance: 'debit', balance: 800 },
          ],
        },
      ],
      liabilities: [],
      equity: [],
    } as unknown as BalanceSheet
    expect(cashBalance(bs)).toBe(1500)
  })
})
