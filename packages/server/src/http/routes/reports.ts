import { Hono } from 'hono'
import type { DbRouter, DataDb } from '../../db/router.js'
import type { BookVariables } from '../../books/middleware.js'
import { listEntries } from '../../journal/entries.js'
import {
  trialBalance,
  profitAndLoss,
  balanceSheet,
  generalLedger,
  subLedger,
  monthlyTrend,
  taxSalesSummary,
  departmentTrialBalance,
  departmentProfitAndLoss,
  taxExcludedProfitAndLoss,
  comparativeTrialBalance,
  comparativeProfitAndLoss,
  comparativeBalanceSheet,
} from '../../reports/reports.js'
import { buildBlueReturnStatement } from '../../reports/blueReturnStatement.js'
import {
  depreciationBreakdown,
  salaryBreakdown,
  rentBreakdown,
  senjuBreakdown,
  monthlySalesPurchase,
} from '../../reports/breakdowns.js'
import {
  trialBalanceCsv,
  profitAndLossCsv,
  balanceSheetCsv,
  generalLedgerCsv,
  subLedgerCsv,
  journalCsv,
  monthlyTrendCsv,
  taxSalesCsv,
  departmentTrialBalanceCsv,
  departmentProfitAndLossCsv,
  taxExcludedProfitAndLossCsv,
  comparativeTrialBalanceCsv,
  comparativeProfitAndLossCsv,
  comparativeBalanceSheetCsv,
} from '../../reports/csv.js'
import { DomainError } from '../errors.js'
import { bookHelpers, compareYears, csvResponse, intParam, parseEntriesFilter } from '../helpers.js'

/**
 * 帳票ルート（試算表・PL/BS・元帳・前期比較と、その CSV 出力）。
 * issue #114 で api.ts から分割（ハンドラは逐語移動・挙動不変）。
 * /reports/reconciliation は取込ドメイン（突合）なので imports 側にある。
 */
