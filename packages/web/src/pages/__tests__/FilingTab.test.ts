import { describe, expect, it } from 'vitest'
import type { BlueReturnSummary, FilingIssue, FilingRecord, McpLinkStatus } from '../../api.js'
import { aiGuide, needs65Hint, splitIssues } from '../FilingTab.js'

/** 確定申告画面の純関数（web-app spec「確定申告画面」）。 */

const issue = (level: FilingIssue['level'], code: string): FilingIssue => ({
  level,
  code,
  message: code,
  screen: null,
})

describe('splitIssues', () => {
  it('不備と注意に区分する', () => {
    const { blocking, warnings } = splitIssues([
      issue('warning', 'a'),
      issue('blocking', 'b'),
      issue('warning', 'c'),
    ])
    expect(blocking.map((i) => i.code)).toEqual(['b'])
    expect(warnings.map((i) => i.code)).toEqual(['a', 'c'])
  })
})

const status = (over: Partial<McpLinkStatus>): McpLinkStatus =>
  ({ seen: false, lastVersion: null, lastSeenAt: null, bundledVersion: '0.3.0', matches: false, ...over }) as McpLinkStatus

describe('aiGuide', () => {
  it('疎通が観測済みなら定型手順「確定申告の転記」へ誘導する', () => {
    const g = aiGuide(status({ seen: true, matches: true }))
    expect(g.kind).toBe('ready')
    expect(g.text).toContain('確定申告の転記')
    expect(g.text).toContain('あなた自身が行います')
  })

  it('未観測なら「まだ確認できていません」— 導入されていないとは断定しない', () => {
    const g = aiGuide(status({ seen: false }))
    expect(g.kind).toBe('setup')
    expect(g.text).toContain('まだ確認できていません')
    expect(g.text).not.toContain('導入されていません')
  })

  it('状態が取れない（ブラウザ開発時など）も断定せずセットアップ案内に倒す', () => {
    const g = aiGuide(null)
    expect(g.kind).toBe('setup')
    expect(g.text).toContain('手動で転記')
  })

  it('版の不一致は過去の観測として入れ直しを案内する', () => {
    const g = aiGuide(status({ seen: true, matches: false, lastVersion: '0.1.0' }))
    expect(g.kind).toBe('setup')
    expect(g.text).toContain('入れ直し')
  })
})

const record = (over: Partial<FilingRecord>): FilingRecord => ({
  id: 1,
  fiscalYearId: 1,
  taxKind: 'income_tax',
  method: 'corner_etax',
  submittedOn: '2027-03-10',
  receiptNumber: null,
  memo: null,
  createdAt: 'x',
  attachments: [],
  ...over,
})

const summary = (over: Partial<BlueReturnSummary>): BlueReturnSummary =>
  ({
    incomeBeforeDeduction: 0,
    deductionLimit: 550000,
    deduction: 0,
    income: 0,
    filingType: 'blue',
    qualifiesFor65: false,
    basis: '',
    ...over,
  }) as BlueReturnSummary

describe('needs65Hint', () => {
  it('e-Tax 提出（corner_etax × 所得税）の記録があり 65 万未設定なら促す', () => {
    expect(needs65Hint([record({})], summary({}))).toBe(true)
  })
  it('既に 65 万の設定済みなら促さない', () => {
    expect(needs65Hint([record({})], summary({ qualifiesFor65: true }))).toBe(false)
  })
  it('書面提出のみなら促さない', () => {
    expect(needs65Hint([record({ method: 'paper' })], summary({}))).toBe(false)
  })
  it('消費税の記録だけでは促さない（65万は所得税側の控除）', () => {
    expect(needs65Hint([record({ taxKind: 'consumption' })], summary({}))).toBe(false)
  })
  it('白色申告では促さない', () => {
    expect(needs65Hint([record({})], summary({ filingType: 'white' }))).toBe(false)
  })
})
