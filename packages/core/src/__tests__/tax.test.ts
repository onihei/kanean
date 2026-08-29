import { describe, it, expect } from 'vitest'
import { yen } from '@kanean/shared'
import { simplifiedTax, nationalTaxOf, DEEMED_PURCHASE_RATE, inclusiveTax, exclusiveTax } from '../tax.js'

describe('simplifiedTax — 簡易課税（第5種・みなし50%）', () => {
  it('課税売上(税抜)1,000万円・10%のみ → 納付50万円', () => {
    // 売上消費税 = 10,000,000×7.8% = 780,000（国税）
    // 控除 = 780,000×50% = 390,000
    // 国税 = 390,000、地方 = 390,000×22/78 = 110,000、合計 = 500,000
    // ＝ 消費税1,000,000 ×(1−0.5)
    const r = simplifiedTax({ category: 5, base: { 10: yen(10_000_000) } })
    expect(r.salesTaxNational).toBe(780_000)
    expect(r.deemedDeduction).toBe(390_000)
    expect(r.national).toBe(390_000)
    expect(r.local).toBe(110_000)
    expect(r.total).toBe(500_000)
  })

  it('みなし仕入率テーブル', () => {
    expect(DEEMED_PURCHASE_RATE[5]).toBe(0.5)
    expect(DEEMED_PURCHASE_RATE[1]).toBe(0.9)
  })

  it('10%・8%混在を合算', () => {
    const r = simplifiedTax({ category: 5, base: { 10: yen(1_000_000), 8: yen(500_000) } })
    // 国税: floor(1,000,000×0.078)=78,000 + floor(500,000×0.0624)=31,200 = 109,200
    expect(r.salesTaxNational).toBe(109_200)
    // 控除 floor(109,200×0.5)=54,600 → 国税 54,600 → 百円未満切捨て 54,600
    expect(r.national).toBe(54_600)
  })

  it('返還・貸倒の国税を控除', () => {
    const r = simplifiedTax({
      category: 5,
      base: { 10: yen(10_000_000) },
      returnsNational: { 10: yen(10_000) },
    })
    // 国税 = 780,000 − 390,000 − 10,000 = 380,000
    expect(r.national).toBe(380_000)
  })
})

describe('inclusiveTax — 税込からの内税逆算（§4.2）', () => {
  it('110,000(10%) → 10,000 / 1,100(10%) → 100', () => {
    expect(inclusiveTax(yen(110_000), 10)).toBe(10_000)
    expect(inclusiveTax(yen(1_100), 10)).toBe(100)
  })
  it('端数は既定 floor（1,078 の8%内税 = 79.85 → 79）', () => {
    expect(inclusiveTax(yen(1_078), 8)).toBe(79) // 1078×8/108
    expect(inclusiveTax(yen(1_078), 8, 'ceil')).toBe(80)
    expect(inclusiveTax(yen(1_078), 8, 'round')).toBe(80)
  })
  it('8%: 10,800 → 800', () => {
    expect(inclusiveTax(yen(10_800), 8)).toBe(800)
  })
  it('率0/負は0', () => {
    expect(inclusiveTax(yen(1_000), 0)).toBe(0)
    expect(inclusiveTax(yen(1_000), -1)).toBe(0)
  })
})

describe('exclusiveTax — 税抜（本体）からの税額（§4.2）', () => {
  it('本体100,000(10%) → 10,000', () => {
    expect(exclusiveTax(yen(100_000), 10)).toBe(10_000)
  })
  it('端数 floor（本体999×10%=99.9→99）', () => {
    expect(exclusiveTax(yen(999), 10)).toBe(99)
  })
})

describe('みなし仕入控除の整数按分（float 乗算の1円ズレ回帰・第3種）', () => {
  // float では floor(90 * 0.7) = 62 / floor(170 * 0.7) = 118 と1円過少になる
  // （0.7 は二進で表現不能）。正値は 90×7/10 = 63 / 170×7/10 = 119。
  it('salesTax 90（第3種）→ 控除 63（float なら 62）', () => {
    // base 1,154 → floor(1,154×0.078) = 90
    const r = simplifiedTax({ category: 3, base: { 10: yen(1_154) } })
    expect(r.salesTaxNational).toBe(90)
    expect(r.deemedDeduction).toBe(63)
  })
  it('salesTax 170（第3種）→ 控除 119（float なら 118）', () => {
    // base 2,180 → floor(2,180×0.078) = 170
    const r = simplifiedTax({ category: 3, base: { 10: yen(2_180) } })
    expect(r.salesTaxNational).toBe(170)
    expect(r.deemedDeduction).toBe(119)
  })
})

describe('nationalTaxOf と税率別内訳（付表4-3/5-3 の単一真実源）', () => {
  it('端数が実際に出るフィクスチャで floor を固定（8%: 1,111,000×6.24% = 69,326.4 → 69,326）', () => {
    // 丸い数のフィクスチャでは丸め規約の変更を検知できないため、端数の出る値で固定する。
    expect(nationalTaxOf(yen(1_111_000), 8)).toBe(69_326)
    expect(nationalTaxOf(yen(1_153_000), 10)).toBe(89_934) // 割り切れる（端数なし）
    expect(nationalTaxOf(yen(999), 10)).toBe(77) // 非千円単位（返還等対価の換算）999×7.8% = 77.922
  })

  it('salesTaxNationalByRate の合計 = salesTaxNational（混在税率）', () => {
    const r = simplifiedTax({ category: 5, base: { 10: yen(1_153_000), 8: yen(1_111_000) } })
    expect(r.salesTaxNationalByRate[10]).toBe(89_934)
    expect(r.salesTaxNationalByRate[8]).toBe(69_326)
    expect(r.salesTaxNational).toBe(89_934 + 69_326)
  })
})