export function reportsRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()
  const { dbOf, withOpenYearOrNull, requireOpenYear } = bookHelpers(router)

  app.get('/reports/trial-balance', (c) => {
    const period = { from: c.req.query('from') ?? null, to: c.req.query('to') ?? null }
    return c.json({ report: withOpenYearOrNull(c, (db, fyId) => trialBalance(db, fyId, period)) })
  })
  app.get('/reports/pl', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => profitAndLoss(db, fyId)) }))
  app.get('/reports/bs', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => balanceSheet(db, fyId)) }))
  // 青色申告決算書（損益ページ）の様式ボックス（AOIRO.PL.*。3段集計の最終段・form-mapping §1.1）。
  app.get('/reports/blue-statement', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => buildBlueReturnStatement(db, fyId)) }))
  // 青色決算書 内訳ページ（form-mapping §1.3〜§1.7。各合計は損益の対応行に連動）。
  app.get('/reports/breakdown/depreciation', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => depreciationBreakdown(db, fyId)) }))
  app.get('/reports/breakdown/salary', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => salaryBreakdown(db, fyId)) }))
  app.get('/reports/breakdown/rent', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => rentBreakdown(db, fyId)) }))
  app.get('/reports/breakdown/senju', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => senjuBreakdown(db, fyId)) }))
  app.get('/reports/breakdown/monthly-sales-purchase', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => monthlySalesPurchase(db, fyId)) }))
  app.get('/reports/monthly-trend', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => monthlyTrend(db, fyId)) }))
  app.get('/reports/tax-sales', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => taxSalesSummary(db, fyId)) }))
  app.get('/reports/tax-excluded-pl', (c) => c.json({ report: withOpenYearOrNull(c, (db, fyId) => taxExcludedProfitAndLoss(db, fyId)) }))

  app.get('/reports/department-trial-balance', (c) => {
    const period = { from: c.req.query('from') ?? null, to: c.req.query('to') ?? null }
    return c.json({ report: withOpenYearOrNull(c, (db, fyId) => departmentTrialBalance(db, fyId, period)) })
  })
  app.get('/reports/department-pl', (c) => {
    const period = { from: c.req.query('from') ?? null, to: c.req.query('to') ?? null }
    return c.json({ report: withOpenYearOrNull(c, (db, fyId) => departmentProfitAndLoss(db, fyId, period)) })
  })
  app.get('/reports/ledger/:accountId', (c) => {
    const accountId = intParam(c, 'accountId')
    if (accountId == null) return c.json({ error: 'id が不正' }, 400)
    return c.json({ report: withOpenYearOrNull(c, (db, fyId) => generalLedger(db, fyId, accountId)) })
  })
  app.get('/reports/sub-ledger/:subAccountId', (c) => {
    const subAccountId = intParam(c, 'subAccountId')
    if (subAccountId == null) return c.json({ error: 'id が不正' }, 400)
    return c.json({ report: withOpenYearOrNull(c, (db, fyId) => subLedger(db, fyId, subAccountId)) })
  })

  // 前期比較（複数年度比較。?fiscalYearId=&compareTo= ／ 省略時は open 年度＋前期自動）。
  app.get('/reports/comparison/trial-balance', (c) => {
    const db = dbOf(c)
    const y = compareYears(db, c.req.query('fiscalYearId'), c.req.query('compareTo'))
    return c.json({ report: y ? comparativeTrialBalance(db, y.fyId, y.priorFyId) : null })
  })
  app.get('/reports/comparison/pl', (c) => {
    const db = dbOf(c)
    const y = compareYears(db, c.req.query('fiscalYearId'), c.req.query('compareTo'))
    return c.json({ report: y ? comparativeProfitAndLoss(db, y.fyId, y.priorFyId) : null })
  })
  app.get('/reports/comparison/bs', (c) => {
    const db = dbOf(c)
    const y = compareYears(db, c.req.query('fiscalYearId'), c.req.query('compareTo'))
    return c.json({ report: y ? comparativeBalanceSheet(db, y.fyId, y.priorFyId) : null })
  })

  // 帳票 CSV 出力（F-BOK-4・RFC4180・UTF-8 BOM・Content-Disposition）。
  // 14ルートが完全同型の定型だったためテーブル駆動で登録する（B6=#118）。
  // - filename は元帳系のみ結果依存の動的名（(r) => string）
  // - ルートパラメータ不正は DomainError('id が不正') を投げれば onError が従来と同じ 400 {error} にする（#115）
  type CsvCtx = { req: { query: (k: string) => string | undefined; param: (name: string) => string | undefined } }
  const periodOf = (c: CsvCtx) => ({ from: c.req.query('from') ?? null, to: c.req.query('to') ?? null })
  const csvReport = <T extends object>(
    path: string,
    filename: string | ((r: T) => string),
    build: (db: DataDb, fyId: number, c: CsvCtx) => T,
    toCsv: (r: T) => string,
  ): void => {
    app.get(path, (c) => {
      const { db, fyId } = requireOpenYear(c)
      const r = build(db, fyId, c)
      return csvResponse(c, typeof filename === 'function' ? filename(r) : filename, toCsv(r))
    })
  }

  csvReport('/reports/journal.csv', '仕訳帳.csv', (db, fyId, c) => listEntries(db, fyId, parseEntriesFilter((k) => c.req.query(k))), journalCsv)
  csvReport('/reports/trial-balance.csv', '試算表.csv', (db, fyId, c) => trialBalance(db, fyId, periodOf(c)), trialBalanceCsv)
  csvReport('/reports/pl.csv', '損益計算書.csv', profitAndLoss, profitAndLossCsv)
  csvReport('/reports/bs.csv', '貸借対照表.csv', balanceSheet, balanceSheetCsv)
  csvReport('/reports/monthly-trend.csv', '月次推移表.csv', monthlyTrend, monthlyTrendCsv)
  csvReport('/reports/tax-sales.csv', '消費税集計.csv', taxSalesSummary, taxSalesCsv)
  csvReport('/reports/tax-excluded-pl.csv', '税抜損益計算書.csv', taxExcludedProfitAndLoss, taxExcludedProfitAndLossCsv)
  csvReport('/reports/department-trial-balance.csv', '部門別試算表.csv', (db, fyId, c) => departmentTrialBalance(db, fyId, periodOf(c)), departmentTrialBalanceCsv)
  csvReport('/reports/department-pl.csv', '部門別損益計算書.csv', (db, fyId, c) => departmentProfitAndLoss(db, fyId, periodOf(c)), departmentProfitAndLossCsv)
  csvReport(
    '/reports/ledger/:accountId/csv',
    (r) => `総勘定元帳_${r.accountName}.csv`,
    (db, fyId, c) => {
      const accountId = intParam(c, 'accountId')
      if (accountId == null) throw new DomainError('id が不正')
      return generalLedger(db, fyId, accountId)
    },
    generalLedgerCsv,
  )
  csvReport(
    '/reports/sub-ledger/:subAccountId/csv',
    (r) => `補助元帳_${r.accountName}_${r.subAccountName}.csv`,
    (db, fyId, c) => {
      const subAccountId = intParam(c, 'subAccountId')
      if (subAccountId == null) throw new DomainError('id が不正')
      return subLedger(db, fyId, subAccountId)
    },
    subLedgerCsv,
  )

  // 前期比較 CSV（compareYears 基盤＝open 年度でなく年度指定で解決するため別ヘルパ・B6 の注意どおり）。
  const comparisonCsv = <T>(
    path: string,
    filename: string,
    build: (db: DataDb, fyId: number, priorFyId: number | null) => T,
    toCsv: (r: T) => string,
  ): void => {
    app.get(path, (c) => {
      const db = dbOf(c)
      const y = compareYears(db, c.req.query('fiscalYearId'), c.req.query('compareTo'))
      if (!y) throw new DomainError('開いている会計年度がありません')
      return csvResponse(c, filename, toCsv(build(db, y.fyId, y.priorFyId)))
    })
  }
  comparisonCsv('/reports/comparison/trial-balance.csv', '試算表_前期比較.csv', comparativeTrialBalance, comparativeTrialBalanceCsv)
  comparisonCsv('/reports/comparison/pl.csv', '損益計算書_前期比較.csv', comparativeProfitAndLoss, comparativeProfitAndLossCsv)
  comparisonCsv('/reports/comparison/bs.csv', '貸借対照表_前期比較.csv', comparativeBalanceSheet, comparativeBalanceSheetCsv)

  return app
}
