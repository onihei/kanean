import { describe, it, expect } from 'vitest'
import { yen } from '@kanean/shared'
import { annualizeIncome, estimateResidentTax, estimateBusinessTax } from '../forecast.js'

describe('annualizeIncome — 期中実績の年換算（×12/経過月・floor）', () => {
  it('6ヶ月で300万 → 600万（×2）', () => {
    expect(annualizeIncome(yen(3_000_000), 6)).toBe(6_000_000)
  })

  it('12ヶ月は恒等（×12/12）', () => {
    expect(annualizeIncome(yen(4_450_000), 12)).toBe(4_450_000)
  })

  it('端数は floor（100万×12/7 = 1,714,285.71… → 1,714,285）', () => {
    expect(annualizeIncome(yen(1_000_000), 7)).toBe(1_714_285)
  })

  it('0円は0・赤字（負値）もそのまま年換算する', () => {
    expect(annualizeIncome(yen(0), 3)).toBe(0)
    expect(annualizeIncome(yen(-300_000), 6)).toBe(-600_000)
  })

  it('経過月 0・12超・非整数は RangeError（黙って入力どおり返さない）', () => {
    expect(() => annualizeIncome(yen(1_000_000), 0)).toThrow(RangeError)
    expect(() => annualizeIncome(yen(1_000_000), 13)).toThrow(RangeError)
    expect(() => annualizeIncome(yen(1_000_000), 6.5)).toThrow(RangeError)
    expect(() => annualizeIncome(yen(1_000_000), -1)).toThrow(RangeError)
  })
})

describe('estimateResidentTax — 住民税概算（所得割10%＋均等割5,000円）', () => {
  it('課税所得100万 → 105,000（100,000＋5,000）', () => {
    expect(estimateResidentTax(yen(1_000_000))).toBe(105_000)
  })

  it('課税所得0以下は0（均等割も課さない＝非課税とみなす）', () => {
    expect(estimateResidentTax(yen(0))).toBe(0)
    expect(estimateResidentTax(yen(-500_000))).toBe(0)
  })

  it('所得割の端数は floor（1,005円 → 100円＋均等割 = 5,100）', () => {
    expect(estimateResidentTax(yen(1_005))).toBe(5_100)
  })

  it('課税所得1円でも均等割は付く（floor(0.1)=0 ＋ 5,000）', () => {
    expect(estimateResidentTax(yen(1))).toBe(5_000)
  })
})

describe('estimateBusinessTax — 個人事業税概算（事業主控除290万・既定5%）', () => {
  it('290万ちょうど・以下は0（0円・負値含む）', () => {
    expect(estimateBusinessTax(yen(2_900_000))).toBe(0)
    expect(estimateBusinessTax(yen(0))).toBe(0)
    expect(estimateBusinessTax(yen(-1_000_000))).toBe(0)
  })

  it('290万境界の直上: 2,900,001 → 0（floor(1×5%)）、2,900,020 → 1', () => {
    expect(estimateBusinessTax(yen(2_900_001))).toBe(0)
    expect(estimateBusinessTax(yen(2_900_020))).toBe(1)
  })

  it('390万 → 50,000（(390万−290万)×5%）', () => {
    expect(estimateBusinessTax(yen(3_900_000))).toBe(50_000)
  })

  it('率指定（第3種の一部＝3%）: 390万 → 30,000', () => {
    expect(estimateBusinessTax(yen(3_900_000), 3)).toBe(30_000)
  })

  it('非整数の率は RangeError（applyRate の契約）', () => {
    expect(() => estimateBusinessTax(yen(4_000_000), 0.05)).toThrow(RangeError)
  })
})
