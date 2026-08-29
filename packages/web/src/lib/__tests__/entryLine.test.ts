/**
 * 明細行の UI 状態 ⇄ 送信形の変換（issue #134）と貸借集計（issue #131）。
 * 「未選択=0 → 送信時 null」の規約と、3実装で同文だった ready 式をここで固定する。
 */
import { describe, expect, it } from 'vitest'
import { emptyLine, entriesReady, entryTotals, toLineInput, type EntryLine } from '../entryLine.js'

const line = (over: Partial<EntryLine>): EntryLine => ({ ...emptyLine('debit'), accountId: 1, ...over })

describe('emptyLine', () => {
  it('未選択はすべて 0（UI 状態の規約）', () => {
    expect(emptyLine('debit')).toEqual({
      side: 'debit', accountId: 0, amount: 0, subAccountId: 0, counterpartyId: 0, departmentId: 0,
    })
  })
})

describe('toLineInput', () => {
  it('未選択（0）の任意項目は null で送る（0 という ID を発明しない）', () => {
    expect(toLineInput(emptyLine('credit'))).toEqual({
      side: 'credit', accountId: 0, amount: 0, subAccountId: null, counterpartyId: null, departmentId: null,
    })
  })

  it('選択済みの ID はそのまま通す', () => {
    expect(
      toLineInput({ side: 'debit', accountId: 5, amount: 1200, subAccountId: 7, counterpartyId: 3, departmentId: 2 }),
    ).toEqual({ side: 'debit', accountId: 5, amount: 1200, subAccountId: 7, counterpartyId: 3, departmentId: 2 })
  })
})

describe('entryTotals', () => {
  it('借方計・貸方計・差額・一致を返す', () => {
    const r = entryTotals([
      line({ side: 'debit', amount: 1200 }),
      line({ side: 'credit', amount: 1000 }),
      line({ side: 'credit', amount: 200 }),
    ])
    expect(r).toEqual({ debitTotal: 1200, creditTotal: 1200, diff: 0, balanced: true })
  })

  it('0円どうしの一致は balanced にしない（0円の仕訳は組めない）', () => {
    expect(entryTotals([line({ side: 'debit', amount: 0 }), line({ side: 'credit', amount: 0 })]).balanced).toBe(false)
  })

  it('不一致は diff（借方 − 貸方）を返す', () => {
    const r = entryTotals([line({ side: 'debit', amount: 300 }), line({ side: 'credit', amount: 100 })])
    expect(r.balanced).toBe(false)
    expect(r.diff).toBe(200)
  })
})

describe('entriesReady', () => {
  const ok = [line({ side: 'debit', amount: 500 }), line({ side: 'credit', amount: 500 })]

  it('貸借一致・日付あり・全行が科目選択済みで正の整数なら起票できる', () => {
    expect(entriesReady(ok, '2026-04-01')).toBe(true)
  })

  it('日付なし・科目未選択・0円行はそれぞれ不可', () => {
    expect(entriesReady(ok, '')).toBe(false)
    expect(entriesReady([ok[0], line({ side: 'credit', amount: 500, accountId: 0 })], '2026-04-01')).toBe(false)
    expect(
      entriesReady(
        [line({ side: 'debit', amount: 0 }), line({ side: 'credit', amount: 0 })],
        '2026-04-01',
      ),
    ).toBe(false)
  })

  it('小数は不可（円は整数。入力側 yenOrZero が守るが、最終ゲートもここで固定）', () => {
    expect(
      entriesReady(
        [line({ side: 'debit', amount: 500.5 }), line({ side: 'credit', amount: 500.5 })],
        '2026-04-01',
      ),
    ).toBe(false)
  })
})
