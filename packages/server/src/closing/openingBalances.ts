import type { OpeningBalanceView, BsAccountView, BsPart, BsSubAccountView, OpeningBalanceTotals } from '@kanean/shared'
export type { OpeningBalanceView, BsAccountView, BsPart, BsSubAccountView, OpeningBalanceTotals }
import { and, asc, eq, isNull, notInArray } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import {
  accountCategories,
  accounts,
  fiscalYears,
  openingBalances,
  statementItems,
  subAccounts,
} from '../db/data/schema.js'

/**
 * 開始残高（opening_balances）の書込み（accounting-spec §1.3・form-mapping §5.2）。
 * 貸借対照表科目の期首残高を登録し、accountAggregates（from 指定なし）が期首繰越として
 * 取り込む＝青色決算書4ページ目（貸借）の期首列を実値で駆動する。
 *
 * 二重計上防止: 同一（年度・科目・補助）は upsert（更新）し新規行を増やさない。
 * DB 側にも部分 UNIQUE(fiscal_year_id, account_id, sub_account_id) を付与（schema.ts）。
 * SQLite の UNIQUE は NULL を相異とみなすため、補助科目=NULL の科目レベル行の一意性は
 * 本サービスの upsert（isNull マッチ）が担保する。
 */

const BS = 'BS'

/** 当年度の開始残高一覧（科目・補助名・section つき）。 */
export function listOpeningBalances(db: DataDb, fiscalYearId: number): OpeningBalanceView[] {
  return db
    .select({
      id: openingBalances.id,
      accountId: openingBalances.accountId,
      accountName: accounts.name,
      subAccountId: openingBalances.subAccountId,
      subAccountName: subAccounts.name,
      section: accountCategories.section,
      side: openingBalances.side,
      amount: openingBalances.amount,
    })
    .from(openingBalances)
    .innerJoin(accounts, eq(openingBalances.accountId, accounts.id))
    .innerJoin(statementItems, eq(accounts.statementItemId, statementItems.id))
    .innerJoin(accountCategories, eq(statementItems.categoryId, accountCategories.id))
    .leftJoin(subAccounts, eq(openingBalances.subAccountId, subAccounts.id))
    .where(eq(openingBalances.fiscalYearId, fiscalYearId))
    .orderBy(asc(accounts.sortOrder), asc(openingBalances.id))
    .all()
    .map((r) => ({ ...r, subAccountName: r.subAccountId == null ? null : r.subAccountName }))
}

/**
 * 開始残高の入力対象から外す科目。事業主貸/借は毎期首ゼロ（前期末に元入金へ振替＝accounting-spec §1.3）で
 * 開始残高を持たないため、グリッドに出さない（事業主貸配下の資産譲渡損・未確定勘定などは残す）。
 */
const OPENING_BALANCE_EXCLUDED = ['事業主貸', '事業主借']

const LIABILITY_SECTIONS = new Set(['流動負債', '固定負債'])

/** account_categories.section（流動資産/固定負債/資本…）を貸借対照表の三部へ畳む。 */
function bsPart(section: string): BsPart {
  if (LIABILITY_SECTIONS.has(section)) return '負債の部'
  if (section === '資本') return '資本の部'
  return '資産の部' // 流動資産・固定資産・繰延資産・諸口
}

/** 開始残高を登録できる貸借対照表科目（有効・事業主貸借を除く）。UI のグリッドが提示する。 */
export function listBalanceSheetAccounts(db: DataDb): BsAccountView[] {
  return db
    .select({
      id: accounts.id,
      name: accounts.name,
      section: accountCategories.section,
      normalBalance: accounts.normalBalance,
      sortOrder: accounts.sortOrder,
    })
    .from(accounts)
    .innerJoin(statementItems, eq(accounts.statementItemId, statementItems.id))
    .innerJoin(accountCategories, eq(statementItems.categoryId, accountCategories.id))
    .where(
      and(
        eq(accountCategories.reportType, BS),
        eq(accounts.isActive, true),
        notInArray(accounts.name, OPENING_BALANCE_EXCLUDED),
      ),
    )
    .orderBy(asc(accounts.sortOrder), asc(accounts.id))
    .all()
    .map((r) => ({ ...r, part: bsPart(r.section) }))
}

/**
 * 開始残高グリッドが各 BS 科目の下に並べる補助科目（有効・BS科目配下のみ）。
 * 取引先別の売掛/買掛繰越などを補助科目=取引先で入力できるようにする（data-model §2.5）。
 */
