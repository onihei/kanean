/** 金額入力の正規化（issue #134 で7実装を統一）。円は整数＝解釈規則をここで固定する。 */
import { describe, expect, it } from 'vitest'
import { parseYenInput, yenOrZero } from '../money.js'

describe('parseYenInput', () => {
  it('カンマ・全角数字・円記号を除去して円整数にする', () => {
    expect(parseYenInput('12,000')).toBe(12000)
    expect(parseYenInput('１２３４５')).toBe(12345)
    expect(parseYenInput('¥3,000')).toBe(3000)
    expect(parseYenInput(' 100000 円 ')).toBe(100000)
  })

  it('空は 0、不正（小数・負・文字）は null', () => {
    expect(parseYenInput('')).toBe(0)
    expect(parseYenInput('12.5')).toBeNull()
    expect(parseYenInput('-100')).toBeNull()
    expect(parseYenInput('abc')).toBeNull()
  })

  it('安全整数を超える桁は不正（浮動小数で丸めた値を静かに返さない）', () => {
    expect(parseYenInput('9007199254740993')).toBeNull()
  })
})

describe('yenOrZero', () => {
  it('onChange 用: 不正は 0 に落とす（12.5 を 12 として保存するような静かな丸めをしない）', () => {
    expect(yenOrZero('1,234')).toBe(1234)
    expect(yenOrZero('')).toBe(0)
    expect(yenOrZero('12.5')).toBe(0)
    expect(yenOrZero('-100')).toBe(0)
  })
})
