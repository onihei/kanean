/**
 * 請求書プレビュー合計（issue #134）。
 * 源泉の期待値は core の rewardWithholding（packages/core/src/incomeTax.ts）の
 * ゴールデン値と**同一**にする（1,000,000→102,100 / 1,500,000→204,200）。
 * web→core は依存方向違反なので import せず、この一致で「表示と保存値がずれない」を担保する。
 */
import { describe, expect, it } from 'vitest'
import { previewTotals } from '../documentTotals.js'
import type { DocumentLine } from '../../api.js'

const line = (over: Partial<DocumentLine>): DocumentLine => ({
  description: '', amount: 0, taxRate: 10, withholding: false, ...over,
})

describe('previewTotals', () => {
  it('税率別に floor で消費税を出し、小計＋税＝合計', () => {
    const r = previewTotals([
      line({ amount: 10005, taxRate: 10 }),
      line({ amount: 1001, taxRate: 8 }),
      line({ amount: 500, taxRate: 0 }),
    ])
    expect(r.subtotal).toBe(11506)
    expect(r.taxTotal).toBe(1000 + 80) // floor(10005*10/100)=1000, floor(1001*8/100)=80。税率 0 は非課税
    expect(r.total).toBe(11506 + 1080)
    expect(r.withholding).toBe(0)
  })

  it('同一税率は合算してから floor（行ごと floor だと1円ずれる）', () => {
    const r = previewTotals([line({ amount: 105 }), line({ amount: 106 })])
    expect(r.taxTotal).toBe(Math.floor((105 + 106) / 10)) // 21（行ごとなら 10+10=20）
  })

  it('源泉 100万円以下は 10.21%（core rewardWithholding のゴールデンと同値）', () => {
    const r = previewTotals([line({ amount: 1_000_000, withholding: true })])
    expect(r.withholding).toBe(102_100)
  })

  it('源泉 100万円超は超過分 20.42%（同上）', () => {
    const r = previewTotals([line({ amount: 1_500_000, withholding: true })])
    expect(r.withholding).toBe(204_200)
  })

  it('源泉対象行が無ければ 0', () => {
    expect(previewTotals([line({ amount: 50_000 })]).withholding).toBe(0)
  })
})
