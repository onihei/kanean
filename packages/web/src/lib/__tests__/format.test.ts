/** 一覧行の日付整形（会計年度の内外で年の要否が変わる）の境界値テスト。 */
import { describe, expect, it } from 'vitest'
import { inScope, listDate, monthBounds } from '../format.js'

const FY2026 = { startDate: '2026-01-01', endDate: '2026-12-31' }

describe('listDate', () => {
  it('会計年度の範囲内は年を省く', () => {
    expect(listDate('2026-08-14', FY2026)).toBe('08-14')
  })

  it('期首・期末ちょうどは範囲内（境界を含む）', () => {
    expect(listDate('2026-01-01', FY2026)).toBe('01-01')
    expect(listDate('2026-12-31', FY2026)).toBe('12-31')
  })

  it('範囲外は年付きで出す（過年度・翌期とも）', () => {
    expect(listDate('2025-12-31', FY2026)).toBe('2025-12-31')
    expect(listDate('2027-01-01', FY2026)).toBe('2027-01-01')
  })

  it('会計年度が未取得なら省略しない', () => {
    expect(listDate('2026-08-14', null)).toBe('2026-08-14')
  })

  it('暦年でない会計年度でも範囲で判定する', () => {
    const fy = { startDate: '2026-04-01', endDate: '2027-03-31' }
    expect(listDate('2027-03-31', fy)).toBe('03-31')
    expect(listDate('2026-03-31', fy)).toBe('2026-03-31')
  })
})

describe('inScope（表示と操作可否が共有する判定）', () => {
  it('範囲内・境界は真', () => {
    expect(inScope('2026-08-14', FY2026)).toBe(true)
    expect(inScope('2026-01-01', FY2026)).toBe(true)
    expect(inScope('2026-12-31', FY2026)).toBe(true)
  })

  it('過年度・翌期は偽（復帰を無効にする行）', () => {
    expect(inScope('2025-12-31', FY2026)).toBe(false)
    expect(inScope('2027-01-01', FY2026)).toBe(false)
  })

  it('会計年度が未取得なら偽（属すると言い切らない）', () => {
    expect(inScope('2026-08-14', null)).toBe(false)
  })
})

describe('monthBounds', () => {
  it('月初〜月末（大の月・小の月）', () => {
    expect(monthBounds('2026-01')).toEqual({ from: '2026-01-01', to: '2026-01-31' })
    expect(monthBounds('2026-04')).toEqual({ from: '2026-04-01', to: '2026-04-30' })
  })

  it('2月はうるう年で末日が変わる', () => {
    expect(monthBounds('2024-02').to).toBe('2024-02-29')
    expect(monthBounds('2026-02').to).toBe('2026-02-28')
  })
})
