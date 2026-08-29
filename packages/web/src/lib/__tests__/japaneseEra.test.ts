/** 令和表記。官製様式3枚の年分表記の唯一の出所なので、改元境界をここで固定する（issue #134）。 */
import { describe, expect, it } from 'vitest'
import { reiwa } from '../japaneseEra.js'

describe('reiwa', () => {
  it('令和元年=2019（「令和1年」とは書かない）', () => {
    expect(reiwa(2019)).toBe('令和元年')
    expect(reiwa('2019-01-01')).toBe('令和元年')
  })

  it('2020 以降は令和N年', () => {
    expect(reiwa(2020)).toBe('令和2年')
    expect(reiwa('2026-12-31')).toBe('令和8年')
  })

  it('令和より前（2018 以前）は空欄＝様式ヘッダに誤った年分を刷らない', () => {
    expect(reiwa(2018)).toBe('')
    expect(reiwa('2018-12-31')).toBe('')
  })

  it('読めない入力は空欄', () => {
    expect(reiwa('')).toBe('')
    expect(reiwa('unknown')).toBe('')
  })
})
