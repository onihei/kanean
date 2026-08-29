import { eq } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { type Yen } from '@kanean/shared'
import { INK, RULE, drawText, drawRight, embedJapaneseFont, formatYen, reiwa } from './assets.js'
import type { DataDb } from '../db/router.js'
import { businessSettings, fiscalYears } from '../db/data/schema.js'
import { buildConsumptionTaxReturn, type ConsumptionTaxReturn } from '../taxreturn/consumptionTax.js'
import { CONSUMPTION_TAX_LAYOUT } from './templates/consumptionTaxLayout.js'

/**
 * 消費税及び地方消費税申告書（簡易課税）のPDF生成（自前A4レイアウト描画・rank: self-drawn）。
 *
 * 数値は buildConsumptionTaxReturn に集約し、本モジュールは描画層に徹する。日本語は IPAex を
 * fontkit でサブセット埋込（registerFontkit 必須）。座標は templates/consumptionTaxLayout に外部化。
 *
 * ⚠️ legalRisk:high — 提出可否は税理士サインオフ対象。本PDFは内部確認用の参考帳票。
 */

const KIND_LABEL: Record<number, string> = { 1: '第1種', 2: '第2種', 3: '第3種', 4: '第4種', 5: '第5種', 6: '第6種' }


interface Row {
  label: string
  amount: Yen
  rule?: boolean
}

/** 税額計算の行（売上税額→控除→差引国税→地方→中間→納付）。 */
function calcRows(r: ConsumptionTaxReturn): Row[] {
  return [
    { label: '課税標準額の合計', amount: r.taxBaseTotal },
    { label: '売上に係る消費税額（国税）', amount: r.salesTaxNational },
    { label: '控除対象仕入税額（みなし仕入）', amount: r.deemedDeduction },
    { label: '返還等対価に係る税額（国税）', amount: r.returnNational },
    { label: '貸倒れに係る税額（国税）', amount: r.badDebtNational },
    { label: '差引税額（国税・百円未満切捨）', amount: r.national, rule: true },
    { label: '地方消費税額（百円未満切捨）', amount: r.local },
    { label: '中間納付税額', amount: r.midPaid },
    { label: '納付税額（国税＋地方−中間）', amount: r.payable, rule: true },
  ]
}

export async function renderConsumptionTaxReturn(db: DataDb, fiscalYearId: number): Promise<Uint8Array> {
  const r = buildConsumptionTaxReturn(db, fiscalYearId)
  const settings = db.select().from(businessSettings).all()[0]
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]

  const doc = await PDFDocument.create()
  const font = await embedJapaneseFont(doc, CONSUMPTION_TAX_LAYOUT.font.file)
  const L = CONSUMPTION_TAX_LAYOUT
  const page = doc.addPage([L.page.width, L.page.height])

  // ヘッダ
  let y = L.page.height - L.margin.top
  const title = '消費税及び地方消費税申告書（簡易課税）'
  drawText(page, title, (L.page.width - font.widthOfTextAtSize(title, L.font.titleSize)) / 2, y, L.font.titleSize, font)
  y -= L.font.titleSize + 8
  const period = fy ? `課税期間: ${reiwa(fy.startDate)}（${fy.startDate} 〜 ${fy.endDate}）` : ''
  const ownerLine = [settings?.businessName ? `屋号: ${settings.businessName}` : '', settings?.ownerName ? `氏名: ${settings.ownerName}` : ''].filter(Boolean).join('　　')
  if (period) {
    drawText(page, period, L.margin.left, y, L.font.headerSize, font)
    y -= L.font.headerSize + 4
  }
  if (ownerLine) {
    drawText(page, ownerLine, L.margin.left, y, L.font.headerSize, font)
    y -= L.font.headerSize + 4
  }
  const kind = KIND_LABEL[r.businessCategory] ?? String(r.businessCategory)
  drawText(page, '事業区分: ' + kind + '　みなし仕入率: ' + Math.round(r.deemedRate * 100) + '%', L.margin.left, y, L.font.headerSize, font)
  y -= L.font.headerSize + 10

  // 税率別 課税標準額・売上税額
  drawText(page, '■ 税率別 課税標準額・売上消費税額（国税）', L.margin.left, y, L.font.sectionSize, font)
  y -= L.rowHeight
  drawText(page, '税率', L.table.rate, y, L.font.bodySize, font)
  drawRight(page, '課税標準額（税抜・千円未満切捨）', L.table.baseRight, y, L.font.bodySize, font)
  drawRight(page, '売上消費税額（国税）', L.table.taxRight, y, L.font.bodySize, font)
  y -= 4
  page.drawLine({ start: { x: L.margin.left, y }, end: { x: L.page.width - L.margin.right, y }, thickness: 0.8, color: INK })
  y -= L.rowHeight
  if (r.baseRows.length === 0) {
    drawText(page, '（課税売上はありません）', L.table.rate, y, L.font.bodySize, font)
    y -= L.rowHeight
  } else {
    for (const b of r.baseRows) {
      drawText(page, `${b.rate}%`, L.table.rate, y, L.font.bodySize, font)
      drawRight(page, formatYen(b.taxBase), L.table.baseRight, y, L.font.bodySize, font)
      drawRight(page, formatYen(b.salesTaxNational), L.table.taxRight, y, L.font.bodySize, font)
      y -= L.rowHeight
    }
  }
  y -= 8

  // 税額計算
  drawText(page, '■ 税額の計算', L.margin.left, y, L.font.sectionSize, font)
  y -= L.rowHeight
  for (const row of calcRows(r)) {
    if (row.rule) {
      page.drawLine({ start: { x: L.margin.left, y: y + L.rowHeight - 5 }, end: { x: L.page.width - L.margin.right, y: y + L.rowHeight - 5 }, thickness: 0.4, color: RULE })
    }
    drawText(page, row.label, L.col.label, y, L.font.bodySize, font)
    drawRight(page, formatYen(row.amount), L.col.amountRight, y, L.font.bodySize, font)
    y -= L.rowHeight
  }

  if (r.note) {
    y -= 6
    drawText(page, `※ ${r.note}`, L.margin.left, y, L.font.bodySize, font)
    y -= L.rowHeight
  }
  drawText(page, '※ 自動生成の参考帳票です。提出前に税理士の確認を受けてください。', L.margin.left, L.margin.bottom, L.font.bodySize - 1, font)

  return doc.save()
}
