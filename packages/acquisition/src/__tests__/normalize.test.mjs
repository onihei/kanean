import { describe, it, expect } from 'vitest'
import { yen, isoDate } from '../core/normalize.mjs'
import { verifyBalanceChain } from '../core/verify.mjs'

describe('yen', () => {
  it('円記号・カンマ・全角を落として整数にする', () => {
    expect(yen('￥1,234')).toBe(1234)
    expect(yen('1,234円')).toBe(1234)
    expect(yen('１２３４')).toBe(1234)
    expect(yen('0')).toBe(0)
  })

  it('マイナス表記（▲△−－-）を負数として読む', () => {
    for (const s of ['-1,234', '▲1,234', '△1,234', '−1,234', '－1,234']) {
      expect(yen(s)).toBe(-1234)
    }
  })

  it('解釈できないものは null（推測で値を作らない）', () => {
    expect(yen('送料無料')).toBeNull()
    expect(yen('')).toBeNull()
    expect(yen(null)).toBeNull()
    expect(yen('1.5')).toBeNull() // 円は整数。小数は解釈しない
  })
})

describe('isoDate', () => {
  it('よくある表記を ISO へ寄せる', () => {
    expect(isoDate('2026/1/5')).toBe('2026-01-05')
    expect(isoDate('2026-01-05')).toBe('2026-01-05')
    expect(isoDate('2026年1月5日')).toBe('2026-01-05')
  })

  it('年が無い表記は yearHint で補完する（MUFG の "4/10" 形式）', () => {
    expect(isoDate('4/10', 2026)).toBe('2026-04-10')
    expect(isoDate('4/10')).toBeNull() // ヒント無しでは作らない
  })

  it('ありえない月日は null', () => {
    expect(isoDate('2026/13/1')).toBeNull()
    expect(isoDate('2026/1/32')).toBeNull()
  })
})

describe('verifyBalanceChain', () => {
  const chain = [
    { amount: 1000, direction: 'in', balance: 11000 },
    { amount: 300, direction: 'out', balance: 10700 },
    { amount: 700, direction: 'in', balance: 11400 },
  ]

  it('残高が連鎖していれば ok', () => {
    expect(verifyBalanceChain(chain)).toEqual({ ok: true })
  })

  it('崩れた位置と期待値を返す（投入しない判断の根拠になる）', () => {
    const broken = structuredClone(chain)
    broken[2].balance = 99999
    const r = verifyBalanceChain(broken)
    expect(r.ok).toBe(false)
    expect(r.index).toBe(2)
    expect(r.expected).toBe(11400)
    expect(r.actual).toBe(99999)
  })

  it('1件以下は常に ok（比較対象が無い）', () => {
    expect(verifyBalanceChain([]).ok).toBe(true)
    expect(verifyBalanceChain([chain[0]]).ok).toBe(true)
  })
})
