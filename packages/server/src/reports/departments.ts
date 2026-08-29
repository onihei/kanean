import { and, eq, gte, lte } from 'drizzle-orm'
import {
  type DepartmentColumn,
  type DepartmentMatrixRow,
  type DepartmentPlSection,
  type DepartmentProfitAndLoss,
  type DepartmentTrialBalance,
  yen,
} from '@kanean/shared'

export type { DepartmentColumn, DepartmentMatrixRow, DepartmentPlSection, DepartmentProfitAndLoss, DepartmentTrialBalance }
import { accountBalance, type Side } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { departments, journalEntries, journalLines } from '../db/data/schema.js'
import { accountMetaById, assertValidPeriod, type Period, type ReportType } from './base.js'

/** 部門別集計（部門別試算表・部門別損益計算書）。reports.ts（B3=#116）から分割。 */

// --- 部門別集計（部門別PL / 部門別試算表 / roadmap Phase2） -------------------


interface DeptCell {
  debit: number
  credit: number
}

/**
 * confirmed 仕訳明細を (部門 × 科目) で借貸集計する。
 * - 開始残高は部門軸を持たない（opening_balances に department_id が無い）ため含めない
 *   ＝部門別は常に「期中発生高」ベース（損益管理が主目的）。period で更に期間を絞れる。
 * - 列（部門）は明細に現れた部門のみを sortOrder 昇順で採り、未配賦（null）は末尾。
 *   どの仕訳明細も貸借いずれか1セルへ必ず計上されるので、列横断の総借方=総貸方が保たれる。
 */
function departmentAggregates(
  db: DataDb,
  fiscalYearId: number,
  period?: Period,
): { departments: DepartmentColumn[]; cells: Map<number, DeptCell[]> } {
  assertValidPeriod(period)
  const from = period?.from ?? null
  const to = period?.to ?? null
  const conds = [eq(journalEntries.fiscalYearId, fiscalYearId), eq(journalEntries.status, 'confirmed')]
  if (from) conds.push(gte(journalEntries.entryDate, from))
  if (to) conds.push(lte(journalEntries.entryDate, to))
  const lines = db
    .select({
      accountId: journalLines.accountId,
      departmentId: journalLines.departmentId,
      side: journalLines.side,
      amount: journalLines.amount,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conds))
    .all()

  const deptMeta = new Map<number, { name: string; sortOrder: number }>()
  for (const d of db.select().from(departments).all()) deptMeta.set(d.id, { name: d.name, sortOrder: d.sortOrder })

  // 明細に現れた部門のみを列にする（空列を作らない）。未配賦（null）は末尾。
  let hasUnassigned = false
  const presentIds = new Set<number>()
  for (const l of lines) {
    if (l.departmentId == null) hasUnassigned = true
    else presentIds.add(l.departmentId)
  }
  const orderedIds = [...presentIds].sort(
    (a, b) => (deptMeta.get(a)?.sortOrder ?? 0) - (deptMeta.get(b)?.sortOrder ?? 0) || a - b,
  )
  const columns: DepartmentColumn[] = orderedIds.map((id) => ({
    departmentId: id,
    departmentName: deptMeta.get(id)?.name ?? `部門${id}`,
  }))
  if (hasUnassigned) columns.push({ departmentId: null, departmentName: '未配賦' })

  const colIndex = new Map<number | null, number>()
  columns.forEach((c, i) => colIndex.set(c.departmentId, i))

  const cells = new Map<number, DeptCell[]>()
  for (const l of lines) {
    let arr = cells.get(l.accountId)
    if (!arr) {
      arr = columns.map(() => ({ debit: 0, credit: 0 }))
      cells.set(l.accountId, arr)
    }
    const ci = colIndex.get(l.departmentId ?? null)!
    if (l.side === 'debit') arr[ci].debit += l.amount
    else arr[ci].credit += l.amount
  }
  return { departments: columns, cells }
}