export function listBalanceSheetSubAccounts(db: DataDb): BsSubAccountView[] {
  return db
    .select({
      id: subAccounts.id,
      accountId: subAccounts.accountId,
      name: subAccounts.name,
      sortOrder: subAccounts.sortOrder,
    })
    .from(subAccounts)
    .innerJoin(accounts, eq(subAccounts.accountId, accounts.id))
    .innerJoin(statementItems, eq(accounts.statementItemId, statementItems.id))
    .innerJoin(accountCategories, eq(statementItems.categoryId, accountCategories.id))
    .where(
      and(
        eq(accountCategories.reportType, BS),
        eq(accounts.isActive, true),
        eq(subAccounts.isActive, true),
        notInArray(accounts.name, OPENING_BALANCE_EXCLUDED), // 親が除外科目（事業主貸/借）の補助は孤立行になるため除く
      ),
    )
    .orderBy(asc(accounts.sortOrder), asc(subAccounts.sortOrder), asc(subAccounts.id))
    .all()
}

/**
 * 開始残高の貸借合計と一致判定（data-model §2.7「元入金もこの表で表現。貸借合計一致を整合性チェックで担保」）。
 * 入力途中は不一致になりうるため UI は警告に留め、登録自体は妨げない。
 */
export function openingBalanceTotals(views: OpeningBalanceView[]): OpeningBalanceTotals {
  let totalDebit = 0
  let totalCredit = 0
  for (const v of views) {
    if (v.side === 'debit') totalDebit += v.amount
    else totalCredit += v.amount
  }
  return { totalDebit, totalCredit, difference: totalDebit - totalCredit, balanced: totalDebit === totalCredit }
}

export interface UpsertOpeningBalanceInput {
  fiscalYearId: number
  accountId: number
  subAccountId?: number | null
  side: string
  amount: number
}

/** 同一（年度・科目・補助）があれば更新、なければ作成。BS科目のみ・side/金額を検証。 */
export function upsertOpeningBalance(db: DataDb, input: UpsertOpeningBalanceInput): number {
  if (input.side !== 'debit' && input.side !== 'credit') throw new Error('side は debit / credit のいずれか')
  if (!Number.isSafeInteger(input.amount) || input.amount < 0) throw new Error('金額は0以上の整数（円）で指定してください')

  const acc = db
    .select({ id: accounts.id, reportType: accountCategories.reportType })
    .from(accounts)
    .innerJoin(statementItems, eq(accounts.statementItemId, statementItems.id))
    .innerJoin(accountCategories, eq(statementItems.categoryId, accountCategories.id))
    .where(eq(accounts.id, input.accountId))
    .all()[0]
  if (!acc) throw new Error(`勘定科目 ${input.accountId} が見つかりません`)
  if (acc.reportType !== BS) throw new Error('開始残高は貸借対照表科目にのみ設定できます')

  const sub = input.subAccountId ?? null
  if (sub != null) {
    const sa = db.select({ accountId: subAccounts.accountId }).from(subAccounts).where(eq(subAccounts.id, sub)).all()[0]
    if (!sa) throw new Error(`補助科目 ${sub} が見つかりません`)
    if (sa.accountId !== input.accountId) throw new Error('補助科目が指定の勘定科目に属していません')
  }

  const existing = db
    .select({ id: openingBalances.id })
    .from(openingBalances)
    .where(
      and(
        eq(openingBalances.fiscalYearId, input.fiscalYearId),
        eq(openingBalances.accountId, input.accountId),
        sub == null ? isNull(openingBalances.subAccountId) : eq(openingBalances.subAccountId, sub),
      ),
    )
    .all()[0]

  if (existing) {
    db.update(openingBalances)
      .set({ side: input.side, amount: input.amount })
      .where(eq(openingBalances.id, existing.id))
      .run()
    return existing.id
  }
  return db
    .insert(openingBalances)
    .values({ fiscalYearId: input.fiscalYearId, accountId: input.accountId, subAccountId: sub, side: input.side, amount: input.amount })
    .returning()
    .all()[0].id
}

/** 開始残高を削除。upsert（open 年度限定）と対称に、open でない年度の行は削除を拒否する。 */
export function deleteOpeningBalance(db: DataDb, id: number): void {
  const ob = db.select({ fiscalYearId: openingBalances.fiscalYearId }).from(openingBalances).where(eq(openingBalances.id, id)).all()[0]
  if (!ob) return // 既に無い（冪等）
  const fy = db.select({ status: fiscalYears.status }).from(fiscalYears).where(eq(fiscalYears.id, ob.fiscalYearId)).all()[0]
  if (fy?.status !== 'open') throw new Error('open でない会計年度の開始残高は削除できません')
  db.delete(openingBalances).where(eq(openingBalances.id, id)).run()
}
