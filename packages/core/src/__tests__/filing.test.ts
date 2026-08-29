import { describe, it, expect } from 'vitest'
import { yen } from '@kanean/shared'
import type {
  FormBox,
  BlueStatementReport,
  IncomeTaxReturn,
  ConsumptionTaxReturn,
  FilingSheetItem,
} from '@kanean/shared'
import { buildFilingInstructionSheet } from '../filing.js'

/**
 * 入力指示書の射影テスト。
 * 数値は tax-return organ の値をそのまま写す（射影は計算しない）ことを、
 * ゴールデン（マツダ2: 償却439,919/経費219,960/残高1、簡易課税: 国390k/地方110k/合計500k）で固定する。
 */

const mk = (code: string, label: string, box: string | null, amount: number): FormBox => ({
  code,
  label,
  box,
  amount: yen(amount),
})

function fixtureBlueStatement(): BlueStatementReport {
  return {
    pl: {
      sales: mk('AOIRO.PL.SALES', '売上（収入）金額', '①', 11_000_000),
      openStock: mk('AOIRO.PL.OPEN_STOCK', '期首商品（製品）棚卸高', '②', 0),
      purchase: mk('AOIRO.PL.PURCHASE', '仕入金額', '③', 0),
      subtotalCost: mk('AOIRO.PL.SUBTOTAL_COST', '小計', '④', 0),
      closeStock: mk('AOIRO.PL.CLOSE_STOCK', '期末商品（製品）棚卸高', '⑤', 0),
      costOfSales: mk('AOIRO.PL.COST', '差引原価', '⑥', 0),
      grossProfit: mk('AOIRO.PL.GROSS', '差引金額（売上総利益）', '⑦', 11_000_000),
      expenses: [
        mk('AOIRO.PL.EXP_TAX', '租税公課', '⑧', 0), // 0 → 指示書に出ない
        mk('AOIRO.PL.EXP_UTIL', '水道光熱費', '⑩', 120_000),
        mk('AOIRO.PL.EXP_COMM', '通信費', '⑫', 240_000),
        mk('AOIRO.PL.EXP_DEP', '減価償却費', '⑱', 219_960), // A4 から自動計算 → verify
        mk('AOIRO.PL.EXP_BLANK_1', '車両費', '㉕', 55_000),
      ],
      expenseTotal: mk('AOIRO.PL.EXP_TOTAL', '経費計', '㉝', 634_960),
      netBeforeAdjust: mk('AOIRO.PL.NET_BEFORE_ADJ', '差引金額', '㉞', 10_365_040),
      reserveBack: mk('AOIRO.PL.RESERVE_BACK', '貸倒引当金等 繰戻額', null, 0),
      reserveIn: mk('AOIRO.PL.RESERVE_IN', '貸倒引当金等 繰入額', null, 0),
      senju: mk('AOIRO.PL.SENJU', '専従者給与', null, 0),
      incomeBeforeDeduction: mk('AOIRO.PL.INCOME_BEFORE', '青色申告特別控除前の所得金額', '㊸', 10_365_040),
      blueDeduction: mk('AOIRO.PL.BLUE_DEDUCT', '青色申告特別控除額', '㊹', 650_000),
      income: mk('AOIRO.PL.INCOME', '所得金額', '㊺', 9_715_040),
    },
    balanceSheet: {
      assets: [
        { row: 1, opening: yen(100_000), closing: yen(200_000) }, // 現金（固定行・label なし）
        { row: 17, label: '敷金', opening: yen(100_000), closing: yen(100_000) },
      ],
      liabilities: [
        { row: 23, opening: yen(639_920), closing: yen(639_920) }, // 元入金
        { row: 24, opening: yen(0), closing: yen(10_365_040) }, // 控除前所得（自動転記 → verify）
      ],
      incomeBeforeDeduction: yen(10_365_040),
      assetTotal: { opening: yen(200_000), closing: yen(300_000) },
      liabTotal: { opening: yen(639_920), closing: yen(11_004_960) },
      balanced: false,
    },
    summary: {
      incomeBeforeDeduction: yen(10_365_040),
      deductionLimit: yen(650_000),
      deduction: yen(650_000),
      income: yen(9_715_040),
      filingType: 'blue',
      qualifiesFor65: true,
      basis: '複式簿記・e-Tax送信の電子要件を満たす設定',
    },
    monthly: {
      rows: [
        { month: 1, sales: yen(5_000_000), purchases: yen(0) },
        { month: 2, sales: yen(6_000_000), purchases: yen(0) },
      ],
      salesTotal: yen(11_000_000),
      purchasesTotal: yen(0),
    },
    salary: { rows: [], total: yen(0) },
    senju: { rows: [], total: yen(0) },
    rent: { rows: [{ key: 1, name: '大家太郎', amount: yen(240_000) }], total: yen(240_000) },
    depreciation: {
      rows: [
        {
          fixedAssetId: 1,
          managementNo: null,
          name: 'マツダ2',
          quantityOrArea: 1,
          acquiredDate: '2020-03',
          acquisitionCost: yen(2_200_000),
          depreciationMethod: 'straight_line',
          usefulLife: 4,
          depreciationRate: 0.25,
          openingBookValue: yen(439_920),
          depreciationAmount: yen(439_919),
          businessUseRatio: 50,
          businessAmount: yen(219_960),
          closingBookValue: yen(1),
          specialDepreciation: null,
        },
      ],
      depreciationTotal: yen(439_919),
      businessAmountTotal: yen(219_960),
    },
    reserveAllowance: {
      individual: yen(0),
      grossReceivables: yen(0),
      limit: yen(0),
      lumpReserve: yen(0),
      total: yen(0),
      rate: 0.055,
    },
  }
}

