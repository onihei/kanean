import type { ProrationSettingView, ProrationPostingResult } from '@kanean/shared'
export type { ProrationSettingView, ProrationPostingResult }
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm'
import { type Yen, yen, applyRate } from '@kanean/shared'
import type { DataDb, DataTx } from '../db/router.js'
import { requireAccountIdByName as accountIdByName } from '../db/lookups.js'
import {
  accounts,
  fiscalYears,
  journalEntries,
  journalLines,
  prorationSettings,
  subAccounts,
} from '../db/data/schema.js'

/**
 * 家事按分（accounting-spec §6/§7）。
 * 対象経費科目（＋任意の補助科目）の当期経費計上額に business_ratio を掛け、
 * 残り（家事分）を期末に事業主貸へ振り替える。
 *   家事分 = 経費計上額 × (1 − business_ratio/100)   ※円未満切捨て
 *   借) 事業主貸  家事分  /  貸) 対象経費科目  家事分
 * method='year_end'（期末一括）を実装。source='proration' で再実行時は洗い替え。
 * business_ratio は 0..100（%）で保持（減価償却 business_use_ratio と統一）。
 */

const ownerDrawName = '事業主貸'

/** 当年度の按分設定一覧（科目・補助名つき）。 */
export function listProrationSettings(db: DataDb, fiscalYearId: number): ProrationSettingView[] {
  return db
    .select({
      id: prorationSettings.id,
      accountId: prorationSettings.accountId,
      accountName: accounts.name,
      subAccountId: prorationSettings.subAccountId,
      subAccountName: subAccounts.name,
      businessRatio: prorationSettings.businessRatio,
      method: prorationSettings.method,
      note: prorationSettings.note,
    })
    .from(prorationSettings)
    .innerJoin(accounts, eq(prorationSettings.accountId, accounts.id))
    .leftJoin(subAccounts, eq(prorationSettings.subAccountId, subAccounts.id))
    .where(eq(prorationSettings.fiscalYearId, fiscalYearId))
    .all()
    .map((r) => ({ ...r, subAccountName: r.subAccountId == null ? null : r.subAccountName }))
}

export interface UpsertProrationInput {
  fiscalYearId: number
  accountId: number
  subAccountId?: number | null
  businessRatio: number
  method?: string
  note?: string | null
}

/** 同一（年度・科目・補助）があれば更新、なければ作成。 */
export function upsertProrationSetting(db: DataDb, input: UpsertProrationInput): number {
  if (input.businessRatio < 0 || input.businessRatio > 100) throw new Error('事業利用比率は 0..100')
  const sub = input.subAccountId ?? null
  const existing = db
    .select({ id: prorationSettings.id })
    .from(prorationSettings)
    .where(
      and(
        eq(prorationSettings.fiscalYearId, input.fiscalYearId),
        eq(prorationSettings.accountId, input.accountId),
        sub == null ? isNull(prorationSettings.subAccountId) : eq(prorationSettings.subAccountId, sub),
      ),
    )
    .all()[0]

  if (existing) {
    db.update(prorationSettings)
      .set({ businessRatio: input.businessRatio, method: input.method ?? 'year_end', note: input.note ?? null })
      .where(eq(prorationSettings.id, existing.id))
      .run()
    return existing.id
  }
  return db
    .insert(prorationSettings)
    .values({
      fiscalYearId: input.fiscalYearId,
      accountId: input.accountId,
      subAccountId: sub,
      businessRatio: input.businessRatio,
      method: input.method ?? 'year_end',
      note: input.note ?? null,
    })
    .returning()
    .all()[0].id
}

export function deleteProrationSetting(db: DataDb, id: number): void {
  db.delete(prorationSettings).where(eq(prorationSettings.id, id)).run()
}

/**
 * 対象科目（＋任意補助）の当期経費計上額（confirmed の借方−貸方）。proration 仕訳は洗い替え後に呼ぶ前提。
 * 科目レベル（subAccountId=null）のときは excludeSubAccountIds（補助別設定がある補助）を除外し、二重按分を防ぐ。
 */
