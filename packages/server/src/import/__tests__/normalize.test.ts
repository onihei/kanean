import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { toHankaku, parseAmount, parseDateIso, decodeBuffer, stripBom } from '../normalize.js'

describe('normalize', () => {
  it('toHankaku: 全角英数記号・スペース', () => {
    expect(toHankaku('１，３３２円')).toBe('1,332円')
    expect(toHankaku('ＥＴＣ　京浜')).toBe('ETC 京浜')
  })

  it('parseAmount: カンマ・全角・空', () => {
    expect(parseAmount('193,945')).toBe(193945)
    expect(parseAmount('１，３３２円')).toBe(1332)
    expect(parseAmount('')).toBe(0)
    expect(parseAmount(null)).toBe(0)
  })

  it('parseDateIso: 3形式', () => {
    expect(parseDateIso('2026/5/11')).toBe('2026-05-11')
    expect(parseDateIso('2026/05/01')).toBe('2026-05-01')
    expect(parseDateIso('2026年6月10日')).toBe('2026-06-10')
    expect(() => parseDateIso('not a date')).toThrow(RangeError)
  })

  it('decodeBuffer: Shift_JIS / UTF-8 BOM', () => {
    const sjis = iconv.encode('日付,摘要', 'Shift_JIS')
    expect(decodeBuffer(sjis, 'shift_jis')).toBe('日付,摘要')
    const bom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from('取引日', 'utf8')])
    expect(decodeBuffer(bom, 'utf8')).toBe('取引日')
  })

  it('stripBom', () => {
    expect(stripBom('﻿取引日')).toBe('取引日')
    expect(stripBom('取引日')).toBe('取引日')
  })
})