function fixtureIncomeTax(): IncomeTaxReturn {
  return {
    businessRevenue: yen(11_000_000),
    businessIncome: yen(9_715_040),
    totalIncome: yen(9_715_040),
    inputs: {
      basicDeduction: 480_000,
      socialInsurance: 800_000,
      lifeInsurance: 40_000,
      medical: 0,
      spouseDependents: 0,
      otherDeductions: 0,
      estimatedPrepaid: 0,
    },
    totalDeductions: yen(1_320_000),
    taxableIncome: yen(8_395_000),
    baseTax: yen(1_294_850),
    surtax: yen(27_191),
    taxWithSurtax: yen(1_322_041),
    withholding: yen(500_000),
    estimatedPrepaid: yen(0),
    payableRaw: yen(822_041),
    payable: yen(822_000),
    refund: yen(0),
    incomeDetail: [
      { counterpartyId: 1, payerName: 'クライアントA', revenue: yen(11_000_000), withholding: yen(500_000) },
    ],
  }
}

/** 簡易課税ゴールデン: 税抜1000万@10% → 国390k/地方110k/合計500k。 */
function fixtureConsumption(): ConsumptionTaxReturn {
  return {
    taxMethod: 'simplified',
    businessCategory: 5,
    deemedRate: 0.5,
    baseRows: [{ rate: 10, taxBase: yen(10_000_000), salesTaxNational: yen(780_000) }],
    taxBaseTotal: yen(10_000_000),
    salesTaxNational: yen(780_000),
    deemedDeduction: yen(390_000),
    returnNational: yen(0),
    badDebtNational: yen(0),
    national: yen(390_000),
    local: yen(110_000),
    midPaid: yen(0),
    payable: yen(500_000),
    applicable: true,
    note: null,
  }
}

function build(overrides?: { consumption?: ConsumptionTaxReturn }) {
  return buildFilingInstructionSheet({
    fiscalYearId: 1,
    year: 2026,
    blueStatement: fixtureBlueStatement(),
    incomeTax: fixtureIncomeTax(),
    consumption: overrides?.consumption ?? fixtureConsumption(),
    consumptionGrossByRate: [{ rate: 10, gross: yen(11_000_000) }],
  })
}

const itemsOf = (sheet: ReturnType<typeof build>, groupId: string): FilingSheetItem[] => {
  const g = sheet.groups.find((x) => x.id === groupId)
  expect(g, `group ${groupId}`).toBeDefined()
  return g!.items
}

const find = (items: FilingSheetItem[], field: string): FilingSheetItem => {
  const item = items.find((i) => i.field === field)
  expect(item, `item ${field}`).toBeDefined()
  return item!
}

describe('buildFilingInstructionSheet — 画面グループの構成', () => {
  it('作成コーナーの画面順（A→B→C）で並ぶ', () => {
    const sheet = build()
    expect(sheet.groups.map((g) => g.id)).toEqual([
      'A1', 'A2', 'A3', 'A4', 'A5', 'A6', 'B1', 'B2', 'B3', 'B4', 'B6', 'C1', 'C2', 'C3', 'C4',
    ])
  })

  it('簡易課税前提が成立しない場合は C 群を含めず checksum の消費税は 0', () => {
    const ct = { ...fixtureConsumption(), applicable: false, taxMethod: 'general' }
    const sheet = build({ consumption: ct })
    expect(sheet.consumptionApplicable).toBe(false)
    expect(sheet.groups.some((g) => g.id.startsWith('C'))).toBe(false)
    expect(sheet.checksum.consumptionNational).toBe(0)
    expect(sheet.checksum.consumptionLocal).toBe(0)
    expect(sheet.checksum.consumptionTotal).toBe(0)
  })
})

