import { describe, it, expect } from 'vitest'
import { yen } from '@kanean/shared'
import {
  isBalanced,
  assertBalanced,
  totalBySide,
  normalBalanceForSection,
  resolveNormalBalance,
  accountBalance,
} from '../ledger.js'

describe('貸借一致（§1.1）', () => {
  it('balanced 複合仕訳（源泉徴収の例）', () => {
    // 借) 普通預金 99,790 / 借) 事業主貸 10,210 / 貸) 売上 110,000
    const lines = [
      { side: 'debit' as const, amount: yen(99_790) },
      { side: 'debit' as const, amount: yen(10_210) },
      { side: 'credit' as const, amount: yen(110_000) },
    ]
    expect(isBalanced(lines)).toBe(true)
    expect(totalBySide(lines, 'debit')).toBe(110_000)
    expect(() => assertBalanced(lines)).not.toThrow()
  })

  it('unbalanced は検出・例外', () => {
    const lines = [
      { side: 'debit' as const, amount: yen(100) },
      { side: 'credit' as const, amount: yen(90) },
    ]
    expect(isBalanced(lines)).toBe(false)
    expect(() => assertBalanced(lines)).toThrow()
  })
})

describe('normal_balance（§1.2）', () => {
  it('section から機械的に決定', () => {
    expect(normalBalanceForSection('流動資産')).toBe('debit')
    expect(normalBalanceForSection('固定負債')).toBe('credit')
    expect(normalBalanceForSection('資本')).toBe('credit')
    expect(normalBalanceForSection('売上')).toBe('credit')
    expect(normalBalanceForSection('経費')).toBe('debit')
  })

  it('例外科目（§1.2.1）を優先', () => {
    // 減価償却累計額は資産だが credit
    expect(resolveNormalBalance('固定資産', '減価償却累計額')).toBe('credit')
    // 事業主貸は資本控除だが debit
    expect(resolveNormalBalance('資本', '事業主貸')).toBe('debit')
    // 例外でなければ section 通り
    expect(resolveNormalBalance('固定資産', '工具器具備品')).toBe('debit')
  })
})

describe('残高計算（§1.2 末尾）', () => {
  it('debit科目は 借−貸、credit科目は 貸−借', () => {
    expect(accountBalance('debit', yen(1000), yen(300))).toBe(700)
    expect(accountBalance('credit', yen(300), yen(1000))).toBe(700)
  })
})
