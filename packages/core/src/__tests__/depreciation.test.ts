import { describe, it, expect } from 'vitest'
import { yen } from '@kanean/shared'
import {
  depreciationBasis,
  straightLineYear,
  straightLineSchedule,
  straightLineRate,
  lumpSumSchedule,
  minorSpecialYear,
  decliningBalanceRate,
  decliningBalanceYear,
  decliningBalanceSchedule,
  retirementYearDepreciation,
  usedAssetUsefulLife,
  DECLINING_BALANCE_RATES,
  MEMO_VALUE,
} from '../depreciation.js'

describe('straightLineRate (§3 償却率表)', () => {
  it('returns rates by useful life', () => {
    expect(straightLineRate(6)).toBe(0.167) // 普通自動車
    expect(straightLineRate(4)).toBe(0.25) // PC・軽自動車
  })
  it('throws for missing life', () => {
    expect(() => straightLineRate(13)).toThrow(RangeError)
  })
})

describe('straightLineYear — ゴールデン: 参照データ マツダ2（事業50%・最終年）', () => {
  // depreciation-spec §2.5。期首439,920 → 償却439,919 / 経費219,960 / 残高1。
  // 取得価額は実データ 1,508,300。最終年は「取得価額×償却率 ≧ 期首残高−1」で発火し、
  // 償却額は期首残高439,920が支配的（rate は ≧0.292 なら結果不変。耐用年数は確認待ち）。
  const result = straightLineYear({
    acquisitionCost: yen(1_508_300),
    rate: 0.334,
    openingBookValue: yen(439_920),
    businessUseRatio: 50,
  })

  it('本年分償却費（全額）= 439,919（備忘1円を残す）', () => {
    expect(result.depreciationAmount).toBe(439_919)
  })
  it('必要経費算入額 = 219,960（家事分を切捨て、経費＝残り）', () => {
    expect(result.businessAmount).toBe(219_960)
  })
  it('家事分 = 219,959', () => {
    expect(result.householdAmount).toBe(219_959)
  })
  it('期末未償却残高 = 1（備忘価額）', () => {
    expect(result.closingBookValue).toBe(1)
  })
})

describe('straightLineYear — ゴールデン: マツダ2 初年度（中古2年・5ヶ月・事業50%）', () => {
  // 実データ: 取得1,508,300 / 償却率0.5 / 供用5ヶ月 → 償却314,230・経費157,115・残高1,194,070。
  // 月割は円未満切上げ（floor だと314,229で1円ずれる）。
  const first = straightLineYear({
    acquisitionCost: yen(1_508_300),
    rate: 0.5,
    openingBookValue: yen(1_508_300),
    businessUseRatio: 50,
    monthsInService: 5,
  })
  it('本年分償却費 = 314,230（月割・切上げ）', () => {
    expect(first.depreciationAmount).toBe(314_230)
  })
  it('必要経費算入額 = 157,115', () => {
    expect(first.businessAmount).toBe(157_115)
  })
  it('期末未償却残高 = 1,194,070', () => {
    expect(first.closingBookValue).toBe(1_194_070)
  })
})

describe('straightLineSchedule — ゴールデン: マツダ2 全年（取得→備忘1円）', () => {
  // 初年5ヶ月 → 翌年以降12ヶ月。期首1,508,300 → 314,230, 754,150, 754,150, ... → 最終439,919, 残高1。
  const years = straightLineSchedule({
    acquisitionCost: yen(1_508_300),
    rate: 0.5,
    businessUseRatio: 50,
    firstYearMonths: 5,
  })
  it('初年314,230 → 残高1,194,070', () => {
    expect(years[0].depreciationAmount).toBe(314_230)
    expect(years[0].closingBookValue).toBe(1_194_070)
  })
  it('2年目・3年目は満額 754,150', () => {
    expect(years[1].depreciationAmount).toBe(754_150)
    expect(years[1].closingBookValue).toBe(439_920)
    // 最終年（=3年目）: 期首439,920 → 439,919 → 残高1
    expect(years[2].depreciationAmount).toBe(439_919)
    expect(years[2].businessAmount).toBe(219_960)
    expect(years[2].closingBookValue).toBe(1)
  })
  it('全期間で取得価額−1を償却し切る', () => {
    const total = years.reduce((acc, y) => acc + y.depreciationAmount, 0)
    expect(total).toBe(1_508_300 - 1)
  })
})

