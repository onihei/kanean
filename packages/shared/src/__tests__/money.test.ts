import { describe, it, expect } from 'vitest'
import { yen, applyRate, rateFraction } from '../money.js'

describe('money (Yen)', () => {
  it('rejects non-integer yen', () => {
    expect(() => yen(1.5)).toThrow(RangeError)
  })

  describe('applyRate（整数 num/den 按分・桁落ちしない）', () => {
    it('家事按分 80%: 50,000 × 20/100 = 10,000（float 比率 1-0.8=0.199… の桁落ちなら 9,999）', () => {
      expect(applyRate(yen(50000), 20, 100, 'floor')).toBe(10000)
    })

    it('端数を余りで丸める（floor/ceil/round）', () => {
      expect(applyRate(yen(1001), 1, 2, 'floor')).toBe(500)
      expect(applyRate(yen(1001), 1, 2, 'ceil')).toBe(501)
      expect(applyRate(yen(1001), 1, 2, 'round')).toBe(501)
      expect(applyRate(yen(1000), 1, 2, 'round')).toBe(500) // 端数なし
    })

    it('round は半数で切上げ（r*2 >= den）', () => {
      expect(applyRate(yen(5), 1, 2, 'round')).toBe(3) // 2.5 → 3
      expect(applyRate(yen(5), 1, 4, 'round')).toBe(1) // 1.25 → 1
    })

    it('比率 0 / 全額', () => {
      expect(applyRate(yen(12345), 0, 100)).toBe(0)
      expect(applyRate(yen(12345), 100, 100)).toBe(12345)
    })

    it('大きい金額でも桁落ちしない（floor）', () => {
      expect(applyRate(yen(99999), 60, 100, 'floor')).toBe(59999) // 99,999×0.6=59,999.4
    })

    it('非整数 num/den・den<=0 を拒否', () => {
      expect(() => applyRate(yen(100), 1.5, 100)).toThrow(RangeError)
      expect(() => applyRate(yen(100), 1, 0)).toThrow(RangeError)
    })
  })
})

describe('rateFraction（公示率 → 整数分数）', () => {
  it('最小の正確な分母を選ぶ', () => {
    expect(rateFraction(1.0)).toEqual({ num: 1, den: 1 })
    expect(rateFraction(0.5)).toEqual({ num: 5, den: 10 })
    expect(rateFraction(0.143)).toEqual({ num: 143, den: 1000 }) // 定額法・耐用7年
    expect(rateFraction(0.0868)).toEqual({ num: 868, den: 10000 }) // 定率法・保証率（4桁）
    expect(rateFraction(0.04854)).toEqual({ num: 4854, den: 100000 }) // 定率法・保証率（5桁）
    expect(rateFraction(0)).toEqual({ num: 0, den: 1 })
  })
  it('5桁で表現できない率・負・非有限は拒否（黙って近似しない）', () => {
    expect(() => rateFraction(0.123456)).toThrow(RangeError)
    expect(() => rateFraction(1 / 3)).toThrow(RangeError)
    expect(() => rateFraction(-0.1)).toThrow(RangeError)
    expect(() => rateFraction(NaN)).toThrow(RangeError)
  })
})
