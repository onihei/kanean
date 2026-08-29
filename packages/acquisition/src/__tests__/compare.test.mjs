import { describe, it, expect } from 'vitest'
import { diffResults, normalizeEvidenceRef, normalizeResult } from '../core/compare.mjs'

/** 殻A（Playwright）の出力に見立てた最小の結果。 */
function base() {
  return {
    source: 'card_mufg_visa',
    kind: 'card',
    script: 'ufjvisa@3',
    calibration: { source: 'card_mufg_visa', origin: 'bundled', version: 'v1', overridden: [] },
    scrapedAt: '2026-06-13T01:00:00.000Z',
    range: { since: '2026-01-01', until: '2026-06-30' },
    transactions: [
      { txnDate: '2026-03-02', amount: 1280, direction: 'out', description: 'ヨドバシカメラ' },
      { txnDate: '2026-03-05', amount: 4400, direction: 'out', description: 'AMAZON.CO.JP' },
    ],
    warnings: [],
    exitCode: 0,
  }
}

describe('normalizeEvidenceRef', () => {
  it('証跡パスの土台を落とし、/evidence/ より後ろだけ残す', () => {
    // 殻ごとに土台が違うだけで、指しているものは同じ
    const a = '/repo/.kanean/evidence/amazon/249-0000001-0000001'
    const b = '/Users/x/Library/Application Support/Kanean/data/acquisition/evidence/amazon/249-0000001-0000001'
    expect(normalizeEvidenceRef(a)).toBe('amazon/249-0000001-0000001')
    expect(normalizeEvidenceRef(a)).toBe(normalizeEvidenceRef(b))
  })

  it('証跡を取っていないときの URL は触らない（殻によらず同じ値なので）', () => {
    const url = 'https://www.amazon.co.jp/gp/your-account/order-details?orderID=249-1'
    expect(normalizeEvidenceRef(url)).toBe(url)
  })
})

describe('normalizeResult', () => {
  it('scrapedAt と exitCode を比較から外す', () => {
    const n = normalizeResult(base())
    expect(n.scrapedAt).toBeUndefined()
    expect(n.exitCode).toBeUndefined()
    expect(n.transactions).toHaveLength(2)
  })

  it('引数を書き換えない', () => {
    const original = base()
    normalizeResult(original)
    expect(original.scrapedAt).toBe('2026-06-13T01:00:00.000Z')
    expect(original.exitCode).toBe(0)
  })
})

describe('diffResults', () => {
  it('実行時刻と exitCode の違いだけなら一致とみなす', () => {
    const a = base()
    const b = { ...base(), scrapedAt: '2026-06-13T02:30:00.000Z' }
    delete b.exitCode // 殻Bのダンプは exitCode を落としている
    const r = diffResults(a, b)
    expect(r.identical).toBe(true)
    expect(r.differences).toEqual([])
  })

  it('証跡パスの土台違いは差として数えない', () => {
    const withRef = (root) => ({
      ...base(),
      kind: 'ec',
      transactions: undefined,
      orders: [
        {
          orderId: '249-1',
          orderDate: '2026-03-02',
          orderTotal: 1280,
          shipping: 0,
          pointsUsed: 0,
          lines: [{ lineNo: 1, itemName: 'USB ケーブル', quantity: 1, lineAmount: 1280, evidenceRef: `${root}/evidence/amazon/249-1` }],
        },
      ],
    })
    expect(diffResults(withRef('/repo/.kanean'), withRef('/data/acquisition')).identical).toBe(true)
  })

  it('金額が違えば差として場所つきで返す', () => {
    const b = base()
    b.transactions[1].amount = 4500
    const r = diffResults(base(), b)
    expect(r.identical).toBe(false)
    expect(r.differences).toHaveLength(1)
    expect(r.differences[0].path).toBe('transactions[1].amount')
    expect(r.differences[0].a).toBe('4400')
    expect(r.differences[0].b).toBe('4500')
  })

  it('件数が違えば長さと欠けた要素の両方を返す', () => {
    const b = base()
    b.transactions.pop()
    const r = diffResults(base(), b)
    expect(r.differences.map((d) => d.path)).toContain('transactions.length')
    expect(r.differences.some((d) => d.path.startsWith('transactions[1]'))).toBe(true)
  })

  it('較正・範囲の食い違いは明細の差と分けて返す（比較の前提が崩れているため）', () => {
    const b = base()
    b.calibration = { ...b.calibration, origin: 'override', overridden: ['rowSel'] }
    b.range = { since: '2026-02-01', until: '2026-06-30' }
    const r = diffResults(base(), b)
    expect(r.identical).toBe(false)
    expect(r.differences).toEqual([]) // 明細そのものは同じ
    expect(r.context.map((d) => d.path).sort()).toEqual([
      'calibration.origin',
      'calibration.overridden.length',
      'calibration.overridden[0]',
      'range.since',
    ])
  })

  it('片方にしか無いキーも差として出す（partial の取りこぼしを見逃さない）', () => {
    const b = { ...base(), partial: true }
    const r = diffResults(base(), b)
    expect(r.differences).toHaveLength(1)
    expect(r.differences[0].path).toBe('partial')
    expect(r.differences[0].a).toBe('(無し)')
  })
})