describe('straightLineYear — 初年度の月割（§2.2）', () => {
  it('7月供用・暦年 → 6/12 で按分、円未満切捨て', () => {
    // 取得価額 600,000 × 0.2 × 6/12 = 60,000
    const r = straightLineYear({
      acquisitionCost: yen(600_000),
      rate: 0.2,
      openingBookValue: yen(600_000),
      businessUseRatio: 100,
      monthsInService: 6,
    })
    expect(r.depreciationAmount).toBe(60_000)
    expect(r.businessAmount).toBe(60_000) // 事業100%
    expect(r.closingBookValue).toBe(540_000)
  })
})

describe('straightLineSchedule — 備忘1円まで償却し切る', () => {
  it('耐用年数5年（rate0.2）・全額償却で最終残高は1円', () => {
    const years = straightLineSchedule({
      acquisitionCost: yen(1_000_000),
      rate: 0.2,
      businessUseRatio: 100,
      firstYearMonths: 12,
    })
    const last = years[years.length - 1]
    expect(last.closingBookValue).toBe(MEMO_VALUE)
    // 償却費合計 = 取得価額 − 備忘1円
    const totalDepreciation = years.reduce((acc, y) => acc + y.depreciationAmount, 0)
    expect(totalDepreciation).toBe(1_000_000 - 1)
  })
})

describe('lumpSumSchedule (一括償却資産・§5)', () => {
  it('割り切れる: 180,000 → 60,000×3年・残高0', () => {
    const years = lumpSumSchedule(yen(180_000))
    expect(years.map((y) => y.depreciationAmount)).toEqual([60_000, 60_000, 60_000])
    expect(years[2].closingBookValue).toBe(0)
  })

  it('割り切れない: 100,000 → 33,333/33,333/33,334（3年目が端数吸収）・合計=取得価額', () => {
    const years = lumpSumSchedule(yen(100_000))
    expect(years.map((y) => y.depreciationAmount)).toEqual([33_333, 33_333, 33_334])
    expect(years.reduce((s, y) => s + y.depreciationAmount, 0)).toBe(100_000)
    expect(years[2].closingBookValue).toBe(0)
  })

  it('按分しない（全額が必要経費・家事分0）', () => {
    const years = lumpSumSchedule(yen(150_000))
    expect(years[0]).toMatchObject({ businessAmount: 50_000, householdAmount: 0 })
  })
})

describe('minorSpecialYear (少額減価償却資産特例・§6)', () => {
  it('取得年に全額即時・残高0（事業100%）', () => {
    const y = minorSpecialYear(yen(250_000), 100)
    expect(y).toMatchObject({ depreciationAmount: 250_000, businessAmount: 250_000, householdAmount: 0, closingBookValue: 0 })
  })

  it('事業利用比率で按分（事業80% → 経費20万・家事5万）', () => {
    const y = minorSpecialYear(yen(250_000), 80)
    expect(y.depreciationAmount).toBe(250_000)
    expect(y.householdAmount).toBe(50_000) // 250,000 × 20%
    expect(y.businessAmount).toBe(200_000)
    expect(y.closingBookValue).toBe(0)
  })
})

