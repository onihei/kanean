import { describe, it, expect } from 'vitest'
import { bankColumns, buildBankTxns, verifyAndClamp } from '../core/bankRows.mjs'
import { ScrapeError } from '../core/errors.mjs'

// mufg / shinsei から抽出した銀行明細の正規化・検算。金額に直結する処理なので、
// サイト差分（年ヒント・メモ列・reverse 方針・列の必須条件）を含めてここで固定する。

/** mufg 実サイトの SEL（正規表現部分）に合わせたヘッダ照合。 */
const MUFG_SEL = {
  colDate: '日付|取引日|年月日',
  colOut: '支払|出金|引出',
  colIn: '預|入金',
  colBalance: '残高',
  colDesc: '摘要|取引内容',
}

const SHINSEI_SEL = {
  colDate: '取引日',
  colOut: '出金',
  colIn: '入金',
  colBalance: '残高',
  colDesc: '摘要',
  colMemo: 'メモ',
}

describe('bankColumns', () => {
  it('ヘッダの正規表現照合で列を同定する', () => {
    const ci = bankColumns(['日付', 'お支払い金額', 'お預かり金額', '取引内容', '残高'], MUFG_SEL)
    expect(ci).toEqual({ date: 0, out: 1, in: 2, balance: 4, desc: 3 })
  })

  it('mufg 方式は出金・入金のどちらか一方があればよい', () => {
    const ci = bankColumns(['日付', 'お支払い金額', '取引内容', '残高'], MUFG_SEL)
    expect(ci.out).toBe(1)
    expect(ci.in).toBe(-1)
  })

  it('出金・入金の両方が無ければカラム同定失敗', () => {
    expect(() => bankColumns(['日付', '取引内容', '残高'], MUFG_SEL)).toThrowError(
      /カラム同定失敗/
    )
  })

  it('requireBoth（shinsei）は片方欠けでも失敗にする', () => {
    const header = ['取引日', '摘要', '出金', '残高'] // 入金なし
    expect(() => bankColumns(header, SHINSEI_SEL, { memo: true, requireBoth: true })).toThrowError(
      /カラム同定失敗/
    )
    try {
      bankColumns(header, SHINSEI_SEL, { memo: true, requireBoth: true })
    } catch (e) {
      expect(e).toBeInstanceOf(ScrapeError)
      expect(e.step).toBe('extract-table')
      expect(e.hint).toContain('SEL.col*')
    }
  })

  it('memo 列は同定するが、無くても失敗にはしない', () => {
    const withMemo = bankColumns(['取引日', '摘要', 'メモ', '出金', '入金', '残高'], SHINSEI_SEL, {
      memo: true,
      requireBoth: true,
    })
    expect(withMemo.memo).toBe(2)
    const withoutMemo = bankColumns(['取引日', '摘要', '出金', '入金', '残高'], SHINSEI_SEL, {
      memo: true,
      requireBoth: true,
    })
    expect(withoutMemo.memo).toBe(-1)
  })
})

describe('buildBankTxns', () => {
  const ci = { date: 0, out: 1, in: 2, balance: 3, desc: 4 }

  it('出金・入金を正規化する（見出し・合計行は捨てる）', () => {
    const rawRows = [
      { cells: ['日付', 'お支払い', 'お預かり', '残高', '取引内容'], ci }, // ヘッダ
      { cells: ['2026/4/1', '1,100', '', '98,900', 'カ）デンキ '], ci },
      { cells: ['2026/4/2', '', '50,000', '148,900', '振込 タナカ'], ci },
      { cells: ['合計', '1,100', '50,000', '', ''], ci }, // 日付なし＝合計行
    ]
    expect(buildBankTxns(rawRows)).toEqual([
      { txnDate: '2026-04-01', amount: 1100, direction: 'out', description: 'カ）デンキ', balance: 98900 },
      { txnDate: '2026-04-02', amount: 50000, direction: 'in', description: '振込 タナカ', balance: 148900 },
    ])
  })

  it('yen が null（解釈不能な金額・残高）の行は skip し、値を推測しない（issue #170 の不変条件）', () => {
    const rawRows = [
      { cells: ['2026/4/1', '1,100', '', '98,900', '正常行'], ci },
      { cells: ['2026/4/2', '＊＊＊', '', '97,800', '金額が読めない'], ci }, // yen()=null → skip
      { cells: ['2026/4/3', '500', '', '—', '残高が読めない'], ci }, // balance null → skip
      { cells: ['2026/4/4', '0', '', '98,400', '出入とも0'], ci }, // 金額0はどちらも falsy → skip
    ]
    const txns = buildBankTxns(rawRows)
    expect(txns).toHaveLength(1)
    expect(txns[0].description).toBe('正常行')
    // skip された行は amount に NaN や 0 が混入しない（残高チェーン検算を偽陽性で壊さない）
    expect(txns.every((t) => Number.isInteger(t.amount) && t.amount > 0)).toBe(true)
  })

  it('yearHint: 「YYYY年」見出しから年を引き継ぎ、次の見出しで更新する（年跨ぎ）', () => {
    const rawRows = [
      { cells: ['2025年', '', '', '', ''], ci },
      { cells: ['12/30', '1,000', '', '99,000', 'A'], ci },
      { cells: ['2026年', '', '', '', ''], ci },
      { cells: ['1/5', '', '2,000', '101,000', 'B'], ci },
    ]
    const txns = buildBankTxns(rawRows, { yearHint: true })
    expect(txns.map((t) => t.txnDate)).toEqual(['2025-12-30', '2026-01-05'])
  })

  it('yearHint 無し（shinsei）では年なし日付は捨てられる', () => {
    const rawRows = [{ cells: ['4/10', '1,000', '', '99,000', 'A'], ci }]
    expect(buildBankTxns(rawRows)).toEqual([])
  })

  it('出金列が無い同定結果（ci.out=-1）でも入金だけで成立する', () => {
    const inOnly = { date: 0, out: -1, in: 1, balance: 2, desc: 3 }
    const txns = buildBankTxns([{ cells: ['2026/4/1', '5,000', '105,000', '入金'], ci: inOnly }])
    expect(txns[0]).toMatchObject({ amount: 5000, direction: 'in' })
  })

  it('メモ列（shinsei）は摘要へ空白区切りで連結し、空なら連結しない', () => {
    const withMemo = { date: 0, out: 1, in: 2, balance: 3, desc: 4, memo: 5 }
    const txns = buildBankTxns([
      { cells: ['2026/4/1', '1,000', '', '99,000', '振込', '家賃'], ci: withMemo },
      { cells: ['2026/4/2', '2,000', '', '97,000', 'カード', ''], ci: withMemo },
    ])
    expect(txns[0].description).toBe('振込 家賃')
    expect(txns[1].description).toBe('カード')
  })
})

