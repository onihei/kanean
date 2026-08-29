import { describe, it, expect } from 'vitest'
import { parseInvoiceItems, splitShipping, fillTemplate, DEFAULT_SEL } from '../sites/amazon.mjs'

describe('parseInvoiceItems', () => {
  it('価格行で商品を開始し、後続の折返し行を商品名に足す', () => {
    const text = [
      '内容 数量 価格 税率 税抜 税込',
      'Anker USB-C ケーブル 1 ￥1,264 10% ￥1,390 ￥1,390',
      '（1.8m シリコン）',
      '小計 ￥1,390',
    ].join('\n')
    expect(parseInvoiceItems(text)).toEqual([
      { itemName: 'Anker USB-C ケーブル （1.8m シリコン）', quantity: 1, lineAmount: 1390 },
    ])
  })

  it('小計・合計で商品を確定し、ヘッダ行は捨てる', () => {
    const text = [
      '商品A 2 ￥1,000 10% ￥1,100 ￥2,200',
      '商品B 1 ￥500 10% ￥550 ￥550',
      '請求額 ￥2,750',
    ].join('\n')
    const items = parseInvoiceItems(text)
    expect(items).toHaveLength(2)
    expect(items[1]).toEqual({ itemName: '商品B', quantity: 1, lineAmount: 550 })
  })

  it('商品行が無ければ空（推測で作らない）', () => {
    expect(parseInvoiceItems('ページ 1/1\n登録番号 T1234')).toEqual([])
  })
})

/**
 * 値引行（実物の請求書に現れる形）。落とすと Σline が過大になり突合で弾かれる＝注文ごと消える。
 * 行は実物 PDF から `layoutFromItems` で組んだものを写した（個人情報の入る欄は含めていない）。
 */
describe('parseInvoiceItems: 値引', () => {
  it('値引の最終カラムを直前の商品から差し引く', () => {
    const text = [
      '内容                                            数量        価格    税率        価格        小計',
      '税抜              税込        税込',
      'カゴメ 野菜生活100 Smoothie グリーンスムージー 330ml         1      ￥1,623     8%      ￥1,753      ￥1,753',
      '紙パック×12本(砂糖不使用 食物繊維) | B07GVCZHSK',
      '値引                                                     -￥243             -￥263      -￥263',
      '合計                                 ￥1,490',
    ].join('\n')
    const items = parseInvoiceItems(text)
    expect(items).toHaveLength(1)
    expect(items[0].lineAmount).toBe(1490) // 1753 − 263。請求書の「合計 ￥1,490」と一致する
    expect(items[0].itemName).toContain('B07GVCZHSK') // 折返しの商品名は保たれる
  })

  it('配送料の値引も同じ規則で効く（送料が二重計上されない）', () => {
    const text = [
      '配送料                                              1      ￥91     10%        ￥100       ￥100',
      '値引                                                     -￥91              -￥100      -￥100',
      '合計                                   ￥998',
    ].join('\n')
    expect(parseInvoiceItems(text)).toEqual([
      { itemName: '配送料', quantity: 1, lineAmount: 0 },
    ])
  })

  it('複数商品ではそれぞれ直前の商品に当たる', () => {
    const text = [
      '商品A 1 ￥1,000 10% ￥1,100 ￥1,100',
      '値引 -￥45 -￥50 -￥50',
      '商品B 1 ￥2,000 10% ￥2,200 ￥2,200',
      '値引 -￥90 -￥100 -￥100',
      '合計 ￥3,150',
    ].join('\n')
    expect(parseInvoiceItems(text).map((i) => i.lineAmount)).toEqual([1050, 2100])
  })

  it('当てる商品が無ければ何もしない（推測で当てない）', () => {
    expect(parseInvoiceItems('値引 -￥45 -￥50 -￥50')).toEqual([])
  })
})

describe('splitShipping', () => {
  const line = (itemName, lineAmount) => ({ itemName, quantity: 1, lineAmount })

  it('PDF に配送料行があればそれを採り、商品行から外す', () => {
    const r = splitShipping([line('商品A', 1000), line('配送料', 350)], 500)
    expect(r.shipping).toBe(350) // HTML の 500 ではなく PDF を優先
    expect(r.productLines).toEqual([line('商品A', 1000)])
  })

  it('PDF に配送料行が無ければ HTML の配送料を使う', () => {
    expect(splitShipping([line('商品A', 1000)], 500).shipping).toBe(500)
  })

  /**
   * 値引で送料が相殺された形。`pdfShipping || htmlShipping` と書くと 0 が偽になり、
   * HTML 側の**値引前**の額へ落ちて突合が壊れる（実物で踏んだ）。
   */
  it('値引で正味 0 になった配送料は 0 のまま（HTML の値引前へ落ちない）', () => {
    const r = splitShipping([line('商品A', 5777), line('配送料', 0), line('配送料', 0)], 200)
    expect(r.shipping).toBe(0)
    expect(r.productLines).toEqual([line('商品A', 5777)])
  })

  it('送料・手数料も配送料と同じ扱い', () => {
    expect(splitShipping([line('商品A', 100), line('手数料', 30)], 0).shipping).toBe(30)
    expect(splitShipping([line('商品A', 100), line('送料', 40)], 0).shipping).toBe(40)
  })
})

describe('fillTemplate', () => {
  it('プレースホルダを埋める', () => {
    expect(fillTemplate(DEFAULT_SEL.detailUrlTemplate, { orderId: '249-1234567-1234567' })).toBe(
      'https://www.amazon.co.jp/your-orders/order-details?orderID=249-1234567-1234567'
    )
  })

  it('値の無いプレースホルダはそのまま残す（黙って空にしない）', () => {
    expect(fillTemplate('https://x/{a}/{b}', { a: 1 })).toBe('https://x/1/{b}')
  })

  it('値はエスケープされる（テンプレートに割り込ませない）', () => {
    expect(fillTemplate('https://x?q={v}', { v: 'a&b=c' })).toBe('https://x?q=a%26b%3Dc')
  })
})