function expenseAmount(
  db: DataDb | DataTx,
  fiscalYearId: number,
  accountId: number,
  subAccountId: number | null,
  excludeSubAccountIds: number[] = [],
): Yen {
  const conds = [
    eq(journalEntries.fiscalYearId, fiscalYearId),
    eq(journalEntries.status, 'confirmed'),
    eq(journalLines.accountId, accountId),
  ]
  if (subAccountId != null) {
    conds.push(eq(journalLines.subAccountId, subAccountId))
  } else if (excludeSubAccountIds.length > 0) {
    // 補助なし行 + 別設定で按分しない補助行のみ（NULL NOT IN は NULL になるため明示的に許可）。
    conds.push(or(isNull(journalLines.subAccountId), notInArray(journalLines.subAccountId, excludeSubAccountIds))!)
  }
  const lines = db
    .select({ side: journalLines.side, amount: journalLines.amount })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(and(...conds))
    .all()
  const debit = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)
  const credit = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0)
  return yen(debit - credit)
}

function clearExisting(db: DataDb | DataTx, fiscalYearId: number): void {
  const ids = db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.fiscalYearId, fiscalYearId), eq(journalEntries.source, 'proration')))
    .all()
    .map((e) => e.id)
  if (ids.length > 0) {
    db.delete(journalLines).where(inArray(journalLines.entryId, ids)).run()
    db.delete(journalEntries).where(inArray(journalEntries.id, ids)).run()
  }
}

/** 当年度の家事按分仕訳を起票（洗い替え）。confirmed で計上。 */
export function postProration(db: DataDb, fiscalYearId: number): ProrationPostingResult {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fiscalYearId} が見つかりません`)
  const ownerDrawId = accountIdByName(db, ownerDrawName)

  const settings = listProrationSettings(db, fiscalYearId)
  const now = new Date().toISOString()
  const resultLines: ProrationPostingResult['lines'] = []
  let posted = 0
  let totalHousehold = 0

  // 同一科目に補助別設定がある場合、科目レベル(sub=null)はその補助分を除外して二重按分を防ぐ。
  const subSettingsByAccount = new Map<number, number[]>()
  for (const s of settings) {
    if (s.method === 'year_end' && s.subAccountId != null) {
      const arr = subSettingsByAccount.get(s.accountId) ?? []
      arr.push(s.subAccountId)
      subSettingsByAccount.set(s.accountId, arr)
    }
  }

  // 洗い替え（削除→経費集計→再起票）は全体を原子化する。途中失敗で「既存削除済み・新規は一部だけ」の
  // 部分状態を残さない（rollover/retirement と同方針）。expenseAmount は洗い替え後の残高を見る前提なので
  // 同一トランザクション内で呼ぶ。
  db.transaction((tx) => {
    clearExisting(tx, fiscalYearId)

    for (const s of settings) {
      if (s.method !== 'year_end') continue // each（都度）は取込時按分のため対象外
      const excludeSubs = s.subAccountId == null ? (subSettingsByAccount.get(s.accountId) ?? []) : []
      const gross = expenseAmount(tx, fiscalYearId, s.accountId, s.subAccountId, excludeSubs)
      // 家事分 = 経費 × (100 − 事業%)/100。整数 num/den で桁落ちを避ける（1−0.8=0.199… 回避）。
      const household = applyRate(gross, 100 - s.businessRatio, 100, 'floor')
      resultLines.push({ accountName: s.accountName, subAccountName: s.subAccountName, expenseAmount: gross, householdAmount: household })
      if (household <= 0) continue

      const entry = tx
        .insert(journalEntries)
        .values({
          fiscalYearId,
          entryDate: fy.endDate,
          description: `家事按分 ${s.accountName}${s.subAccountName ? `（${s.subAccountName}）` : ''}`,
          source: 'proration',
          sourceRef: String(s.id),
          status: 'confirmed',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all()[0]

      tx.insert(journalLines).values({ entryId: entry.id, lineNo: 1, side: 'debit', accountId: ownerDrawId, amount: household }).run()
      tx.insert(journalLines)
        .values({ entryId: entry.id, lineNo: 2, side: 'credit', accountId: s.accountId, subAccountId: s.subAccountId, amount: household })
        .run()

      posted++
      totalHousehold += household
    }
  })

  return { posted, lines: resultLines, totalHousehold: yen(totalHousehold) }
}
