import { describe, it, expect } from 'vitest'
import { failedOrder, finishEcResult, reconcileOrder, withLineNumbers } from '../core/ecOrder.mjs'

// amazon / rakuten から抽出した EC 注文の突合と結果組み立て。
// 「合わなければ合わせ込まない」（按分・推測をしない）を数式ごとここで固定する。

describe('reconcileOrder', () => {
  it('Σ lineAmount + shipping − pointsUsed == orderTotal で突合OK', () => {
    const r = reconcileOrder({
      lines: [{ lineAmount: 1390 }, { lineAmount: 550 }],
      shipping: 410,
      pointsUsed: 100,
      orderTotal: 2250,
    })
    expect(r).toEqual({ ok: true, sum: 1940 })
  })

  it('合わなければ内訳付きの理由を返す（合わせ込まない）', () => {
    const r = reconcileOrder({
      lines: [{ lineAmount: 1390 }],
      shipping: 0,
      pointsUsed: 0,
      orderTotal: 1500,
    })
    expect(r.ok).toBe(false)
    expect(r.reason).toBe('突合NG: Σline=1390 + shipping=0 − points=0 ≠ total=1500')
  })

  it('1円のズレも許容しない', () => {
    const r = reconcileOrder({ lines: [{ lineAmount: 999 }], shipping: 0, pointsUsed: 0, orderTotal: 1000 })
    expect(r.ok).toBe(false)
  })

  it('明細0行は sum=0 として突合される（total=0 の注文だけ通る）', () => {
    expect(reconcileOrder({ lines: [], shipping: 0, pointsUsed: 0, orderTotal: 0 }).ok).toBe(true)
    expect(reconcileOrder({ lines: [], shipping: 0, pointsUsed: 0, orderTotal: 100 }).ok).toBe(false)
  })
})

describe('withLineNumbers', () => {
  it('1始まりの lineNo と証憑参照を付け、元のフィールドを保つ', () => {
    const lines = [
      { itemName: 'A', quantity: 1, lineAmount: 100 },
      { itemName: 'B', quantity: 2, lineAmount: 200 },
    ]
    expect(withLineNumbers(lines, 'ref-1')).toEqual([
      { lineNo: 1, itemName: 'A', quantity: 1, lineAmount: 100, evidenceRef: 'ref-1' },
      { lineNo: 2, itemName: 'B', quantity: 2, lineAmount: 200, evidenceRef: 'ref-1' },
    ])
  })
})

describe('failedOrder', () => {
  it('要素形を orderId / orderDate / reason に固定する（head の余分なフィールドを漏らさない）', () => {
    // rakuten の head は href を持つ。スプレッドだと出力へ漏れる（旧 amazon 実装の形）。
    const head = { orderId: '123-4567', orderDate: '2026-04-01', href: 'https://example.com/x' }
    expect(failedOrder(head, '突合NG')).toEqual({
      orderId: '123-4567',
      orderDate: '2026-04-01',
      reason: '突合NG',
    })
  })
})

describe('finishEcResult', () => {
  it('失敗が無ければ OK（partial/exitCode は run.mjs が宣言から導出）', () => {
    const logs = []
    const r = finishEcResult([{ orderId: 'a' }, { orderId: 'b' }], [], ['w'], (m) => logs.push(m))
    expect(logs).toEqual(['OK 突合済 2件'])
    expect(r).toEqual({ orders: [{ orderId: 'a' }, { orderId: 'b' }], failedOrders: [], warnings: ['w'] })
  })

  it('失敗があれば PARTIAL と補完対象件数をログに出す（黙って完了扱いにしない）', () => {
    const logs = []
    const failed = [
      { orderId: 'x', orderDate: '2026-04-01', reason: 'r1' },
      { orderId: 'y', orderDate: '2026-04-02', reason: 'r2' },
    ]
    const r = finishEcResult([{ orderId: 'a' }], failed, [], (m) => logs.push(m))
    expect(logs).toEqual(['PARTIAL 突合済 1件 / 要MCP補完 2件'])
    expect(r.failedOrders).toBe(failed)
  })
})