describe('decliningBalanceRate (§4 200%定率法 償却率表・国税庁別表第十)', () => {
  it('耐用年数別に 償却率/改定償却率/保証率 を返す', () => {
    // 国税庁タックスアンサー No.2106 の公示値（10年）。
    expect(decliningBalanceRate(10)).toEqual({ rate: 0.2, revisedRate: 0.25, guaranteeRate: 0.06552 })
    expect(decliningBalanceRate(6)).toEqual({ rate: 0.333, revisedRate: 0.334, guaranteeRate: 0.09911 })
    // 償却率は 2/耐用年数 を小数3桁に丸めた値（内部整合）。
    expect(decliningBalanceRate(4).rate).toBe(0.5)
    expect(decliningBalanceRate(8).rate).toBe(0.25)
  })
  it('耐用年数2年は改定償却率・保証率を持たない（償却率1.000）', () => {
    expect(decliningBalanceRate(2)).toEqual({ rate: 1.0, revisedRate: null, guaranteeRate: null })
  })
  it('未収載の耐用年数は RangeError', () => {
    expect(() => decliningBalanceRate(30)).toThrow(RangeError)
  })
  it('表は 2〜20年を網羅し 償却率＝2/n を小数3桁に丸めた値に一致', () => {
    for (let n = 2; n <= 20; n++) {
      const r = DECLINING_BALANCE_RATES[n]
      expect(r, `耐用年数${n}`).toBeDefined()
      expect(r.rate, `耐用年数${n}の償却率`).toBe(Math.round((2 / n) * 1000) / 1000)
    }
  })
})

describe('decliningBalanceSchedule — ゴールデン: 国税庁 No.5410 例（取得100万・耐用10年・事業100%）', () => {
  // 公式の計算例。6年目までは残高×0.200、7年目に償却保証額(65,520)を下回り
  // 改定取得価額262,144×改定償却率0.250=65,536の均等償却へ。最終年に備忘1円。
  const years = decliningBalanceSchedule({
    acquisitionCost: yen(1_000_000),
    rate: 0.2,
    revisedRate: 0.25,
    guaranteeRate: 0.06552,
    businessUseRatio: 100,
    firstYearMonths: 12,
  })
  it('各年の償却費が公式例と一致', () => {
    expect(years.map((y) => y.depreciationAmount)).toEqual([
      200_000, 160_000, 128_000, 102_400, 81_920, 65_536, 65_536, 65_536, 65_536, 65_535,
    ])
  })
  it('改定取得価額への切替後は均等（65,536）・最終年だけ1円分を残す', () => {
    expect(years[6].depreciationAmount).toBe(65_536) // 7年目＝改定開始
    expect(years[9].depreciationAmount).toBe(65_535) // 最終年＝65,536−1
  })
  it('全期間で取得価額−1を償却し切り、最終残高は備忘1円', () => {
    expect(years.reduce((s, y) => s + y.depreciationAmount, 0)).toBe(1_000_000 - 1)
    expect(years[years.length - 1].closingBookValue).toBe(1)
    expect(years.length).toBe(10)
  })
})

describe('decliningBalanceSchedule — 改定償却率1.000 の短期耐用年数（取得100万・耐用4年）', () => {
  // 4年: 償却率0.5/改定1.000/保証0.12499。500k→250k→125k→残額124,999で備忘1円。
  const years = decliningBalanceSchedule({
    acquisitionCost: yen(1_000_000),
    rate: 0.5,
    revisedRate: 1.0,
    guaranteeRate: 0.12499,
    businessUseRatio: 100,
    firstYearMonths: 12,
  })
  it('500,000 / 250,000 / 125,000 / 124,999（最終年）', () => {
    expect(years.map((y) => y.depreciationAmount)).toEqual([500_000, 250_000, 125_000, 124_999])
    expect(years[3].closingBookValue).toBe(1)
  })
})

describe('decliningBalanceYear — 初年度の月割（§2.2・円未満切上げ）', () => {
  it('取得100万・耐用10年・供用5ヶ月 → 200,000×5/12=83,333.33 → 83,334（切上げ）', () => {
    const y = decliningBalanceYear({
      acquisitionCost: yen(1_000_000),
      rate: 0.2,
      revisedRate: 0.25,
      guaranteeRate: 0.06552,
      openingBookValue: yen(1_000_000),
      businessUseRatio: 100,
      monthsInService: 5,
    })
    expect(y.depreciationAmount).toBe(83_334)
    expect(y.closingBookValue).toBe(916_666)
    expect(y.revisedBase).toBeNull() // 初年度は通常フェーズ
  })
})

