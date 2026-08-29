import { and, asc, eq, inArray, type SQL } from 'drizzle-orm'
import { type GeneralLedger, type LedgerRow, type SubLedger, type Yen, yen } from '@kanean/shared'

export type { GeneralLedger, LedgerRow, SubLedger }
import { accountBalance, type Side } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { accounts, journalEntries, journalLines, openingBalances, subAccounts } from '../db/data/schema.js'

/** 元帳（総勘定元帳・補助元帳）。reports.ts（B3=#116）から分割。 */

// --- 総勘定元帳 ------------------------------------------------------------


/**
 * 複数仕訳の相手科目名を1クエリで解決（N+1解消）。各 entry につき、当該勘定
 * （excludeAccountId）“以外”の明細の勘定名を集める。相手勘定の重複は accountId で
 * 排除（科目名の文字列一致ではなく id 一致）。相手が無ければ「—」、複数なら「諸口」。
 */
function resolveCounterAccounts(
  db: DataDb,
  entryIds: number[],
  excludeAccountId: number,
): Map<number, string> {
  const result = new Map<number, string>()
  if (entryIds.length === 0) return result
  const others = db
    .select({ entryId: journalLines.entryId, accountId: journalLines.accountId, name: accounts.name })
    .from(journalLines)
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(inArray(journalLines.entryId, entryIds))
    .all()
  // entryId → (相手 accountId → 科目名)。accountId をキーにするので同一勘定は自然に1つへ畳まれる。
  const byEntry = new Map<number, Map<number, string>>()
  for (const o of others) {
    if (o.accountId === excludeAccountId) continue // 自勘定は相手にしない（id 一致で除外）
    let m = byEntry.get(o.entryId)
    if (!m) {
      m = new Map()
      byEntry.set(o.entryId, m)
    }
    m.set(o.accountId, o.name)
  }
  for (const id of entryIds) {
    const m = byEntry.get(id)
    if (!m || m.size === 0) result.set(id, '—')
    else if (m.size === 1) result.set(id, [...m.values()][0])
    else result.set(id, '諸口')
  }
  return result
}

/**
 * 元帳の共通核（B3=#116）。総勘定元帳と補助元帳は「対象の絞り込み列（開始残高・明細）」と
 * 「相手科目の除外勘定」以外が行単位で同文だったため一本化する。
 * orderBy（entryDate, entryId, lineNo）は厳守（累積残高と表示順の正）。
 */
function buildLedger(
  db: DataDb,
  fiscalYearId: number,
  normal: Side,
  opts: {
    /** 期首繰越（開始残高）の対象条件（accountId 軸 or subAccountId 軸）。 */
    openingCond: SQL
    /** 仕訳明細の対象条件（accountId 軸 or subAccountId 軸）。 */
    lineCond: SQL
    /** 相手科目の解決で「自分」として除外する勘定 id（補助元帳も親勘定 id で除外する）。 */
    excludeAccountId: number
  },
): { openingBalance: Yen; rows: LedgerRow[]; closingBalance: Yen } {
  // 期首繰越（開始残高）。
  const ob = db
    .select()
    .from(openingBalances)
    .where(and(eq(openingBalances.fiscalYearId, fiscalYearId), opts.openingCond))
    .all()
  const openDebit = yen(ob.filter((o) => o.side === 'debit').reduce((s, o) => s + o.amount, 0))
  const openCredit = yen(ob.filter((o) => o.side === 'credit').reduce((s, o) => s + o.amount, 0))
  const openingBalance = accountBalance(normal, openDebit, openCredit)

  // 対象を含む confirmed 仕訳の明細（日付順）。
  const myLines = db
    .select({
      entryId: journalLines.entryId,
      side: journalLines.side,
      amount: journalLines.amount,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        opts.lineCond,
        eq(journalEntries.fiscalYearId, fiscalYearId),
        eq(journalEntries.status, 'confirmed'),
      ),
    )
    .orderBy(asc(journalEntries.entryDate), asc(journalLines.entryId), asc(journalLines.lineNo))
    .all()

  // 相手科目の解決: 対象を含む全 entry の相手明細を1クエリで（N+1解消・id 一致）。
  const entryIds = [...new Set(myLines.map((l) => l.entryId))]
  const counterByEntry = resolveCounterAccounts(db, entryIds, opts.excludeAccountId)

  let running: number = openingBalance
  const rows: LedgerRow[] = myLines.map((l) => {
    const debit = l.side === 'debit' ? yen(l.amount) : yen(0)
    const credit = l.side === 'credit' ? yen(l.amount) : yen(0)
    running += accountBalance(normal, debit, credit)
    return {
      entryId: l.entryId,
      entryDate: l.entryDate,
      description: l.description,
      counterAccount: counterByEntry.get(l.entryId) ?? '—',
      debit,
      credit,
      balance: yen(running),
    }
  })

  return { openingBalance, rows, closingBalance: yen(running) }
}

/** 総勘定元帳（1科目の時系列・累積残高）。開始残高を期首繰越として反映。 */
export function generalLedger(db: DataDb, fiscalYearId: number, accountId: number): GeneralLedger {
  const account = db.select().from(accounts).where(eq(accounts.id, accountId)).all()[0]
  if (!account) throw new Error(`account ${accountId} が見つかりません`)
  const normal = account.normalBalance as Side
  const ledger = buildLedger(db, fiscalYearId, normal, {
    openingCond: eq(openingBalances.accountId, accountId),
    lineCond: eq(journalLines.accountId, accountId),
    excludeAccountId: accountId,
  })
  return { accountId, accountName: account.name, normalBalance: normal, ...ledger }
}

// --- 補助元帳 --------------------------------------------------------------


/**
 * 補助元帳（F-BOK-2）。総勘定元帳を補助科目軸で分解した1補助科目の時系列・累積残高。
 * 残高の向き（normal_balance）は親勘定に従う。開始残高は sub_account 別の opening_balances を反映。
 * 相手科目は同一仕訳内の当該補助科目“以外”の明細から解決（複数なら諸口）。
 */
export function subLedger(db: DataDb, fiscalYearId: number, subAccountId: number): SubLedger {
  const sub = db.select().from(subAccounts).where(eq(subAccounts.id, subAccountId)).all()[0]
  if (!sub) throw new Error(`補助科目 ${subAccountId} が見つかりません`)
  const account = db.select().from(accounts).where(eq(accounts.id, sub.accountId)).all()[0]
  if (!account) throw new Error(`勘定科目 ${sub.accountId} が見つかりません`)
  const normal = account.normalBalance as Side
  // 相手科目は親勘定 id で除外する: 同一親勘定の別補助/補助なし明細も自己として相手から外れる
  // （補助の所属は親勘定なので、自補助の明細は必ず親勘定 id で除外される）。
  const ledger = buildLedger(db, fiscalYearId, normal, {
    openingCond: eq(openingBalances.subAccountId, subAccountId),
    lineCond: eq(journalLines.subAccountId, subAccountId),
    excludeAccountId: account.id,
  })
  return {
    subAccountId,
    subAccountName: sub.name,
    accountId: account.id,
    accountName: account.name,
    normalBalance: normal,
    ...ledger,
  }
}

