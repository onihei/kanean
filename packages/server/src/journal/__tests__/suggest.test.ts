import { describe, it, expect } from 'vitest'
import { matchRule, suggest, type RuleLike, type HistoryLike } from '../suggest.js'

const baseRule: RuleLike = {
  priority: 100,
  matchField: 'description',
  matchOp: 'contains',
  matchValue: '',
  direction: 'any',
  resultAccountId: 1,
  resultSubAccountId: null,
  resultTaxCategoryId: null,
  isActive: true,
}

describe('matchRule', () => {
  const raw = { description: '東京電力エナジーパートナー', amount: 8000, direction: 'out' as const }

  it('contains / equals / regex', () => {
    expect(matchRule({ ...baseRule, matchOp: 'contains', matchValue: '東京電力' }, raw, 'bank_ufj')).toBe(true)
    expect(matchRule({ ...baseRule, matchOp: 'equals', matchValue: '東京電力' }, raw, 'bank_ufj')).toBe(false)
    expect(matchRule({ ...baseRule, matchOp: 'regex', matchValue: '^東京電力' }, raw, 'bank_ufj')).toBe(true)
  })

  it('range（amount）', () => {
    expect(matchRule({ ...baseRule, matchField: 'amount', matchOp: 'range', matchValue: '{"min":5000,"max":10000}' }, raw, 'x')).toBe(true)
    expect(matchRule({ ...baseRule, matchField: 'amount', matchOp: 'range', matchValue: '{"min":9000}' }, raw, 'x')).toBe(false)
  })

  it('direction / isActive で除外', () => {
    expect(matchRule({ ...baseRule, matchValue: '東京電力', direction: 'in' }, raw, 'x')).toBe(false)
    expect(matchRule({ ...baseRule, matchValue: '東京電力', isActive: false }, raw, 'x')).toBe(false)
  })
})

describe('suggest', () => {
  const raw = { description: 'AMAZON.CO.JP', amount: 3000, direction: 'out' as const }

  it('ルール優先（priority昇順で最初の一致）', () => {
    const rules: RuleLike[] = [
      { ...baseRule, priority: 200, matchValue: 'AMAZON', resultAccountId: 99 },
      { ...baseRule, priority: 10, matchValue: 'AMAZON', resultAccountId: 42, resultTaxCategoryId: 7 },
    ]
    const s = suggest(raw, { rules, history: [], sourceType: 'card_mufg_visa' })
    expect(s).toMatchObject({ accountId: 42, taxCategoryId: 7, reason: 'rule' })
  })

  it('ルール無→履歴（hit_count最大）', () => {
    const history: HistoryLike[] = [
      { sourceType: 'card_mufg_visa', pattern: 'AMAZON', accountId: 5, subAccountId: null, taxCategoryId: null, hitCount: 3 },
      { sourceType: 'card_mufg_visa', pattern: 'AMAZON', accountId: 6, subAccountId: null, taxCategoryId: null, hitCount: 9 },
    ]
    const s = suggest(raw, { rules: [], history, sourceType: 'card_mufg_visa' })
    expect(s).toMatchObject({ accountId: 6, reason: 'history' })
  })

  it('source_type 不一致の履歴は無視', () => {
    const history: HistoryLike[] = [
      { sourceType: 'bank_ufj', pattern: 'AMAZON', accountId: 5, subAccountId: null, taxCategoryId: null, hitCount: 9 },
    ]
    expect(suggest(raw, { rules: [], history, sourceType: 'card_mufg_visa' })).toBeNull()
  })

  it('該当なしは null', () => {
    expect(suggest(raw, { rules: [], history: [], sourceType: 'x' })).toBeNull()
  })
})