describe('decliningBalanceYear — 事業利用比率の按分（家事分切捨て・経費＝残り）', () => {
  it('償却費200,000・事業50% → 家事100,000 / 経費100,000（残高は全額で減る）', () => {
    const y = decliningBalanceYear({
      acquisitionCost: yen(1_000_000),
      rate: 0.2,
      revisedRate: 0.25,
      guaranteeRate: 0.06552,
      openingBookValue: yen(1_000_000),
      businessUseRatio: 50,
    })
    expect(y.depreciationAmount).toBe(200_000)
    expect(y.householdAmount).toBe(100_000)
    expect(y.businessAmount).toBe(100_000)
    expect(y.closingBookValue).toBe(800_000)
  })
})

describe('decliningBalanceSchedule — 耐用年数2年（償却率1.000・改定/保証なし）', () => {
  it('満額年は初年に備忘1円まで償却し1年で終了', () => {
    const years = decliningBalanceSchedule({
      acquisitionCost: yen(100_000),
      rate: 1.0,
      revisedRate: null,
      guaranteeRate: null,
      businessUseRatio: 100,
      firstYearMonths: 12,
    })
    expect(years.length).toBe(1)
    expect(years[0].depreciationAmount).toBe(99_999)
    expect(years[0].closingBookValue).toBe(MEMO_VALUE)
  })
})

describe('retirementYearDepreciation — 除却年度の月割償却（§7）', () => {
  it('定額法・取得年に除却（index0・4ヶ月・事業80%）: 50,000×4/12 切上げ=16,667', () => {
    // 器具 取得250,000・耐用5年(rate0.2)・6月供用・9月除却 → 6〜9月=4ヶ月。
    const y = retirementYearDepreciation({
      method: 'straight_line',
      acquisitionCost: yen(250_000),
      rate: 0.2,
      businessUseRatio: 80,
      firstYearMonths: 7,
      retirementYearIndex: 0,
      retirementMonths: 4,
    })
    expect(y).not.toBeNull()
    expect(y!.depreciationAmount).toBe(16_667) // ceil(50,000×4/12)
    expect(y!.householdAmount).toBe(3_333) // floor(16,667×20%)
    expect(y!.businessAmount).toBe(13_334)
    expect(y!.closingBookValue).toBe(233_333)
  })

  it('定額法・翌年以降の期中除却（index1・6ヶ月）: 期首残高から月割', () => {
    // 取得600,000・耐用5年・初年度満額120,000 → 2年目を6ヶ月で除却。
    const y = retirementYearDepreciation({
      method: 'straight_line',
      acquisitionCost: yen(600_000),
      rate: 0.2,
      businessUseRatio: 100,
      firstYearMonths: 12,
      retirementYearIndex: 1,
      retirementMonths: 6,
    })
    expect(y!.depreciationAmount).toBe(60_000) // ceil(120,000×6/12)
    expect(y!.closingBookValue).toBe(420_000) // 480,000(期首) − 60,000
  })

  it('定率法・通常フェーズの期中除却（NTA10年・index2・6ヶ月）: 期首640,000×0.2×6/12', () => {
    const y = retirementYearDepreciation({
      method: 'declining_balance',
      acquisitionCost: yen(1_000_000),
      rate: 0.2,
      revisedRate: 0.25,
      guaranteeRate: 0.06552,
      businessUseRatio: 100,
      firstYearMonths: 12,
      retirementYearIndex: 2,
      retirementMonths: 6,
    })
    expect(y!.depreciationAmount).toBe(64_000) // ceil(128,000×6/12)
    expect(y!.closingBookValue).toBe(576_000)
  })

  it('定率法・改定フェーズの期中除却も月割される（NTA10年・index7・6ヶ月）', () => {
    // index7は改定フェーズ（改定取得価額262,144×0.25=65,536/年）。期首196,608。
    const y = retirementYearDepreciation({
      method: 'declining_balance',
      acquisitionCost: yen(1_000_000),
      rate: 0.2,
      revisedRate: 0.25,
      guaranteeRate: 0.06552,
      businessUseRatio: 100,
      firstYearMonths: 12,
      retirementYearIndex: 7,
      retirementMonths: 6,
    })
    expect(y!.depreciationAmount).toBe(32_768) // ceil(65,536×6/12)
    expect(y!.closingBookValue).toBe(163_840) // 196,608 − 32,768
  })

  it('償却終了後（備忘1円到達後）の年度に除却 → null（当期償却なし）', () => {
    // 耐用2年(rate1.0)は初年に備忘1円。翌年(index1)に除却 → 当期償却なし。
    const y = retirementYearDepreciation({
      method: 'declining_balance',
      acquisitionCost: yen(100_000),
      rate: 1.0,
      revisedRate: null,
      guaranteeRate: null,
      businessUseRatio: 100,
      firstYearMonths: 12,
      retirementYearIndex: 1,
      retirementMonths: 6,
    })
    expect(y).toBeNull()
  })

  it('年度末除却（12ヶ月）は満額年と同じ（切捨て・月割なし）', () => {
    const y = retirementYearDepreciation({
      method: 'straight_line',
      acquisitionCost: yen(600_000),
      rate: 0.2,
      businessUseRatio: 100,
      firstYearMonths: 12,
      retirementYearIndex: 1,
      retirementMonths: 12,
    })
    expect(y!.depreciationAmount).toBe(120_000) // floor(120,000)
  })

  it('入力バリデーション（retirementMonths 範囲・index 負）', () => {
    const base = { method: 'straight_line' as const, acquisitionCost: yen(600_000), rate: 0.2, businessUseRatio: 100, firstYearMonths: 12, retirementYearIndex: 0 }
    expect(() => retirementYearDepreciation({ ...base, retirementMonths: 0 })).toThrow(RangeError)
    expect(() => retirementYearDepreciation({ ...base, retirementMonths: 13 })).toThrow(RangeError)
    expect(() => retirementYearDepreciation({ ...base, retirementYearIndex: -1, retirementMonths: 6 })).toThrow(RangeError)
  })
})

