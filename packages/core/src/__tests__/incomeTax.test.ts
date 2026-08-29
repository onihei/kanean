import { describe, it, expect } from 'vitest'
import { yen } from '@kanean/shared'
import { incomeTax, reconstructionSurtax, rewardWithholding, computeIncomeTaxReturn } from '../incomeTax.js'

describe('incomeTax — 所得税の速算表（令和）', () => {
  it('課税所得0以下は0', () => {
    expect(incomeTax(yen(0))).toBe(0)
    expect(incomeTax(yen(-100_000))).toBe(0)
  })

  it('5%区分の上限 1,949,000 → 97,450', () => {
    expect(incomeTax(yen(1_949_000))).toBe(97_450)
  })

  it('10%区分 3,000,000 → 202,500（×0.10 − 97,500）', () => {
    expect(incomeTax(yen(3_000_000))).toBe(202_500)
  })

  it('20%区分の上限 6,949,000 → 962,300（×0.20 − 427,500）', () => {
    expect(incomeTax(yen(6_949_000))).toBe(962_300)
  })

  it('33%区分 10,000,000 → 1,764,000（×0.33 − 1,536,000）', () => {
    expect(incomeTax(yen(10_000_000))).toBe(1_764_000)
  })

  it('45%区分 50,000,000 → 17,704,000（×0.45 − 4,796,000）', () => {
    expect(incomeTax(yen(50_000_000))).toBe(17_704_000)
  })

  it('区分境界: 1,950,000 は10%区分（×0.10 − 97,500 = 97,500）', () => {
    expect(incomeTax(yen(1_950_000))).toBe(97_500)
  })
})

describe('reconstructionSurtax — 復興特別所得税（2.1%）', () => {
  it('基準所得税額 202,500 → 4,252（floor(202,500 × 0.021)）', () => {
    expect(reconstructionSurtax(yen(202_500))).toBe(4_252)
  })
  it('0以下は0', () => {
    expect(reconstructionSurtax(yen(0))).toBe(0)
  })
})

describe('rewardWithholding — 報酬の源泉徴収（10.21% / 20.42%）', () => {
  it('本体10万 → 10,210（×10.21%）', () => {
    expect(rewardWithholding(yen(100_000))).toBe(10_210)
  })
  it('100万ちょうど → 102,100', () => {
    expect(rewardWithholding(yen(1_000_000))).toBe(102_100)
  })
  it('150万 → 204,200（100万×10.21% + 50万×20.42%）', () => {
    expect(rewardWithholding(yen(1_500_000))).toBe(204_200)
  })
  it('200万 → 306,300（100万×10.21% + 100万×20.42%）', () => {
    expect(rewardWithholding(yen(2_000_000))).toBe(306_300)
  })
  it('0以下は0', () => {
    expect(rewardWithholding(yen(0))).toBe(0)
  })
})

describe('computeIncomeTaxReturn — 第一表の数列計算（端数規約・納付/還付分岐のゴールデン）', () => {
  const DEDUCTIONS_BASIC = {
    basicDeduction: 480_000,
    socialInsurance: 0,
    lifeInsurance: 0,
    medical: 0,
    spouseDependents: 0,
    otherDeductions: 0,
  }
  const calc = (totalIncome: number, withholding = 0, estimatedPrepaid = 0) =>
    computeIncomeTaxReturn({
      totalIncome: yen(totalIncome),
      deductions: DEDUCTIONS_BASIC,
      withholding: yen(withholding),
      estimatedPrepaid: yen(estimatedPrepaid),
    })

  it('合計所得200万500円・基礎控除48万 → 課税所得152万（千円未満切捨て）→ 納付77,500（百円未満切捨て）', () => {
    const r = calc(2_000_500)
    expect(r.totalDeductions).toBe(480_000)
    expect(r.taxableIncome).toBe(1_520_000) // 1,520,500 → 千円未満切捨て
    expect(r.baseTax).toBe(76_000) // 5% 区分
    expect(r.surtax).toBe(1_596) // ×2.1%
    expect(r.taxWithSurtax).toBe(77_596)
    expect(r.payableRaw).toBe(77_596)
    expect(r.payable).toBe(77_500) // 百円未満切捨て
    expect(r.refund).toBe(0)
  })

  it('源泉徴収が上回れば還付（payableRaw の絶対額・切捨てなし）', () => {
    const r = calc(2_000_500, 100_000)
    expect(r.payableRaw).toBe(77_596 - 100_000)
    expect(r.payable).toBe(0)
    expect(r.refund).toBe(22_404) // 還付は百円未満切捨てしない
  })

  it('納付/還付の境目: payableRaw=0 は納付0・還付0', () => {
    const r = calc(2_000_500, 77_596)
    expect(r.payableRaw).toBe(0)
    expect(r.payable).toBe(0)
    expect(r.refund).toBe(0)
  })

  it('百円未満切捨ての縁: payableRaw 99 → 納付0 / 100 → 納付100', () => {
    expect(calc(2_000_500, 77_596 - 99).payable).toBe(0)
    expect(calc(2_000_500, 77_596 - 100).payable).toBe(100)
  })

  it('控除が所得を上回れば課税所得0・税額0', () => {
    const r = calc(300_000)
    expect(r.taxableIncome).toBe(0)
    expect(r.baseTax).toBe(0)
    expect(r.taxWithSurtax).toBe(0)
    expect(r.payable).toBe(0)
  })
})
