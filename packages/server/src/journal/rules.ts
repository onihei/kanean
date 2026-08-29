import type { RuleInput, Rule, RuleMatchField, RuleMatchOp, RuleDirection } from '@kanean/shared'
export type { RuleInput }
import { getByIdOrThrow, setActiveById } from '../db/crudHelpers.js'
import { asc, eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { accounts, autoJournalRules, subAccounts, taxCategories } from '../db/data/schema.js'

/**
 * 自動仕訳ルール CRUD（data-model §2.9.1 / roadmap Phase1）。
 * マッチングエンジンは suggest.ts に実装済み（priority 昇順でルール → 履歴）。本モジュールは
 * その入力源 auto_journal_rules を管理する。取込（journalizeBatch）が参照し、相手科目を自動付与する。
 *
 * matchOp:
 * - contains/equals: 文字列一致（matchField=description/source。amount は文字列化して比較）
 * - regex: 正規表現（matchValue は有効な RegExp）
 * - range: 金額レンジ（matchField=amount。matchValue は JSON {min?,max?}）
 * 削除は物理削除（設定データで他テーブルからの参照なし）。一時無効化は is_active。
 */

export type RuleRow = typeof autoJournalRules.$inferSelect

const MATCH_FIELDS = ['description', 'amount', 'source'] as const
const MATCH_OPS = ['contains', 'equals', 'regex', 'range'] as const
const DIRECTIONS = ['in', 'out', 'any'] as const

/** 入力を検証し、永続化する列値（id/is_active/timestamps を除く）へ整形。 */
function buildFields(db: DataDb, input: RuleInput) {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('ルール名は必須です')

  if (!MATCH_FIELDS.includes(input.matchField)) throw new Error('matchField は description / amount / source')
  if (!MATCH_OPS.includes(input.matchOp)) throw new Error('matchOp は contains / equals / regex / range')
  const direction = input.direction ?? 'any'
  if (!DIRECTIONS.includes(direction)) throw new Error('direction は in / out / any')

  const matchValue = (input.matchValue ?? '').trim()
  if (!matchValue) throw new Error('matchValue は必須です')
  if (input.matchOp === 'regex') {
    try {
      new RegExp(matchValue)
    } catch {
      throw new Error(`正規表現が不正です: ${matchValue}`)
    }
  }
  if (input.matchOp === 'range') {
    if (input.matchField !== 'amount') throw new Error('range は matchField=amount のときのみ使用できます')
    let parsed: { min?: number; max?: number }
    try {
      parsed = JSON.parse(matchValue)
    } catch {
      throw new Error('range の matchValue は JSON {"min":number,"max":number} 形式で指定してください')
    }
    const okNum = (v: unknown) => v == null || (typeof v === 'number' && Number.isInteger(v))
    if (!okNum(parsed.min) || !okNum(parsed.max)) throw new Error('range の min/max は整数（円）で指定してください')
    if (parsed.min == null && parsed.max == null) throw new Error('range は min か max の少なくとも一方が必要です')
    if (parsed.min != null && parsed.max != null && parsed.min > parsed.max) throw new Error('range は min ≤ max で指定してください')
  }

  if (input.priority != null && !Number.isSafeInteger(input.priority)) throw new Error('priority は整数で指定してください')

  // 結果（相手科目）の存在・整合。
  const acc = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, input.resultAccountId)).all()[0]
  if (!acc) throw new Error(`勘定科目 ${input.resultAccountId} が見つかりません`)
  if (input.resultSubAccountId != null) {
    const sub = db.select().from(subAccounts).where(eq(subAccounts.id, input.resultSubAccountId)).all()[0]
    if (!sub) throw new Error(`補助科目 ${input.resultSubAccountId} が見つかりません`)
    if (sub.accountId !== input.resultAccountId) throw new Error(`補助科目 ${input.resultSubAccountId} は勘定科目 ${input.resultAccountId} に属しません`)
  }
  if (input.resultTaxCategoryId != null) {
    const tc = db.select({ id: taxCategories.id }).from(taxCategories).where(eq(taxCategories.id, input.resultTaxCategoryId)).all()[0]
    if (!tc) throw new Error(`税区分 ${input.resultTaxCategoryId} が見つかりません`)
  }

  return {
    name,
    priority: input.priority ?? 100,
    matchField: input.matchField,
    matchOp: input.matchOp,
    matchValue,
    direction,
    resultAccountId: input.resultAccountId,
    resultSubAccountId: input.resultSubAccountId ?? null,
    resultTaxCategoryId: input.resultTaxCategoryId ?? null,
  }
}

/** ルール一覧（priority 昇順＝適用順）。既定は有効のみ。 */
export function listRules(db: DataDb, includeInactive = false): Rule[] {
  const base = db.select().from(autoJournalRules)
  const rows = (includeInactive ? base : base.where(eq(autoJournalRules.isActive, true)))
    .orderBy(asc(autoJournalRules.priority), asc(autoJournalRules.id))
    .all()
  // 列挙3列は DB では text（string）。書き込みは buildFields が値域を検証済みなので境界で絞る。
  return rows.map((r) => ({
    ...r,
    matchField: r.matchField as RuleMatchField,
    matchOp: r.matchOp as RuleMatchOp,
    direction: r.direction as RuleDirection,
  }))
}

function getRule(db: DataDb, id: number): RuleRow {
  return getByIdOrThrow(db, autoJournalRules, id, '仕訳ルール')
}

export function createRule(db: DataDb, input: RuleInput): number {
  const fields = buildFields(db, input)
  const now = new Date().toISOString()
  return db
    .insert(autoJournalRules)
    .values({ ...fields, isActive: true, createdAt: now, updatedAt: now })
    .returning()
    .all()[0].id
}

export function updateRule(db: DataDb, id: number, input: RuleInput): void {
  getRule(db, id)
  const fields = buildFields(db, input)
  db.update(autoJournalRules)
    .set({ ...fields, updatedAt: new Date().toISOString() })
    .where(eq(autoJournalRules.id, id))
    .run()
}

export function setRuleActive(db: DataDb, id: number, isActive: boolean): void {
  setActiveById(db, autoJournalRules, id, isActive, '仕訳ルール', { touchUpdatedAt: true })
}

/** ルールを物理削除（設定データ。他テーブルからの FK 参照なし）。 */
export function deleteRule(db: DataDb, id: number): void {
  getRule(db, id)
  db.delete(autoJournalRules).where(eq(autoJournalRules.id, id)).run()
}