describe('usedAssetUsefulLife — 中古資産の簡便法（耐用年数省令§3・No.5404）', () => {
  it('一部経過: 法定6年(72月)・経過46月 → (72−46)+46×0.2=35.2月 → 2年（マツダ2 相当）', () => {
    expect(usedAssetUsefulLife(6, 46)).toBe(2)
  })
  it('一部経過: 法定10年・経過4年(48月) → 81.6月=6.8年 → 6年（切捨て）', () => {
    expect(usedAssetUsefulLife(10, 48)).toBe(6)
  })
  it('全部経過（経過≧法定）: 法定6年 → 72×0.2=14.4月=1.2年 → 最低2年', () => {
    expect(usedAssetUsefulLife(6, 72)).toBe(2)
    expect(usedAssetUsefulLife(6, 120)).toBe(2) // 大幅超過でも最低2年
  })
  it('全部経過: 法定15年 → 36月=3年', () => {
    expect(usedAssetUsefulLife(15, 180)).toBe(3) // 180×0.2=36月=3年
  })
  it('経過0ヶ月（実質新品）は法定耐用年数を維持', () => {
    expect(usedAssetUsefulLife(6, 0)).toBe(6) // (72−0)+0 = 72月 = 6年
    expect(usedAssetUsefulLife(10, 0)).toBe(10)
  })
  it('結果が1年でも最低2年に切上げ', () => {
    expect(usedAssetUsefulLife(2, 24)).toBe(2) // 24×0.2=4.8月→0年→最低2
  })
  it('入力バリデーション（法定≥1整数・経過≥0整数）', () => {
    expect(() => usedAssetUsefulLife(0, 12)).toThrow(RangeError)
    expect(() => usedAssetUsefulLife(6.5, 12)).toThrow(RangeError)
    expect(() => usedAssetUsefulLife(6, -1)).toThrow(RangeError)
    expect(() => usedAssetUsefulLife(6, 12.5)).toThrow(RangeError)
  })
})