/** 部門別試算表（全科目 × 部門の残高マトリクス・期中発生高ベース）。 */
export function departmentTrialBalance(db: DataDb, fiscalYearId: number, period?: Period): DepartmentTrialBalance {
  const { departments: cols, cells } = departmentAggregates(db, fiscalYearId, period)
  const metaById = accountMetaById(db)
  const totalsByDept = cols.map(() => ({ totalDebit: 0, totalCredit: 0 }))

  const rows: (DepartmentMatrixRow & { sortOrder: number })[] = []
  for (const [accountId, arr] of cells) {
    const m = metaById.get(accountId)
    if (!m) continue
    const normal = m.normalBalance as Side
    const byDept = arr.map((cell, i) => {
      totalsByDept[i].totalDebit += cell.debit
      totalsByDept[i].totalCredit += cell.credit
      return accountBalance(normal, yen(cell.debit), yen(cell.credit))
    })
    rows.push({
      accountId,
      accountName: m.accountName,
      reportType: m.reportType as ReportType,
      section: m.section,
      normalBalance: normal,
      byDept,
      total: yen(byDept.reduce((s, v) => s + v, 0)),
      sortOrder: m.sortOrder,
    })
  }
  rows.sort((a, b) => a.sortOrder - b.sortOrder || a.accountId - b.accountId)

  const totalDebit = yen(totalsByDept.reduce((s, t) => s + t.totalDebit, 0))
  const totalCredit = yen(totalsByDept.reduce((s, t) => s + t.totalCredit, 0))
  return {
    departments: cols,
    rows: rows.map(({ sortOrder: _sortOrder, ...r }) => r),
    totalsByDept: totalsByDept.map((t) => ({ totalDebit: yen(t.totalDebit), totalCredit: yen(t.totalCredit) })),
    totalDebit,
    totalCredit,
    balanced: totalDebit === totalCredit,
  }
}


/**
 * 部門別損益計算書（PL科目 × 部門の発生高）。
 * 全部門（未配賦含む）の netIncome 合算は profitAndLoss(db, fy) の当期所得に一致する
 * （PL科目は開始残高を持たないため、部門別＝期中発生高の合算が全社PLと一致）。
 */
export function departmentProfitAndLoss(db: DataDb, fiscalYearId: number, period?: Period): DepartmentProfitAndLoss {
  const { departments: allCols, cells } = departmentAggregates(db, fiscalYearId, period)
  const metaById = accountMetaById(db)

  // PL明細が現れた部門列のみを残す（BS科目にしか現れない部門の「見出しだけの空列」を出さない）。
  // 落とす列は全PL科目で借貸とも0なので、PL集計・全社一致の不変条件には影響しない。
  const plActive = allCols.map(() => false)
  for (const [accountId, arr] of cells) {
    const m = metaById.get(accountId)
    if (!m || m.reportType !== 'PL') continue
    arr.forEach((cell, i) => {
      if (cell.debit !== 0 || cell.credit !== 0) plActive[i] = true
    })
  }
  const keepIdx = allCols.map((_, i) => i).filter((i) => plActive[i])
  const cols = keepIdx.map((i) => allCols[i])

  const plRows: (DepartmentMatrixRow & { sortOrder: number })[] = []
  for (const [accountId, arr] of cells) {
    const m = metaById.get(accountId)
    if (!m || m.reportType !== 'PL') continue
    const normal = m.normalBalance as Side
    const byDept = keepIdx.map((i) => accountBalance(normal, yen(arr[i].debit), yen(arr[i].credit)))
    plRows.push({
      accountId,
      accountName: m.accountName,
      reportType: 'PL',
      section: m.section,
      normalBalance: normal,
      byDept,
      total: yen(byDept.reduce((s, v) => s + v, 0)),
      sortOrder: m.sortOrder,
    })
  }
  plRows.sort((a, b) => a.sortOrder - b.sortOrder || a.accountId - b.accountId)

  const mkSection = (section: string): DepartmentPlSection => {
    const secRows = plRows.filter((r) => r.section === section)
    const totalByDept = cols.map((_, i) => yen(secRows.reduce((s, r) => s + r.byDept[i], 0)))
    return {
      section,
      rows: secRows.map(({ sortOrder: _sortOrder, ...r }) => r),
      totalByDept,
      total: yen(totalByDept.reduce((s, v) => s + v, 0)),
    }
  }
  const sales = mkSection('売上')
  const costOfSales = mkSection('売上原価')
  const expenses = mkSection('経費')

  const grossProfitByDept = cols.map((_, i) => yen(sales.totalByDept[i] - costOfSales.totalByDept[i]))
  const netIncomeByDept = cols.map((_, i) => yen(grossProfitByDept[i] - expenses.totalByDept[i]))
  return {
    departments: cols,
    sales,
    costOfSales,
    expenses,
    grossProfitByDept,
    grossProfit: yen(sales.total - costOfSales.total),
    netIncomeByDept,
    netIncome: yen(yen(sales.total - costOfSales.total) - expenses.total),
  }
}

