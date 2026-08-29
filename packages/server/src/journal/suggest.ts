/**
 * 取込明細 → 勘定科目のサジェスト（data-model §2.9）。純関数。
 * 優先: (1) ユーザー定義ルール auto_journal_rules（priority昇順）
 *       (2) 履歴学習 mapping_history（hit_count降順）
 * 参照サービスのクラウドMLコーパスは持たないため、この2軸で推測する。
 */

export interface RuleLike {
  priority: number
  matchField: string // description / amount / source
  matchOp: string // contains / equals / regex / range
  matchValue: string
  direction: string // in / out / any
  resultAccountId: number | null
  resultSubAccountId: number | null
  resultTaxCategoryId: number | null
  isActive: boolean
}

export interface HistoryLike {
  sourceType: string
  pattern: string
  accountId: number
  subAccountId: number | null
  taxCategoryId: number | null
  hitCount: number
}

export interface RawLike {
  description: string
  amount: number
  direction: 'in' | 'out'
}

export interface Suggestion {
  accountId: number
  subAccountId: number | null
  taxCategoryId: number | null
  reason: 'rule' | 'history'
}

function fieldValue(field: string, raw: RawLike, sourceType: string): string {
  switch (field) {
    case 'description':
      return raw.description
    case 'amount':
      return String(raw.amount)
    case 'source':
      return sourceType
    default:
      return ''
  }
}

export function matchRule(rule: RuleLike, raw: RawLike, sourceType: string): boolean {
  if (!rule.isActive) return false
  if (rule.direction !== 'any' && rule.direction !== raw.direction) return false
  const value = fieldValue(rule.matchField, raw, sourceType)
  switch (rule.matchOp) {
    case 'contains':
      return value.includes(rule.matchValue)
    case 'equals':
      return value === rule.matchValue
    case 'regex':
      try {
        return new RegExp(rule.matchValue).test(value)
      } catch {
        return false
      }
    case 'range': {
      // matchValue は JSON {min?, max?}（amount 用）
      try {
        const { min, max } = JSON.parse(rule.matchValue) as { min?: number; max?: number }
        const n = raw.amount
        if (min != null && n < min) return false
        if (max != null && n > max) return false
        return true
      } catch {
        return false
      }
    }
    default:
      return false
  }
}

/** ルール → 履歴の順でサジェストを決める。該当なしは null。 */
export function suggest(
  raw: RawLike,
  ctx: { rules: RuleLike[]; history: HistoryLike[]; sourceType: string },
): Suggestion | null {
  const rule = [...ctx.rules]
    .sort((a, b) => a.priority - b.priority)
    .find((r) => r.resultAccountId != null && matchRule(r, raw, ctx.sourceType))
  if (rule && rule.resultAccountId != null) {
    return {
      accountId: rule.resultAccountId,
      subAccountId: rule.resultSubAccountId,
      taxCategoryId: rule.resultTaxCategoryId,
      reason: 'rule',
    }
  }

  const hit = ctx.history
    .filter((h) => h.sourceType === ctx.sourceType && raw.description.includes(h.pattern))
    .sort((a, b) => b.hitCount - a.hitCount)[0]
  if (hit) {
    return {
      accountId: hit.accountId,
      subAccountId: hit.subAccountId,
      taxCategoryId: hit.taxCategoryId,
      reason: 'history',
    }
  }

  return null
}
