import { and, eq, gte, lte } from 'drizzle-orm'
import { type AccountBalanceRow, type Period, type ReportType, yen } from '@kanean/shared'

export type { AccountBalanceRow, Period, ReportType }
import { accountBalance, type Side } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import {
  accountCategories,
  accounts,
  journalEntries,
  journalLines,
  openingBalances,
  statementItems,
} from '../db/data/schema.js'

/**
 * 帳票（accounting-spec §10）。confirmed 仕訳＋開始残高を集計する。
 * - 試算表（合計残高試算表）: 全科目の借方合計・貸方合計・残高
 * - 総勘定元帳: 科目ごとに時系列で normal_balance 方向に累積
 * - 損益計算書 / 貸借対照表: section で集計、当期所得を連結
 * 金額は税込（accounting_method=tax_included 既定）。
 */



interface Agg {
  debit: number
  credit: number
}


const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

/** period の形式（YYYY-MM-DD）・実在日付・順序（from ≤ to）を検証。不正なら throw（空集合の誤読防止）。 */
export function assertValidPeriod(period?: Period): void {
  const check = (v: string | null, label: string): void => {
    if (v == null) return
    if (!ISO_DATE.test(v)) throw new Error(`${label} は YYYY-MM-DD 形式で指定してください`)
    // 桁形だけでなく実在日付か（2026-13-01 / 2026-02-30 等を弾く）。
    const dt = new Date(`${v}T00:00:00Z`)
    if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== v) throw new Error(`${label} ${v} は存在しない日付です`)
  }
  const from = period?.from ?? null
  const to = period?.to ?? null
  check(from, 'from')
  check(to, 'to')
  if (from && to && from > to) throw new Error('from は to 以前の日付で指定してください')
}

export interface AccountMeta {
  accountId: number
  accountName: string
  normalBalance: string
  sortOrder: number
  itemName: string
  categoryName: string
  section: string
  reportType: string
  statementLineCode: string | null
}

/** 勘定科目メタ（report_type / section / 名称 / 並び順）を id 索引で取得。集計・帳票で共有。 */
export function accountMetaById(db: DataDb): Map<number, AccountMeta> {
  const meta = db
    .select({
      accountId: accounts.id,
      accountName: accounts.name,
      normalBalance: accounts.normalBalance,
      sortOrder: accounts.sortOrder,
      itemName: statementItems.name,
      categoryName: accountCategories.name,
      section: accountCategories.section,
      reportType: accountCategories.reportType,
      statementLineCode: statementItems.statementLineCode,
    })
    .from(accounts)
    .innerJoin(statementItems, eq(accounts.statementItemId, statementItems.id))
    .innerJoin(accountCategories, eq(statementItems.categoryId, accountCategories.id))
    .all()
  return new Map(meta.map((m) => [m.accountId, m]))
}

/**
 * confirmed 仕訳明細＋開始残高を accountId ごとに借貸集計し、科目メタと結合する。
 * period 指定時は entry_date で絞る（仕訳は不可分なので貸借一致は保たれる）。
 * - from なし: 期首繰越（開始残高）を含む＝期首〜（to まで）の累計。
 * - from あり: 開始残高を含めない＝当該期間の発生高（月次/期間試算表）。
 */
export function accountAggregates(db: DataDb, fiscalYearId: number, period?: Period): AccountBalanceRow[] {
  const from = period?.from ?? null
  const to = period?.to ?? null
  const agg = new Map<number, Agg>()
  const bump = (accountId: number, side: string, amount: number) => {
    const a = agg.get(accountId) ?? { debit: 0, credit: 0 }
    if (side === 'debit') a.debit += amount
    else a.credit += amount
    agg.set(accountId, a)
  }

  // 開始残高（前期繰越）。期間の開始（from）が指定された場合は発生高表示なので含めない。
  if (!from) {
    for (const ob of db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, fiscalYearId)).all()) {
      bump(ob.accountId, ob.side, ob.amount)
    }
  }

  // confirmed 仕訳明細（period 指定時は entry_date で絞る）。
  const conds = [eq(journalEntries.fiscalYearId, fiscalYearId), eq(journalEntries.status, 'confirmed')]
  if (from) conds.push(gte(journalEntries.entryDate, from))
  if (to) conds.push(lte(journalEntries.entryDate, to))
  const lines = db
    .select({ accountId: journalLines.accountId, side: journalLines.side, amount: journalLines.amount })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conds))
    .all()
  for (const l of lines) bump(l.accountId, l.side, l.amount)

  if (agg.size === 0) return []

  const metaById = accountMetaById(db)

  const rows: AccountBalanceRow[] = []
  for (const [accountId, a] of agg) {
    const m = metaById.get(accountId)
    if (!m) continue
    const normal = m.normalBalance as Side
    rows.push({
      accountId,
      accountName: m.accountName,
      reportType: m.reportType as ReportType,
      section: m.section,
      categoryName: m.categoryName,
      itemName: m.itemName,
      normalBalance: normal,
      totalDebit: yen(a.debit),
      totalCredit: yen(a.credit),
      balance: accountBalance(normal, yen(a.debit), yen(a.credit)),
      sortOrder: m.sortOrder,
      lineCode: m.statementLineCode,
    })
  }
  rows.sort((x, y) => x.sortOrder - y.sortOrder || x.accountId - y.accountId)
  return rows
}

