import { describe, it, expect } from 'vitest'
import { tokenizeItemName, lookupEcHistory, type EcHistoryRow } from '../ecClassify.js'

describe('tokenizeItemName', () => {
  it('NFKC正規化＋小文字化（全角→半角・全角空白）', () => {
    expect(tokenizeItemName('ＳａｎＤｉｓｋ　microSDXC')).toEqual(['sandisk', 'microsdxc'])
  })

  it('短すぎるトークン（1文字）は捨て、重複は排除', () => {
    expect(tokenizeItemName('a SD card SD')).toEqual(['sd', 'card'])
  })

  it('作品名はかな＋漢字の連なりで1トークン、数字＋漢字も連結', () => {
    expect(tokenizeItemName('鬼滅の刃 23巻')).toEqual(['鬼滅の刃', '23巻'])
  })

  it('中黒「・」で複合ブランド/作品名を分割', () => {
    expect(tokenizeItemName('ソニー・ミュージック')).toEqual(['ソニー', 'ミュージック'])
  })

  it('単一の漢字/カナ品名は残す（米・卵 等）', () => {
    expect(tokenizeItemName('米')).toEqual(['米'])
    expect(tokenizeItemName('卵 10個')).toEqual(['卵', '10個'])
  })
})

const NOW = '2025-06-01T00:00:00.000Z'

describe('lookupEcHistory', () => {
  const recent: EcHistoryRow = {
    pattern: 'SanDisk Extreme SSD',
    accountId: 11,
    subAccountId: null,
    hitCount: 3,
    lastUsedAt: '2025-05-20',
  }
  const older: EcHistoryRow = {
    pattern: 'SanDisk microSDXC 128GB',
    accountId: 11,
    subAccountId: null,
    hitCount: 10,
    lastUsedAt: '2024-08-01', // 約10か月前（窓内）
  }
  const stale: EcHistoryRow = {
    pattern: 'SanDisk old card',
    accountId: 11,
    subAccountId: null,
    hitCount: 100,
    lastUsedAt: '2023-01-01', // 12か月超（窓外）
  }
  const manga: EcHistoryRow = {
    pattern: '鬼滅の刃 23巻',
    accountId: 45,
    subAccountId: null,
    hitCount: 5,
    lastUsedAt: '2025-05-01',
  }
  const history = [recent, older, stale, manga]

  it('品名なしは空', () => {
    expect(lookupEcHistory(history, [], { now: NOW })).toEqual([])
  })

  it('関連プレフィルタ: 語が重ならない履歴は出さない（漫画はSD検索に出ない）', () => {
    const out = lookupEcHistory(history, ['SanDisk microSDXC 256GB'], { now: NOW })
    expect(out.map((c) => c.pattern)).not.toContain('鬼滅の刃 23巻')
  })

  it('recency窓: 12か月超は hitCount が大きくても除外', () => {
    const out = lookupEcHistory(history, ['SanDisk microSDXC 256GB'], { now: NOW })
    expect(out.map((c) => c.pattern)).not.toContain('SanDisk old card')
  })

  it('recency × hitCount で並ぶ（新しい方が古い高頻度に勝つ）', () => {
    const out = lookupEcHistory(history, ['SanDisk microSDXC 256GB'], { now: NOW })
    expect(out.map((c) => c.pattern)).toEqual(['SanDisk Extreme SSD', 'SanDisk microSDXC 128GB'])
    expect(out[0].score).toBeGreaterThan(out[1].score)
  })

  it('意味マッチ: 別巻の漫画も作品名トークンで関連候補に出る', () => {
    const out = lookupEcHistory(history, ['鬼滅の刃 24巻'], { now: NOW })
    expect(out.map((c) => c.pattern)).toEqual(['鬼滅の刃 23巻'])
    expect(out[0].accountId).toBe(45)
  })

  it('上限K で打ち切る', () => {
    const out = lookupEcHistory(history, ['SanDisk microSDXC 256GB'], { now: NOW, limit: 1 })
    expect(out).toHaveLength(1)
    expect(out[0].pattern).toBe('SanDisk Extreme SSD')
  })

  it('lastUsedAt が null の行は窓外扱いで除外', () => {
    const nullRow: EcHistoryRow = { pattern: 'SanDisk null', accountId: 11, subAccountId: null, hitCount: 9, lastUsedAt: null }
    const out = lookupEcHistory([nullRow], ['SanDisk microSDXC'], { now: NOW })
    expect(out).toEqual([])
  })
})
