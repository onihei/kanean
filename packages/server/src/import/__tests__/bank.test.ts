import { describe, it, expect } from 'vitest'
import { withDedupHashes } from '../types.js'
import { parseBankUfj } from '../parsers/bankUfj.js'
import {
  bankCounterAccountName,
  bankRowToParsedRow,
  parseBankProposal,
  isBankSkillPayload,
  BANK_SKILL_TRACK,
  type BankTxn,
} from '../bank.js'

const txn = (over: Partial<BankTxn> = {}): BankTxn => ({
  txnDate: '2026-05-11',
  amount: 1000,
  direction: 'out',
  description: 'デンキ',
  ...over,
})

describe('bankCounterAccountName', () => {
  it('owner_draw→事業主貸 / owner_contribution→事業主借（決定的・§5.1）', () => {
    expect(bankCounterAccountName({ treatment: 'owner_draw' })).toBe('事業主貸')
    expect(bankCounterAccountName({ treatment: 'owner_contribution' })).toBe('事業主借')
  })
  it('expense/revenue/settlement→proposedAccount（空は未確定勘定）', () => {
    expect(bankCounterAccountName({ treatment: 'expense', proposedAccount: '水道光熱費' })).toBe('水道光熱費')
    expect(bankCounterAccountName({ treatment: 'revenue', proposedAccount: '売掛金' })).toBe('売掛金')
    expect(bankCounterAccountName({ treatment: 'settlement', proposedAccount: '未払金' })).toBe('未払金')
    expect(bankCounterAccountName({ treatment: 'expense' })).toBe('未確定勘定')
  })
  it('unresolved・未指定→未確定勘定（ただし proposedAccount があればそれ）', () => {
    expect(bankCounterAccountName({ treatment: 'unresolved' })).toBe('未確定勘定')
    expect(bankCounterAccountName({})).toBe('未確定勘定')
    expect(bankCounterAccountName({ proposedAccount: '通信費' })).toBe('通信費')
  })
})

describe('bankRowToParsedRow / parseBankProposal', () => {
  it('rawPayload に track と仕訳候補を残し、description は半角正規化', () => {
    const row = bankRowToParsedRow(txn({ description: 'ＡＭＡＺＯＮ', proposedAccount: '消耗品費', treatment: 'expense', reason: 'r', balance: 5000 }))
    expect(row.description).toBe('AMAZON') // 全角→半角
    expect(row.balance).toBe(5000)
    const payload = JSON.parse(row.rawPayload)
    expect(payload.track).toBe(BANK_SKILL_TRACK)
    const prop = parseBankProposal(row.rawPayload)
    expect(prop).toEqual({ proposedAccount: '消耗品費', treatment: 'expense', counterSubAccountRef: undefined })
  })
  it('parseBankProposal は別トラック/壊れた payload を空で返す', () => {
    expect(parseBankProposal(JSON.stringify({ track: 'other', treatment: 'expense' }))).toEqual({})
    expect(parseBankProposal('not json')).toEqual({})
    expect(parseBankProposal(null)).toEqual({})
  })
  it('isBankSkillPayload は track 識別子で判定', () => {
    const row = bankRowToParsedRow(txn())
    expect(isBankSkillPayload(row.rawPayload)).toBe(true)
    expect(isBankSkillPayload(JSON.stringify(['col', 'array']))).toBe(false) // UIトラック parseBankUfj の rawPayload は配列
    expect(isBankSkillPayload(null)).toBe(false)
  })
})

describe('dedup 互換（UI手動CSV取込 parseBankUfj と同一 hash）', () => {
  it('同一の(取引日,金額,方向,摘要)はスキルトラックとUIトラックで dedup_hash が一致＝二重計上しない', () => {
    const csv = '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"\n"2026/5/11","クレジット","","193,945","","37,717,278"'
    const ui = parseBankUfj(csv).rows[0]
    const skill = withDedupHashes([bankRowToParsedRow({ txnDate: '2026-05-11', amount: 193945, direction: 'out', description: 'クレジット', balance: 37717278 })])[0]
    expect(skill.dedupHash).toBe(ui.dedupHash)
  })
})
