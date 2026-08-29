import { describe, it, expect } from 'vitest'
import { yen } from '@kanean/shared'
import { ownerCapitalRollforward, blueSpecialDeduction, toOpeningSide, rolloverOpeningBalances } from '../closing.js'

describe('ownerCapitalRollforward — 期末元入金振替（accounting-spec §1.3）', () => {
  it('翌期首元入金 = 前期末元入金 + 当期所得 + 事業主借 − 事業主貸', () => {
    // 前期末元入金 1,000,000 / 当期所得 800,000 / 事業主借 300,000 / 事業主貸 500,000
    // 当期増減 = 800,000 + 300,000 − 500,000 = 600,000
    // 翌期首元入金 = 1,000,000 + 600,000 = 1,600,000
    const r = ownerCapitalRollforward({
      priorMotoire: yen(1_000_000),
      incomeBeforeDeduction: yen(800_000),
      ownerLoan: yen(300_000),
      ownerDraw: yen(500_000),
    })
    expect(r.netChange).toBe(600_000)
    expect(r.nextMotoire).toBe(1_600_000)
  })

  it('当期赤字（控除前所得が負）でも振替は成立する', () => {
    // 前期末 500,000 / 当期所得 −200,000 / 事業主借 0 / 事業主貸 100,000
    // 翌期首 = 500,000 + (−200,000) + 0 − 100,000 = 200,000
    const r = ownerCapitalRollforward({
      priorMotoire: yen(500_000),
      incomeBeforeDeduction: yen(-200_000),
      ownerLoan: yen(0),
      ownerDraw: yen(100_000),
    })
    expect(r.netChange).toBe(-300_000)
    expect(r.nextMotoire).toBe(200_000)
  })

  it('事業主貸借ゼロ・所得ゼロなら元入金は不変', () => {
    const r = ownerCapitalRollforward({
      priorMotoire: yen(1_234_567),
      incomeBeforeDeduction: yen(0),
      ownerLoan: yen(0),
      ownerDraw: yen(0),
    })
    expect(r.nextMotoire).toBe(1_234_567)
  })

  it('内訳をそのまま返す（表示・検算用）', () => {
    const r = ownerCapitalRollforward({
      priorMotoire: yen(10),
      incomeBeforeDeduction: yen(20),
      ownerLoan: yen(5),
      ownerDraw: yen(3),
    })
    expect(r).toMatchObject({
      priorMotoire: 10,
      incomeBeforeDeduction: 20,
      ownerLoan: 5,
      ownerDraw: 3,
      netChange: 22,
      nextMotoire: 32,
    })
  })
})

describe('blueSpecialDeduction — 青色申告特別控除㊹・所得金額㊺', () => {
  const base = { incomeBeforeDeduction: yen(3_000_000), filingType: 'blue', bookkeeping: 'double_entry', qualifiesFor65: true } as const

  it('青色・複式・e-Tax/優良電子帳簿 → 65万円', () => {
    const r = blueSpecialDeduction(base)
    expect(r.limit).toBe(650_000)
    expect(r.deduction).toBe(650_000)
    expect(r.incomeAfter).toBe(2_350_000)
  })

  it('青色・複式・電子要件なし → 55万円', () => {
    const r = blueSpecialDeduction({ ...base, qualifiesFor65: false })
    expect(r.limit).toBe(550_000)
    expect(r.deduction).toBe(550_000)
    expect(r.incomeAfter).toBe(2_450_000)
  })

  it('青色・簡易簿記 → 10万円', () => {
    const r = blueSpecialDeduction({ ...base, bookkeeping: 'simple' })
    expect(r.deduction).toBe(100_000)
    expect(r.incomeAfter).toBe(2_900_000)
  })

  it('白色 → 控除0', () => {
    const r = blueSpecialDeduction({ ...base, filingType: 'white' })
    expect(r.deduction).toBe(0)
    expect(r.incomeAfter).toBe(3_000_000)
  })

  it('控除前所得が控除限度未満なら控除は所得まで（㊺=0）', () => {
    const r = blueSpecialDeduction({ ...base, incomeBeforeDeduction: yen(400_000) })
    expect(r.deduction).toBe(400_000) // min(650,000, 400,000)
    expect(r.incomeAfter).toBe(0)
  })

  it('赤字（控除前所得が負）なら控除0・所得は負のまま', () => {
    const r = blueSpecialDeduction({ ...base, incomeBeforeDeduction: yen(-500_000) })
    expect(r.deduction).toBe(0)
    expect(r.incomeAfter).toBe(-500_000)
  })
})

