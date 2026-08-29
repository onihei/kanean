import { describe, it, expect } from 'vitest'
import { isInFiscalPeriod, assertInFiscalPeriod, OutOfFiscalPeriodError } from '../fiscalPeriod.js'

const FY = { startDate: '2026-01-01', endDate: '2026-12-31' }

describe('会計期間ゲート（fiscalPeriod）', () => {
  it('範囲内は真', () => {
    expect(isInFiscalPeriod(FY, '2026-08-02')).toBe(true)
  })

  it('期首・期末ちょうどを含む（両端を含む）', () => {
    expect(isInFiscalPeriod(FY, '2026-01-01')).toBe(true)
    expect(isInFiscalPeriod(FY, '2026-12-31')).toBe(true)
  })

  it('前年・翌年は偽（繰越を跨いだ取込明細がここに落ちる）', () => {
    expect(isInFiscalPeriod(FY, '2025-12-31')).toBe(false)
    expect(isInFiscalPeriod(FY, '2027-01-01')).toBe(false)
  })

  it('assert は範囲内なら投げない', () => {
    expect(() => assertInFiscalPeriod(FY, '2026-06-15')).not.toThrow()
  })

  it('assert は範囲外で OutOfFiscalPeriodError（日付と範囲の両方を示す）', () => {
    expect(() => assertInFiscalPeriod(FY, '2025-08-02')).toThrow(OutOfFiscalPeriodError)
    expect(() => assertInFiscalPeriod(FY, '2025-08-02')).toThrow(/2025-08-02.*2026-01-01.*2026-12-31/)
  })

  it('label で主語を差し替えられる', () => {
    expect(() => assertInFiscalPeriod(FY, '2025-08-02', '取込明細の日付')).toThrow(/^取込明細の日付 2025-08-02/)
  })
})
