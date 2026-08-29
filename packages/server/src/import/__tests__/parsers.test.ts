import { describe, it, expect } from 'vitest'
import { parseBankUfj } from '../parsers/bankUfj.js'
import { parseBankShinsei } from '../parsers/bankShinsei.js'
import { parseCardMufgVisa } from '../parsers/cardMufgVisa.js'

describe('parseBankUfj（csv-format §1）', () => {
  const csv = [
    '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
    '"2026/5/11","クレジット","","193,945","","37,717,278"',
    '"2026/5/12","振込","ﾄｲｳｴｱ(ｶ","","330,000","38,047,278"',
  ].join('\r\n')

  it('支払い→out / 預かり→in、摘要結合', () => {
    const { rows, errors } = parseBankUfj(csv)
    expect(errors).toHaveLength(0)
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ txnDate: '2026-05-11', amount: 193945, direction: 'out', description: 'クレジット' })
    expect(rows[0].balance).toBe(37717278) // 差引残高を突合用に保持
    expect(rows[1]).toMatchObject({ txnDate: '2026-05-12', amount: 330000, direction: 'in' })
    expect(rows[1].description).toContain('振込')
  })

  it('dedupHash は決定的で行ごとに異なる', () => {
    const a = parseBankUfj(csv).rows
    const b = parseBankUfj(csv).rows
    expect(a[0].dedupHash).toBe(b[0].dedupHash)
    expect(a[0].dedupHash).not.toBe(a[1].dedupHash)
  })

  it('残高が同一の同日同額同摘要でも出現インデックスで distinct（残高に依存しない・取りこぼさない）', () => {
    const dup = [
      '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
      '"2026/5/11","自販機","","150","","1000"',
      '"2026/5/11","自販機","","150","","1000"', // 残高まで完全同一
    ].join('\r\n')
    const { rows } = parseBankUfj(dup)
    expect(rows).toHaveLength(2)
    expect(rows[0].dedupHash).not.toBe(rows[1].dedupHash) // 旧実装（残高依存）では衝突＝片方消失していた
    // 同内容の再パースは同じ hash 列（冪等）。
    expect(parseBankUfj(dup).rows.map((r) => r.dedupHash)).toEqual(rows.map((r) => r.dedupHash))
  })

  it('部分取込: 解釈できない行（不正日付/金額）は errors に退避し正常行は取り込む', () => {
    const csv = [
      '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
      '"2026/5/11","正常","","100","","1000"',
      '"baddate","不正日付","","200","","900"', // 日付として解釈できない
      '"2026/5/13","不正金額","","あ","","800"', // 金額が数値でない
      '"2026/5/14","正常2","","300","","500"',
    ].join('\r\n')
    const { rows, errors } = parseBankUfj(csv)
    expect(rows).toHaveLength(2) // 正常2件は取り込む
    expect(rows.map((r) => r.txnDate)).toEqual(['2026-05-11', '2026-05-14'])
    expect(errors).toHaveLength(2) // 不正2行を退避
    expect(errors[0]).toMatchObject({ rowNo: 3 }) // 物理行3（ヘッダ込み・1始まり）
    expect(errors[0].message).toMatch(/日付/)
    expect(errors[1].message).toMatch(/金額/)
    expect(errors[1].raw).toContain('不正金額')
  })

  it('全行が解釈不能なら rows=0・errors に全件（api はこれを status=failed として返す）', () => {
    const csv = [
      '"日付","摘要","摘要内容","支払い金額","預かり金額","差引残高"',
      '"baddate1","x","","100","","1"',
      '"baddate2","y","","200","","2"',
    ].join('\r\n')
    const { rows, errors } = parseBankUfj(csv)
    expect(rows).toHaveLength(0)
    expect(errors).toHaveLength(2)
  })
})

describe('parseBankShinsei（csv-format §3・UTF-8 BOM）', () => {
  const csv = [
    '"取引日","摘要","出金金額","入金金額","残高","メモ"',
    '"2026/05/01","地方税","35","","2916330",""',
    '"2026/05/01","税引前利息","","718","2916474",""',
  ].join('\n')

  it('出金→out / 入金→in', () => {
    const { rows } = parseBankShinsei('﻿' + csv) // 先頭BOM付きでも可
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ txnDate: '2026-05-01', amount: 35, direction: 'out', description: '地方税' })
    expect(rows[1]).toMatchObject({ amount: 718, direction: 'in', description: '税引前利息' })
  })
})