describe('buildFilingInstructionSheet — ゴールデン: マツダ2', () => {
  it('減価償却資産の転記項目が organ の値をそのまま持つ（償却439,919/経費219,960/残高1）', () => {
    const a4 = itemsOf(build(), 'A4')
    expect(find(a4, '減価償却資産「マツダ2」 取得価額').value).toBe('2200000')
    expect(find(a4, '減価償却資産「マツダ2」 償却方法').value).toBe('定額法')
    expect(find(a4, '減価償却資産「マツダ2」 事業専用割合').value).toBe('50%')
    const business = find(a4, '減価償却資産「マツダ2」 本年分の必要経費算入額')
    expect(business.kind).toBe('verify')
    expect(business.amount).toBe(219_960)
    expect(find(a4, '減価償却資産「マツダ2」 未償却残高（期末）').amount).toBe(1)
    expect(find(a4, '減価償却費 必要経費算入額 合計（損益⑱）').amount).toBe(219_960)
  })

  it('経費⑱は入力せず verify（A4 から自動計算）・0円の標準行は出さない・空欄行は科目名注記', () => {
    const a3 = itemsOf(build(), 'A3')
    const dep = find(a3, '⑱ 減価償却費')
    expect(dep.kind).toBe('verify')
    expect(dep.amount).toBe(219_960)
    expect(a3.some((i) => i.field.includes('租税公課'))).toBe(false)
    expect(find(a3, '㉕ 車両費').note).toContain('空欄行')
    expect(find(a3, '㉝ 経費計').amount).toBe(634_960)
  })
})

describe('buildFilingInstructionSheet — ゴールデン: 検算ブロック', () => {
  it('所得税の申告納税額と消費税（国390k/地方110k/合計500k）を checksum に持つ', () => {
    const sheet = build()
    expect(sheet.checksum).toEqual({
      incomeTaxPayable: 822_000,
      incomeTaxRefund: 0,
      consumptionNational: 390_000,
      consumptionLocal: 110_000,
      consumptionTotal: 500_000,
    })
  })

  it('B4 は納付/還付を分岐し★検算注記を持つ', () => {
    const b4 = itemsOf(build(), 'B4')
    const pay = find(b4, '納める税金（申告納税額）')
    expect(pay.amount).toBe(822_000)
    expect(pay.note).toContain('★検算')
    expect(b4.some((i) => i.field === '還付される税金')).toBe(false)
  })

  it('C4 は国税・地方・合計の3点に★検算注記を持つ', () => {
    const c4 = itemsOf(build(), 'C4')
    expect(find(c4, '差引税額（国税）').amount).toBe(390_000)
    expect(find(c4, '地方消費税額').amount).toBe(110_000)
    const total = find(c4, '納付税額 合計')
    expect(total.amount).toBe(500_000)
    expect(total.note).toContain('★検算')
  })
})

describe('buildFilingInstructionSheet — tax-return 組成との金額一致', () => {
  it('㊸㊹㊺・㉝・課税所得は organ の FormBox/値と同一（射影は再計算しない）', () => {
    const sheet = build()
    const bs = fixtureBlueStatement()
    const it_ = fixtureIncomeTax()
    const a5 = itemsOf(sheet, 'A5')
    expect(find(a5, '㊸ 青色申告特別控除前の所得金額').amount).toBe(bs.pl.incomeBeforeDeduction.amount)
    expect(find(a5, '㊹ 青色申告特別控除額').amount).toBe(bs.summary.deduction)
    expect(find(a5, '㊺ 所得金額').amount).toBe(bs.summary.income)
    expect(find(itemsOf(sheet, 'B4'), '課税される所得金額').amount).toBe(it_.taxableIncome)
  })

  it('貸借対照表の固定行は様式ラベルへ解決し、控除前所得の行は verify になる', () => {
    const a6 = itemsOf(build(), 'A6')
    expect(find(a6, '資産「現金」期末').amount).toBe(200_000)
    expect(find(a6, '資産「敷金」期首').amount).toBe(100_000)
    const income = find(a6, '負債・資本「青色申告特別控除前の所得金額」期末')
    expect(income.kind).toBe('verify')
    expect(income.amount).toBe(10_365_040)
  })

  it('C2 は税込売上を入力・課税標準額（千円未満切捨て済）を verify で持つ', () => {
    const c2 = itemsOf(build(), 'C2')
    const gross = find(c2, '課税売上高（税込・税率10%）')
    expect(gross.kind).toBe('input')
    expect(gross.amount).toBe(11_000_000)
    const base = find(c2, '課税標準額（税率10%）')
    expect(base.kind).toBe('verify')
    expect(base.amount).toBe(10_000_000)
  })
})
