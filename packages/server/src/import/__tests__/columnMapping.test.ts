import { describe, it, expect } from 'vitest'
import {
  parseWithMapping,
  validateColumnMappingConfig,
  ColumnMappingError,
  type ColumnMappingConfig,
} from '../columnMapping.js'
import { parseBuffer } from '../dispatch.js'
import { customFormatId, customSourceType } from '../types.js'

/** split（出金/入金別列）型: 新生銀行と同型の列構成。 */
const splitConfig: ColumnMappingConfig = {
  encoding: 'utf8',
  headerRows: 1,
  dateCol: 0,
  descCols: [1, 5],
  amount: { mode: 'split', paidCol: 2, receivedCol: 3 },
  balanceCol: 4,
  defaultAccountName: '普通預金',
}

describe('汎用列マッピング parseWithMapping（Phase3 対応フォーマット拡充）', () => {
  it('split モード: 出金/入金を別列から方向判定し、残高・摘要連結も取る', () => {
    const csv = [
      '"取引日","摘要","出金金額","入金金額","残高","メモ"',
      '"2026/05/01","地方税","35","","2916330","住民税"',
      '"2026/05/01","税引前利息","","718","2916474",""',
    ].join('\n')
    const { rows, errors } = parseWithMapping(splitConfig, csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ txnDate: '2026-05-01', amount: 35, direction: 'out', description: '地方税 住民税', balance: 2916330 })
    expect(rows[1]).toMatchObject({ txnDate: '2026-05-01', amount: 718, direction: 'in', description: '税引前利息', balance: 2916474 })
  })

  it('signed モード: 符号付き1列（負=出金 / 正=入金）', () => {
    const config: ColumnMappingConfig = {
      encoding: 'utf8',
      headerRows: 1,
      dateCol: 0,
      descCols: [1],
      amount: { mode: 'signed', amountCol: 2 },
    }
    const csv = ['date,desc,amount', '2026/05/01,引落,-1000', '2026/05/02,入金,2000'].join('\n')
    const { rows, errors } = parseWithMapping(config, csv)
    expect(errors).toEqual([])
    expect(rows.map((r) => [r.amount, r.direction])).toEqual([
      [1000, 'out'],
      [2000, 'in'],
    ])
    expect(rows[0].balance).toBeNull() // balanceCol 未指定
  })

  it('single モード: 金額列＋方向列（outValues で出金判定）', () => {
    const config: ColumnMappingConfig = {
      encoding: 'utf8',
      headerRows: 1,
      dateCol: 0,
      descCols: [1],
      amount: { mode: 'single', amountCol: 2, directionCol: 3, outValues: ['出金', '引落'] },
    }
    const csv = ['date,desc,amount,type', '2026/05/01,A,1000,出金', '2026/05/02,B,500,入金', '2026/05/03,C,300,引落'].join('\n')
    const { rows } = parseWithMapping(config, csv)
    expect(rows.map((r) => r.direction)).toEqual(['out', 'in', 'out'])
    expect(rows.map((r) => r.amount)).toEqual([1000, 500, 300])
  })

  it('headerRows ぶんスキップし、空行・金額0行は誤エラーにせずスキップする', () => {
    const config: ColumnMappingConfig = { ...splitConfig, headerRows: 2 }
    const csv = [
      '"口座: 普通預金"', // ヘッダ1
      '"取引日","摘要","出金金額","入金金額","残高","メモ"', // ヘッダ2
      '"2026/05/01","入金","","1000","5000",""',
      '', // 空行
      '"2026/05/02","残高記載のみ","","","6000",""', // 金額0 → 取引でない
    ].join('\n')
    const { rows, errors } = parseWithMapping(config, csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: 1000, direction: 'in' })
  })

  it('部分取込: 日付が解釈不能な取引行は errors に退避し、正常行は取り込む（C-9）', () => {
    const csv = [
      '"取引日","摘要","出金金額","入金金額","残高","メモ"',
      '"2026/05/01","正常","100","","1000",""',
      '"baddate","壊れた日付","200","","",""',
    ].join('\n')
    const { rows, errors } = parseWithMapping(splitConfig, csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('正常')
    expect(errors).toHaveLength(1)
    expect(errors[0].rowNo).toBe(3) // parseCsv 物理行（1始まり）
    expect(errors[0].message).toMatch(/日付/)
  })

  it('split モードで負数（取消・組戻し）も方向反転で取りこぼさない（silent drop しない・§8.4）', () => {
    const csv = [
      '"取引日","摘要","出金金額","入金金額","残高","メモ"',
      '"2026/05/02","取消","-100","","900",""', // 出金列の負＝実質入金
      '"2026/05/03","入金取消","","-200","700",""', // 入金列の負＝実質出金
    ].join('\n')
    const { rows, errors } = parseWithMapping(splitConfig, csv)
    expect(errors).toEqual([])
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ amount: 100, direction: 'in' })
    expect(rows[1]).toMatchObject({ amount: 200, direction: 'out' })
  })

  it('descCols / outValues の過大な配列長は弾く（取込時CPUブロックの防止）', () => {
    expect(() => validateColumnMappingConfig({ encoding: 'utf8', dateCol: 0, descCols: new Array(65).fill(1), amount: { mode: 'signed', amountCol: 2 } })).toThrow(/descCols/)
    expect(() => validateColumnMappingConfig({ encoding: 'utf8', dateCol: 0, descCols: [1], amount: { mode: 'single', amountCol: 2, directionCol: 3, outValues: new Array(257).fill('x') } })).toThrow(/outValues/)
  })

  it('同日同額同摘要の別取引は出現インデックスで全件保持し distinct な dedup_hash を持つ（C-6）', () => {
    const csv = [
      '"取引日","摘要","出金金額","入金金額","残高","メモ"',
      '"2026/05/01","自販機","130","","",""',
      '"2026/05/01","自販機","130","","",""',
    ].join('\n')
    const { rows } = parseWithMapping(splitConfig, csv)
    expect(rows).toHaveLength(2)
    expect(rows[0].dedupHash).not.toBe(rows[1].dedupHash)
  })
})