describe('toOpeningSide — 期末残高→opening_balances (side,amount)', () => {
  it('借方科目・正残高 → (debit, amount)', () => {
    expect(toOpeningSide('debit', yen(1_600_000))).toEqual({ side: 'debit', amount: 1_600_000 })
  })
  it('貸方科目・正残高 → (credit, amount)', () => {
    expect(toOpeningSide('credit', yen(300_000))).toEqual({ side: 'credit', amount: 300_000 })
  })
  it('借方科目・負残高 → (credit, |amount|)（評価勘定等）', () => {
    expect(toOpeningSide('debit', yen(-50_000))).toEqual({ side: 'credit', amount: 50_000 })
  })
  it('貸方科目・負残高 → (debit, |amount|)', () => {
    expect(toOpeningSide('credit', yen(-50_000))).toEqual({ side: 'debit', amount: 50_000 })
  })
  it('減価償却累計額(credit, 正残高) → (credit, amount)', () => {
    expect(toOpeningSide('credit', yen(439_919))).toEqual({ side: 'credit', amount: 439_919 })
  })
})

describe('rolloverOpeningBalances — 翌期 opening_balances 候補生成', () => {
  it('資産負債を繰越し元入金1本を追加。残高0は省略', () => {
    const out = rolloverOpeningBalances({
      assetLiabilityRows: [
        { accountId: 1, normalBalance: 'debit', balance: yen(1_600_000) }, // 普通預金
        { accountId: 2, normalBalance: 'credit', balance: yen(200_000) }, // 買掛金
        { accountId: 3, normalBalance: 'debit', balance: yen(0) }, // 残高0は省略
      ],
      motoireAccountId: 9,
      nextMotoire: yen(1_600_000),
    })
    expect(out).toEqual([
      { accountId: 1, subAccountId: null, side: 'debit', amount: 1_600_000 },
      { accountId: 2, subAccountId: null, side: 'credit', amount: 200_000 },
      { accountId: 9, subAccountId: null, side: 'credit', amount: 1_600_000 },
    ])
  })

  it('nextMotoire が負なら元入金は借方側で1行', () => {
    const out = rolloverOpeningBalances({ assetLiabilityRows: [], motoireAccountId: 9, nextMotoire: yen(-100_000) })
    expect(out).toEqual([{ accountId: 9, subAccountId: null, side: 'debit', amount: 100_000 }])
  })

  it('nextMotoire が0なら元入金行を作らない', () => {
    const out = rolloverOpeningBalances({
      assetLiabilityRows: [{ accountId: 1, normalBalance: 'debit', balance: yen(500) }],
      motoireAccountId: 9,
      nextMotoire: yen(0),
    })
    expect(out).toEqual([{ accountId: 1, subAccountId: null, side: 'debit', amount: 500 }])
  })

  it('補助科目別の内訳行は subAccountId を保持して繰越す（マイナス補助は反対側）', () => {
    const out = rolloverOpeningBalances({
      assetLiabilityRows: [
        // 売掛金: 取引先A 150,000 / 取引先B -50,000（過入金）/ 補助なし 30,000
        { accountId: 4, subAccountId: 11, normalBalance: 'debit', balance: yen(150_000) },
        { accountId: 4, subAccountId: 12, normalBalance: 'debit', balance: yen(-50_000) },
        { accountId: 4, subAccountId: null, normalBalance: 'debit', balance: yen(30_000) },
      ],
      motoireAccountId: 9,
      nextMotoire: yen(130_000),
    })
    expect(out).toEqual([
      { accountId: 4, subAccountId: 11, side: 'debit', amount: 150_000 },
      { accountId: 4, subAccountId: 12, side: 'credit', amount: 50_000 },
      { accountId: 4, subAccountId: null, side: 'debit', amount: 30_000 },
      { accountId: 9, subAccountId: null, side: 'credit', amount: 130_000 },
    ])
  })
})
