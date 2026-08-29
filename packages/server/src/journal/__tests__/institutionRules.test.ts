import { describe, it, expect } from 'vitest'
import { classifyInstitutionEntry } from '../institutionRules.js'

/** 同日利息の有無を固定するヘルパ。 */
const ctx = (sourceType: string, interest = false) => ({ sourceType, hasSameDayInterest: () => interest })

describe('classifyInstitutionEntry（金融機関特有の既定自動仕訳・csv-format §3.2/§5）', () => {
  it('新生: 税引前利息(入金) → 事業主借（受取利息。事業所得に含めない）', () => {
    const m = classifyInstitutionEntry({ description: '税引前利息', direction: 'in', txnDate: '2026-05-01' }, ctx('bank_shinsei'))
    expect(m).toEqual({ accountName: '事業主借', reason: 'interest_income' })
  })

  it('新生: 国税/地方税(出金)で同日に利息あり → 事業主貸（利息源泉。損益外）', () => {
    const kokuzei = classifyInstitutionEntry({ description: '国税', direction: 'out', txnDate: '2026-05-01' }, ctx('bank_shinsei', true))
    const chihou = classifyInstitutionEntry({ description: '地方税', direction: 'out', txnDate: '2026-05-01' }, ctx('bank_shinsei', true))
    expect(kokuzei).toEqual({ accountName: '事業主貸', reason: 'interest_withholding' })
    expect(chihou).toEqual({ accountName: '事業主貸', reason: 'interest_withholding' })
  })

  it('新生: 国税(出金)でも同日に利息が無ければ分類しない（予定納税等を源泉と誤らない）', () => {
    expect(classifyInstitutionEntry({ description: '国税', direction: 'out', txnDate: '2026-03-15' }, ctx('bank_shinsei', false))).toBeNull()
  })

  it('新生: 税引前利息でも方向が出金なら分類しない', () => {
    expect(classifyInstitutionEntry({ description: '税引前利息', direction: 'out', txnDate: '2026-05-01' }, ctx('bank_shinsei', true))).toBeNull()
  })

  it('UFJ: シヨウヒゼイ(出金) → 租税公課（消費税納付・税込経理）。半角カナ・全角どちらでも一致', () => {
    // 実CSV(Shift_JIS)は半角カナ ｼﾖｳﾋｾﾞｲ で出る。照合時 NFKC 正規化で全角同等に扱う。
    const hankaku = classifyInstitutionEntry({ description: '税金 ｼﾖｳﾋｾﾞｲ', direction: 'out', txnDate: '2026-05-20' }, ctx('bank_ufj'))
    const zenkaku = classifyInstitutionEntry({ description: '税金 シヨウヒゼイ', direction: 'out', txnDate: '2026-05-20' }, ctx('bank_ufj'))
    expect(hankaku).toEqual({ accountName: '租税公課', reason: 'consumption_tax_payment' })
    expect(zenkaku).toEqual({ accountName: '租税公課', reason: 'consumption_tax_payment' })
  })

  it('新生: 「国税」を包含する別摘要（外国税額控除等）は厳密一致で源泉と誤らない', () => {
    expect(classifyInstitutionEntry({ description: '外国税額控除', direction: 'out', txnDate: '2026-05-01' }, ctx('bank_shinsei', true))).toBeNull()
  })

  it('UFJ: 国税/地方税は分類しない（新生の利息源泉と取り違えない）', () => {
    expect(classifyInstitutionEntry({ description: '国税', direction: 'out', txnDate: '2026-05-20' }, ctx('bank_ufj', true))).toBeNull()
    expect(classifyInstitutionEntry({ description: '地方税', direction: 'out', txnDate: '2026-05-20' }, ctx('bank_ufj', true))).toBeNull()
  })

  it('対象外 source（カード等）・無関係な摘要は分類しない', () => {
    expect(classifyInstitutionEntry({ description: '税引前利息', direction: 'in', txnDate: '2026-05-01' }, ctx('card_mufg_visa'))).toBeNull()
    expect(classifyInstitutionEntry({ description: 'コンビニ', direction: 'out', txnDate: '2026-05-01' }, ctx('bank_shinsei', true))).toBeNull()
  })
})