describe('償却率の整数分数化（float 乗算の1円ズレ回帰）', () => {
  // 0.143 / 0.334 / 0.286 は二進で表現不能な公示率。float 乗算は実害が実証済み:
  //   floor(3,000×0.143) = 428（正値 429）/ ceil(100,800×0.334×5/12) = 14,029（正値 14,028）
  //   floor(3,000×0.286) = 857（正値 858）
  it('定額法 floor: 3,000×0.143（耐用7年）= 429（float なら 428 と1円過少）', () => {
    const y = straightLineYear({ acquisitionCost: yen(3_000), rate: 0.143, openingBookValue: yen(3_000), businessUseRatio: 100 })
    expect(y.depreciationAmount).toBe(429)
  })
  it('定額法 月割 ceil: 100,800×0.334×5/12 = 14,028 ちょうど（float なら 14,029 と1円過大償却）', () => {
    // 100,800×334×5 = 168,336,000 は 12,000 で割り切れる（端数なし＝切上げ不発生）。
    const y = straightLineYear({ acquisitionCost: yen(100_800), rate: 0.334, openingBookValue: yen(100_800), businessUseRatio: 100, monthsInService: 5 })
    expect(y.depreciationAmount).toBe(14_028)
  })
  it('定率法 floor: 3,000×0.286（耐用7年）= 858 ちょうど（float なら 857 と1円過少）', () => {
    const y = decliningBalanceYear({
      acquisitionCost: yen(3_000),
      rate: 0.286,
      revisedRate: 0.334,
      guaranteeRate: 0.0868,
      openingBookValue: yen(3_000),
      businessUseRatio: 100,
    })
    expect(y.depreciationAmount).toBe(858)
  })
  it('保証額の境界（調整前償却額 == 償却保証額）は通常フェーズ（BigInt の正確比較）', () => {
    // 期首2,700×0.4 = 1,080 = 取得10,000×0.108。十進では等しい＝「下回らない」ので通常フェーズ。
    // float 同士の比較は両辺の誤差次第で揺れうるため、分母を払った整数比較で固定する。
    const y = decliningBalanceYear({
      acquisitionCost: yen(10_000),
      rate: 0.4,
      revisedRate: 0.5,
      guaranteeRate: 0.108,
      openingBookValue: yen(2_700),
      businessUseRatio: 100,
    })
    expect(y.revisedBase).toBeNull() // 改定フェーズに入らない
    expect(y.depreciationAmount).toBe(1_080)
  })
})

describe('depreciationBasis — ロ償却の基礎になる金額（issue #113）', () => {
  it('定額系＝取得価額 / 定率系＝期首未償却残高', () => {
    expect(depreciationBasis('straight_line', yen(1_000_000), yen(600_000))).toBe(1_000_000)
    expect(depreciationBasis('lump_sum', yen(150_000), yen(100_000))).toBe(150_000)
    expect(depreciationBasis('minor_special', yen(90_000), yen(0))).toBe(90_000)
    expect(depreciationBasis('declining_balance', yen(1_000_000), yen(600_000))).toBe(600_000)
    expect(depreciationBasis('old_declining_balance', yen(1_000_000), yen(600_000))).toBe(600_000)
  })

  it('旧定額法＝取得価額の90%（四捨五入）', () => {
    expect(depreciationBasis('old_straight_line', yen(1_000_000), yen(0))).toBe(900_000)
    expect(depreciationBasis('old_straight_line', yen(999_999), yen(0))).toBe(899_999) // .1 → 切捨て側
    expect(depreciationBasis('old_straight_line', yen(285_715), yen(0))).toBe(257_144) // .5 → 切上げ側
  })

  it('整数分数計算＝float 乗算の誤差を持ち込まない（35×0.9 は二進で 31.4999… に化ける）', () => {
    // Math.round(35 * 0.9) === 31 だが、正しい 31.5 の四捨五入は 32。
    expect(depreciationBasis('old_straight_line', yen(35), yen(0))).toBe(32)
  })

  it('未知の方法は取得価額に倒す（様式を空欄にしない安全側）', () => {
    expect(depreciationBasis('future_method', yen(500_000), yen(300_000))).toBe(500_000)
  })
})