describe('汎用列マッピング validateColumnMappingConfig', () => {
  const base = { encoding: 'utf8', headerRows: 1, dateCol: 0, descCols: [1], amount: { mode: 'split', paidCol: 2, receivedCol: 3 } }

  it('正常設定を検証し既定（headerRows・balanceCol・defaultAccountName）を補う', () => {
    const c = validateColumnMappingConfig({ encoding: 'shift_jis', dateCol: 0, descCols: [1], amount: { mode: 'signed', amountCol: 2 } })
    expect(c.headerRows).toBe(1)
    expect(c.balanceCol).toBeNull()
    expect(c.defaultAccountName).toBeNull()
  })

  it('不正設定を ColumnMappingError で弾く', () => {
    expect(() => validateColumnMappingConfig(null)).toThrow(ColumnMappingError)
    expect(() => validateColumnMappingConfig({ ...base, encoding: 'utf16' })).toThrow(/encoding/)
    expect(() => validateColumnMappingConfig({ ...base, dateCol: -1 })).toThrow(/dateCol/)
    expect(() => validateColumnMappingConfig({ ...base, headerRows: 1.5 })).toThrow(/headerRows/)
    expect(() => validateColumnMappingConfig({ ...base, descCols: 'x' })).toThrow(/descCols/)
    expect(() => validateColumnMappingConfig({ ...base, amount: { mode: 'split', paidCol: 2 } })).toThrow(/receivedCol/)
    expect(() => validateColumnMappingConfig({ ...base, amount: { mode: 'bogus' } })).toThrow(/mode/)
    expect(() => validateColumnMappingConfig({ ...base, amount: { mode: 'single', amountCol: 2, directionCol: 3, outValues: [] } })).toThrow(/outValues/)
  })
})

describe('dispatch: ユーザー定義フォーマットの解決', () => {
  it('parseBuffer は format:{id} を渡された設定で汎用パースする', () => {
    const csv = ['"取引日","摘要","出金金額","入金金額","残高","メモ"', '"2026/05/01","入金","","1000","5000",""'].join('\n')
    const { rows } = parseBuffer(customSourceType(7), Buffer.from(csv, 'utf8'), splitConfig)
    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({ amount: 1000, direction: 'in' })
  })

  it('parseBuffer は format:{id} で設定が無ければ致命的に失敗する', () => {
    expect(() => parseBuffer(customSourceType(7), Buffer.from('x'))).toThrow(/フォーマット定義/)
  })
})

describe('customFormatId（厳格な十進パース）', () => {
  it('正の十進整数のみ受理し、指数/16進/先頭ゼロ/空白/符号/小数/0/負は null', () => {
    expect(customFormatId('format:10')).toBe(10)
    expect(customFormatId(customSourceType(42))).toBe(42)
    for (const s of ['format:7e3', 'format:0x10', 'format:1e1', 'format:01', 'format: 5 ', 'format:+5', 'format:5.0', 'format:0', 'format:-1', 'format:', 'bank_ufj']) {
      expect(customFormatId(s)).toBeNull()
    }
  })
})