describe('verifyAndClamp', () => {
  const OPTS = {
    reverse: 'auto',
    chainHint: '並び順（同日内逆順）か抽出漏れを疑う。投入はしない',
    clampSuffix: '。未照会期間は手動CSV等で補完',
  }
  /** 残高チェーンが繋がる古い順の3件（4/1 出金 → 4/2 入金 → 4/2 出金）。 */
  const chained = () => [
    { txnDate: '2026-04-01', amount: 1000, direction: 'out', description: 'A', balance: 99000 },
    { txnDate: '2026-04-02', amount: 5000, direction: 'in', description: 'B', balance: 104000 },
    { txnDate: '2026-04-02', amount: 300, direction: 'out', description: 'C', balance: 103700 },
  ]
  const args = { since: '2026-04-01', until: '2026-04-30' }

  it('0件は「明細0件」で失敗する（0件を成功と取り違えない）', () => {
    expect(() => verifyAndClamp([], args, [], OPTS)).toThrowError(/明細0件/)
  })

  it("reverse:'auto' — 新しい順なら反転して検算する（mufg）", () => {
    const r = verifyAndClamp(chained().reverse(), args, [], OPTS)
    expect(r.txns.map((t) => t.description)).toEqual(['A', 'B', 'C'])
    expect(r.allCount).toBe(3)
  })

  it("reverse:'auto' — 既に古い順ならそのまま", () => {
    const r = verifyAndClamp(chained(), args, [], OPTS)
    expect(r.txns.map((t) => t.description)).toEqual(['A', 'B', 'C'])
  })

  it("reverse:'always' — 常に反転する（shinsei は同日内も逆時系列）", () => {
    const r = verifyAndClamp(chained().reverse(), args, [], { ...OPTS, reverse: 'always' })
    expect(r.txns.map((t) => t.description)).toEqual(['A', 'B', 'C'])
  })

  it("reverse:'always' — 反転後も新しい順なら「表示順の前提が変わった」で失敗する", () => {
    // 古い順の入力を渡すと反転で新しい順になる＝表示順の前提崩れとして検出される
    expect(() =>
      verifyAndClamp(chained(), args, [], { ...OPTS, reverse: 'always' })
    ).toThrowError(/表示順の前提が変わった/)
  })

  it('残高チェーン不連続は期待値・実値付きで失敗し、投入しない', () => {
    const txns = chained()
    txns[2].balance = 103701 // 1円ずらす
    try {
      verifyAndClamp(txns, args, [], OPTS)
      expect.unreachable('チェーン不連続を検出していない')
    } catch (e) {
      expect(e).toBeInstanceOf(ScrapeError)
      expect(e.step).toBe('normalize-verify')
      expect(e.message).toContain('row=2 expected=103700 actual=103701')
      expect(e.hint).toBe(OPTS.chainHint)
    }
  })

  it('期間で絞り、検算は全件に対して行う', () => {
    const r = verifyAndClamp(chained(), { since: '2026-04-02', until: '2026-04-30' }, [], OPTS)
    expect(r.txns.map((t) => t.description)).toEqual(['B', 'C'])
    expect(r.allCount).toBe(3) // 検算対象は期間外を含む全件
  })

  it('最古の表示が要求開始日より新しければ期間クランプを警告する', () => {
    const warnings = []
    verifyAndClamp(chained(), { since: '2026-03-01', until: '2026-04-30' }, warnings, OPTS)
    expect(warnings).toEqual([
      '期間クランプの可能性: 要求開始 2026-03-01 に対し最古表示 2026-04-01。未照会期間は手動CSV等で補完',
    ])
  })

  it('要求開始日から表示があれば警告しない', () => {
    const warnings = []
    verifyAndClamp(chained(), args, warnings, OPTS)
    expect(warnings).toEqual([])
  })
})
