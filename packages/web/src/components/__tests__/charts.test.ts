/** チャート部品の純関数（スケール・目盛り・棒レイアウト）の境界値テスト。 */
import { describe, expect, it } from 'vitest'
import { axisLabel, barX, barPath, chartScale, niceStep } from '../charts.js'

const TOP = 10
const BOTTOM = 210

describe('niceStep', () => {
  it('1-2-5 系列に丸める', () => {
    expect(niceStep(1)).toBe(1)
    expect(niceStep(3)).toBe(5)
    expect(niceStep(120)).toBe(200)
    expect(niceStep(500000)).toBe(500000)
    expect(niceStep(600000)).toBe(1000000)
  })
  it('0 以下・非数は 1 に退避する', () => {
    expect(niceStep(0)).toBe(1)
    expect(niceStep(-5)).toBe(1)
    expect(niceStep(NaN)).toBe(1)
  })
})

describe('chartScale', () => {
  it('全ゼロ: 0 基線が下端に来て NaN を出さない', () => {
    const s = chartScale([0, 0, 0], TOP, BOTTOM)
    expect(s.min).toBe(0)
    expect(s.max).toBeGreaterThan(0)
    expect(s.zeroY).toBe(BOTTOM)
    expect(s.toY(s.max)).toBe(TOP)
    expect(s.ticks[0]).toBe(0)
    expect(s.ticks.every(Number.isFinite)).toBe(true)
  })

  it('空配列でも有効な座標を返す', () => {
    const s = chartScale([], TOP, BOTTOM)
    expect(s.zeroY).toBe(BOTTOM)
    expect(Number.isFinite(s.toY(0.5))).toBe(true)
  })

  it('負値混在: ドメインが全値と 0 を含み、0 基線が中間に来る', () => {
    const s = chartScale([-500, 1200, 300], TOP, BOTTOM)
    expect(s.min).toBeLessThanOrEqual(-500)
    expect(s.max).toBeGreaterThanOrEqual(1200)
    expect(s.toY(s.min)).toBe(BOTTOM)
    expect(s.toY(s.max)).toBe(TOP)
    expect(s.zeroY).toBeGreaterThan(TOP)
    expect(s.zeroY).toBeLessThan(BOTTOM)
    expect(s.ticks).toContain(0)
    // 昇順・等間隔。
    for (let i = 1; i < s.ticks.length; i++) expect(s.ticks[i]).toBeGreaterThan(s.ticks[i - 1])
  })

  it('単月・正値のみ: 0 基線は下端、値が上に伸びる', () => {
    const s = chartScale([800], TOP, BOTTOM)
    expect(s.min).toBe(0)
    expect(s.zeroY).toBe(BOTTOM)
    expect(s.toY(800)).toBeLessThan(s.zeroY)
    expect(s.ticks).toContain(0)
  })

  it('toY は値に対して単調減少（大きい値ほど上）', () => {
    const s = chartScale([-100, 0, 100], TOP, BOTTOM)
    expect(s.toY(-100)).toBeGreaterThan(s.toY(0))
    expect(s.toY(0)).toBeGreaterThan(s.toY(100))
  })
})

describe('axisLabel', () => {
  it('万・億単位に短縮する', () => {
    expect(axisLabel(0)).toBe('0')
    expect(axisLabel(9999)).toBe('9,999')
    expect(axisLabel(10000)).toBe('1万')
    expect(axisLabel(15000)).toBe('1.5万')
    expect(axisLabel(1200000)).toBe('120万')
    expect(axisLabel(-500000)).toBe('-50万')
    expect(axisLabel(200000000)).toBe('2億')
  })
})

describe('barX', () => {
  it('単月・単系列: 棒はバンド中央・最大 24px 幅', () => {
    const { x, w } = barX(0, 0, 1, 1, 50, 700)
    expect(w).toBeLessThanOrEqual(24)
    expect(x).toBeGreaterThanOrEqual(50)
    expect(x + w).toBeLessThanOrEqual(700)
    expect(x).toBeCloseTo(50 + (650 - w) / 2, 6)
  })

  it('12ヶ月×3系列: 同グループ内で 2px の隙間を保ち重ならない', () => {
    for (let i = 0; i < 12; i++) {
      const a = barX(i, 0, 12, 3, 56, 712)
      const b = barX(i, 1, 12, 3, 56, 712)
      const c = barX(i, 2, 12, 3, 56, 712)
      expect(b.x).toBeCloseTo(a.x + a.w + 2, 6)
      expect(c.x).toBeCloseTo(b.x + b.w + 2, 6)
      // バンド内に収まる。
      const band = (712 - 56) / 12
      expect(a.x).toBeGreaterThanOrEqual(56 + band * i)
      expect(c.x + c.w).toBeLessThanOrEqual(56 + band * (i + 1))
    }
  })

  it('月数 0 でも 0 除算しない', () => {
    const { w } = barX(0, 0, 0, 1, 0, 100)
    expect(Number.isFinite(w)).toBe(true)
  })
})

describe('barPath', () => {
  it('正の棒は基線から上へ、負の棒は基線から下へ閉じたパスを描く', () => {
    const up = barPath(10, 20, 200, 100)
    const down = barPath(10, 20, 100, 180)
    expect(up.startsWith('M10,200')).toBe(true)
    expect(up.endsWith('Z')).toBe(true)
    expect(down.startsWith('M10,100')).toBe(true)
    expect(down.endsWith('Z')).toBe(true)
  })
  it('角丸半径は棒の高さ・幅の半分を超えない（NaN なし）', () => {
    const tiny = barPath(0, 4, 100, 99)
    expect(tiny.includes('NaN')).toBe(false)
  })
})