describe('parseCardMufgVisa（csv-format §2・混在行）', () => {
  const csv = [
    '"確定情報","お支払日","ご利用店名","ご利用日","支払回数","何回目","ご利用金額（円）","現地通貨額"',
    '"","","【林　雄一郎　様】","","","","",""',
    '"確定","2026年6月10日","ＥＴＣ　京浜川崎　－港北","2026年4月1日","　１","","210","車種：普通車"',
    '"確定","2026年6月10日","CLAUDE.AI SUBSCRIPTION","2026年5月5日","　１","","35,945","ドル"',
    '"","","","","","","","内海外利用事務手数料　　１，３３２円"',
    '"未確定","2026年7月10日","未確定の店","2026年6月20日","　１","","1,000",""',
  ].join('\r\n')

  it('取引行のみ抽出（見出し/注記はスキップ・確定のみ）', () => {
    const { rows, errors } = parseCardMufgVisa(csv)
    expect(errors).toHaveLength(0) // 見出し/注記は取引行でない＝エラーにしない
    expect(rows).toHaveLength(2)
    expect(rows[0]).toMatchObject({ txnDate: '2026-04-01', amount: 210, direction: 'out' })
    // 全角は半角化される（ＥＴＣ→ETC、－→-、全角空白→半角）
    expect(rows[0].description).toBe('ETC 京浜川崎 -港北')
    expect(rows[0].balance ?? null).toBeNull() // カードは残高列なし＝突合対象外
    expect(rows[1]).toMatchObject({ txnDate: '2026-05-05', amount: 35945, direction: 'out' })
  })

  it('includeUnconfirmed で未確定も取り込む', () => {
    const { rows } = parseCardMufgVisa(csv, { includeUnconfirmed: true })
    expect(rows).toHaveLength(3)
    expect(rows[2]).toMatchObject({ txnDate: '2026-06-20', amount: 1000 })
  })

  it('同日同店同額の一回払いが複数でも出現インデックスで distinct（連番=何回目に依存しない）', () => {
    const dup = [
      '"確定情報","お支払日","ご利用店名","ご利用日","支払回数","何回目","ご利用金額（円）","現地通貨額"',
      '"確定","2026年6月10日","自販機","2026年5月5日","　１","","150",""',
      '"確定","2026年6月10日","自販機","2026年5月5日","　１","","150",""', // 何回目も同一
    ].join('\r\n')
    const { rows } = parseCardMufgVisa(dup)
    expect(rows).toHaveLength(2)
    expect(rows[0].dedupHash).not.toBe(rows[1].dedupHash) // 旧実装（何回目依存）では衝突＝片方消失していた
  })

  it('部分取込: 取引行（確定＋日付OK）の金額が不正なら errors に退避、見出し/注記は無視', () => {
    const csv = [
      '"確定情報","お支払日","ご利用店名","ご利用日","支払回数","何回目","ご利用金額（円）","現地通貨額"',
      '"","","【見出し】","","","","",""', // 取引行でない→スキップ（エラーにしない）
      '"確定","2026年6月10日","正常店","2026年4月1日","　１","","210",""',
      '"確定","2026年6月10日","金額不正店","2026年4月2日","　１","","---",""', // 金額が数値でない→エラー
    ].join('\r\n')
    const { rows, errors } = parseCardMufgVisa(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('正常店')
    expect(errors).toHaveLength(1)
    expect(errors[0].raw).toContain('金額不正店')
    expect(errors[0].message).toMatch(/金額/)
  })

  it('部分取込: 確定行の日付が解釈不能なら errors に退避（silent drop しない・銀行と対称）', () => {
    const csv = [
      '"確定情報","お支払日","ご利用店名","ご利用日","支払回数","何回目","ご利用金額（円）","現地通貨額"',
      '"","","【見出し】","","","","",""', // ご利用日空＝取引行でない→スキップ（エラーにしない）
      '"確定","2026年6月10日","正常店","2026年4月1日","　１","","210",""',
      '"確定","2026年6月10日","日付壊れ店","2026-04-01","　１","","210",""', // ダッシュ日付＝解釈不能→退避
    ].join('\r\n')
    const { rows, errors } = parseCardMufgVisa(csv)
    expect(rows).toHaveLength(1)
    expect(rows[0].description).toBe('正常店')
    expect(errors).toHaveLength(1) // 旧実装では取引行でないと誤分類され silent drop していた
    expect(errors[0].raw).toContain('日付壊れ店')
    expect(errors[0].message).toMatch(/日付/)
  })
})
