import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { advanceWatermark, getWatermark, nextDay } from '../watermark.js'

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-wm-'))
})
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))

describe('連続して取れている終端', () => {
  it('最初は未記録', () => {
    expect(getWatermark(dir, 'b1', 'bank_ufj')).toBeNull()
  })

  it('取得すれば前進する', () => {
    expect(advanceWatermark(dir, 'b1', 'bank_ufj', { since: '2026-01-01', until: '2026-03-31' })).toBe(true)
    expect(getWatermark(dir, 'b1', 'bank_ufj')).toBe('2026-03-31')
  })

  it('続きから取れば前進する（隙間なし）', () => {
    advanceWatermark(dir, 'b1', 'bank_ufj', { since: '2026-01-01', until: '2026-03-31' })
    expect(advanceWatermark(dir, 'b1', 'bank_ufj', { since: '2026-04-01', until: '2026-06-30' })).toBe(true)
    expect(getWatermark(dir, 'b1', 'bank_ufj')).toBe('2026-06-30')
  })

  it('あいだを飛ばした取得では前進しない（取りこぼしを作らない）', () => {
    advanceWatermark(dir, 'b1', 'bank_ufj', { since: '2026-01-01', until: '2026-03-31' })
    expect(advanceWatermark(dir, 'b1', 'bank_ufj', { since: '2026-06-01', until: '2026-06-30' })).toBe(false)
    expect(getWatermark(dir, 'b1', 'bank_ufj')).toBe('2026-03-31') // 4〜5月が次回の対象として残る
  })

  it('重なる範囲の取り直しでは後退しない', () => {
    advanceWatermark(dir, 'b1', 'bank_ufj', { since: '2026-01-01', until: '2026-06-30' })
    expect(advanceWatermark(dir, 'b1', 'bank_ufj', { since: '2026-01-01', until: '2026-03-31' })).toBe(false)
    expect(getWatermark(dir, 'b1', 'bank_ufj')).toBe('2026-06-30')
  })

  it('帳簿と連携サービスごとに独立している', () => {
    advanceWatermark(dir, 'b1', 'bank_ufj', { since: '2026-01-01', until: '2026-03-31' })
    expect(getWatermark(dir, 'b2', 'bank_ufj')).toBeNull()
    expect(getWatermark(dir, 'b1', 'amazon')).toBeNull()
  })

  it('記録が壊れていたら「まだ何も取れていない」に倒す（前進しすぎない）', () => {
    fs.mkdirSync(path.join(dir, 'acquisition'), { recursive: true })
    fs.writeFileSync(path.join(dir, 'acquisition', 'watermarks.json'), 'これは JSON ではない')
    expect(getWatermark(dir, 'b1', 'bank_ufj')).toBeNull()
  })
})

describe('nextDay', () => {
  it('月・年をまたぐ', () => {
    expect(nextDay('2026-01-31')).toBe('2026-02-01')
    expect(nextDay('2026-12-31')).toBe('2027-01-01')
    expect(nextDay('2028-02-28')).toBe('2028-02-29') // 閏年
  })
})
