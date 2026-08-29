import { describe, it, expect } from 'vitest'
import {
  targetAccountName,
  ecDedupHash,
  ecLineToParsedRow,
  ecAdjustmentToParsedRow,
  isEcSkillPayload,
  orderTotalMismatch,
  type EcLine,
  type EcOrder,
} from '../ec.js'

const line = (over: Partial<EcLine> = {}): EcLine => ({
  lineNo: 1,
  itemName: 'SanDisk microSDXC 256GB',
  quantity: 1,
  lineAmount: 2980,
  evidenceRef: 'evidence/amazon/249-1/line1.html',
  ...over,
})

describe('targetAccountName', () => {
  it('owner_draw → 事業主貸', () => {
    expect(targetAccountName(line({ treatment: 'owner_draw' }))).toBe('事業主貸')
  })
  it('unresolved → 未確定勘定', () => {
    expect(targetAccountName(line({ treatment: 'unresolved' }))).toBe('未確定勘定')
  })
  it('expense → proposed_account', () => {
    expect(targetAccountName(line({ treatment: 'expense', proposedAccount: '消耗品費' }))).toBe('消耗品費')
  })
  it('expense だが proposed_account 空 → 安全側で未確定勘定', () => {
    expect(targetAccountName(line({ treatment: 'expense', proposedAccount: '  ' }))).toBe('未確定勘定')
  })
  it('treatment 未指定でも proposed_account があれば使う', () => {
    expect(targetAccountName(line({ proposedAccount: '新聞図書費' }))).toBe('新聞図書費')
  })
  it('treatment も proposed も無し → 未確定勘定', () => {
    expect(targetAccountName(line())).toBe('未確定勘定')
  })
})

describe('ecDedupHash', () => {
  it('決定的（同入力で同値）', () => {
    expect(ecDedupHash('amazon', 'A-1', 1)).toBe(ecDedupHash('amazon', 'A-1', 1))
  })
  it('line_no / order_id / source で別値', () => {
    const base = ecDedupHash('amazon', 'A-1', 1)
    expect(ecDedupHash('amazon', 'A-1', 2)).not.toBe(base)
    expect(ecDedupHash('amazon', 'A-2', 1)).not.toBe(base)
    expect(ecDedupHash('rakuten', 'A-1', 1)).not.toBe(base)
  })
})

describe('ecLineToParsedRow', () => {
  const order: EcOrder = {
    orderId: '249-1234567-7654321',
    orderDate: '2025-05-20',
    orderTotal: 4980,
    paymentHint: 'UFJ-VISA',
    lines: [],
  }

  it('direction=out・金額・日付・摘要(=品名)・dedupHash を組む', () => {
    const r = ecLineToParsedRow('amazon', order, line({ proposedAccount: '消耗品費', treatment: 'expense' }))
    expect(r.direction).toBe('out')
    expect(r.amount).toBe(2980)
    expect(r.txnDate).toBe('2025-05-20')
    expect(r.description).toBe('SanDisk microSDXC 256GB')
    expect(r.dedupHash).toBe(ecDedupHash('amazon', '249-1234567-7654321', 1))
  })

  it('raw_payload に注文文脈とAI仕訳候補を残す（監査用）', () => {
    const r = ecLineToParsedRow(
      'amazon',
      order,
      line({ proposedAccount: '消耗品費', treatment: 'expense', reason: '作業用ストレージ', confidence: 'high', policyRef: 'ec-classify@v1' }),
    )
    const payload = JSON.parse(r.rawPayload)
    expect(payload.source).toBe('amazon')
    expect(payload.orderId).toBe('249-1234567-7654321')
    expect(payload.proposedAccount).toBe('消耗品費')
    expect(payload.treatment).toBe('expense')
    expect(payload.reason).toBe('作業用ストレージ')
    expect(payload.confidence).toBe('high')
    expect(payload.policyRef).toBe('ec-classify@v1')
    expect(payload.paymentHint).toBe('UFJ-VISA')
    expect(payload.evidenceRef).toBe('evidence/amazon/249-1/line1.html')
    expect(payload.currency).toBe('JPY') // 既定
  })

  it('track=ec_skill マーカーを明細行・調整行の双方に付ける（issue #126 の対称化）', () => {
    const lineRow = ecLineToParsedRow('amazon', order, line({}))
    const adjRow = ecAdjustmentToParsedRow('amazon', order, 'shipping', 500)
    expect(JSON.parse(lineRow.rawPayload).track).toBe('ec_skill')
    expect(JSON.parse(adjRow.rawPayload).track).toBe('ec_skill')
    expect(isEcSkillPayload(lineRow.rawPayload)).toBe(true)
    expect(isEcSkillPayload(adjRow.rawPayload)).toBe(true)
    // マーカー導入前の既存行（orderId のみ）・壊れた JSON・null は false（フォールバック側で拾う）。
    expect(isEcSkillPayload(JSON.stringify({ source: 'amazon', orderId: '249-1' }))).toBe(false)
    expect(isEcSkillPayload('{broken')).toBe(false)
    expect(isEcSkillPayload(null)).toBe(false)
  })
})

describe('orderTotalMismatch', () => {
  it('一致は0、不一致は差額', () => {
    const lines = [line({ lineNo: 1, lineAmount: 2980 }), line({ lineNo: 2, lineAmount: 2000 })]
    expect(orderTotalMismatch({ orderId: 'A', orderDate: '2025-05-20', orderTotal: 4980, lines })).toBe(0)
    expect(orderTotalMismatch({ orderId: 'A', orderDate: '2025-05-20', orderTotal: 5000, lines })).toBe(-20)
  })
})
