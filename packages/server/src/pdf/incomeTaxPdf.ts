import { eq } from 'drizzle-orm'
import { PDFDocument, type PDFFont, type PDFPage } from 'pdf-lib'
import { type Yen, yen } from '@kanean/shared'
import { INK, RULE, drawText, drawRight, embedJapaneseFont, formatYen, reiwa } from './assets.js'
import type { DataDb } from '../db/router.js'
import { businessSettings, fiscalYears } from '../db/data/schema.js'
import { buildIncomeTaxReturn, type IncomeTaxReturn } from '../taxreturn/incomeTax.js'
import { INCOME_TAX_LAYOUT } from './templates/incomeTaxLayout.js'

/**
 * 確定申告書 第一表・第二表のPDF生成（自前A4レイアウト描画・rank: self-drawn）。
 *
 * 数値は buildIncomeTaxReturn（taxreturn/incomeTax）に集約し、本モジュールは描画層に徹する。
 * 日本語は IPAex ゴシックを fontkit でサブセット埋込（registerFontkit 必須・忘れると空白化）。
 * 座標は templates/incomeTaxLayout に外部化（官製様式PDF入手後はオーバーレイ方式へ差替え予定）。
 *
 * ⚠️ legalRisk:high — 提出可否は税理士サインオフ対象。本PDFは内部確認用の参考帳票。
 *    官製様式の欄番号は年度で変わるため本帳票では印字せず、科目ラベルで表す。
 */




interface Row {
  /** セクション見出し（太字相当・上部空け）。値行は label を使う。 */
  section?: string
  label?: string
  amount?: Yen
  /** 小計・合計行（上罫線）。 */
  rule?: boolean
}

/** 第一表の行（収入金額等→所得金額等→所得控除→税金の計算）。 */
function page1Rows(r: IncomeTaxReturn): Row[] {
  return [
    { section: '収入金額等' },
    { label: '事業（営業等）', amount: r.businessRevenue },
    { section: '所得金額等' },
    { label: '事業（営業等）', amount: r.businessIncome },
    { label: '合計', amount: r.totalIncome, rule: true },
    { section: '所得から差し引かれる金額' },
    { label: '社会保険料控除', amount: yen(r.inputs.socialInsurance) },
    { label: '生命保険料控除', amount: yen(r.inputs.lifeInsurance) },
    { label: '医療費控除', amount: yen(r.inputs.medical) },
    { label: '配偶者・扶養控除', amount: yen(r.inputs.spouseDependents) },
    { label: '基礎控除', amount: yen(r.inputs.basicDeduction) },
    { label: 'その他の所得控除', amount: yen(r.inputs.otherDeductions) },
    { label: '所得から差し引かれる金額 合計', amount: r.totalDeductions, rule: true },
    { section: '税金の計算' },
    { label: '課税される所得金額（千円未満切捨）', amount: r.taxableIncome },
    { label: '上の課税所得に対する税額', amount: r.baseTax },
    { label: '復興特別所得税額（×2.1%）', amount: r.surtax },
    { label: '所得税及び復興特別所得税の額', amount: r.taxWithSurtax, rule: true },
    { label: '源泉徴収税額', amount: r.withholding },
    { label: '予定納税額', amount: r.estimatedPrepaid },
    { label: '申告納税額（納める税金・百円未満切捨）', amount: r.payable, rule: true },
    { label: '還付される税金', amount: r.refund },
  ]
}

function drawHeader(page: PDFPage, font: PDFFont, title: string, db: DataDb, fy: { startDate: string; endDate: string } | undefined): number {
  const L = INCOME_TAX_LAYOUT
  let y = L.page.height - L.margin.top
  drawText(page, title, (L.page.width - font.widthOfTextAtSize(title, L.font.titleSize)) / 2, y, L.font.titleSize, font)
  y -= L.font.titleSize + 8
  const settings = db.select().from(businessSettings).all()[0]
  const period = fy ? `${reiwa(fy.startDate)}（${fy.startDate} 〜 ${fy.endDate}）` : ''
  const ownerLine = [settings?.businessName ? `屋号: ${settings.businessName}` : '', settings?.ownerName ? `氏名: ${settings.ownerName}` : '']
    .filter(Boolean)
    .join('　　')
  if (period) {
    drawText(page, period, L.margin.left, y, L.font.headerSize, font)
    y -= L.font.headerSize + 4
  }
  if (ownerLine) {
    drawText(page, ownerLine, L.margin.left, y, L.font.headerSize, font)
    y -= L.font.headerSize + 4
  }
  return y - 6
}

function drawFooter(page: PDFPage, font: PDFFont): void {
  const L = INCOME_TAX_LAYOUT
  drawText(page, '※ 自動生成の参考帳票です。提出前に税理士の確認を受けてください。', L.margin.left, L.margin.bottom, L.font.bodySize - 1, font)
}

function renderPage1(page: PDFPage, font: PDFFont, r: IncomeTaxReturn, db: DataDb, fy: { startDate: string; endDate: string } | undefined): void {
  const L = INCOME_TAX_LAYOUT
  let y = drawHeader(page, font, '確定申告書（第一表）', db, fy)
  for (const row of page1Rows(r)) {
    if (row.section) {
      y -= 6
      drawText(page, `■ ${row.section}`, L.margin.left, y, L.font.sectionSize, font)
      y -= L.rowHeight
      continue
    }
    if (row.rule) {
      page.drawLine({ start: { x: L.margin.left, y: y + L.rowHeight - 5 }, end: { x: L.page.width - L.margin.right, y: y + L.rowHeight - 5 }, thickness: 0.4, color: RULE })
    }
    drawText(page, row.label ?? '', L.col.label, y, L.font.bodySize, font)
    drawRight(page, formatYen(row.amount ?? (0 as Yen)), L.col.amountRight, y, L.font.bodySize, font)
    y -= L.rowHeight
  }
  drawFooter(page, font)
}

function renderPage2(page: PDFPage, font: PDFFont, r: IncomeTaxReturn, db: DataDb, fy: { startDate: string; endDate: string } | undefined): void {
  const L = INCOME_TAX_LAYOUT
  let y = drawHeader(page, font, '確定申告書（第二表）', db, fy)

  y -= 6
  drawText(page, '■ 所得の内訳（所得税及び復興特別所得税の源泉徴収税額）', L.margin.left, y, L.font.sectionSize, font)
  y -= L.rowHeight
  // テーブル見出し
  drawText(page, '所得の種類', L.table.kind, y, L.font.bodySize, font)
  drawText(page, '支払者の氏名・名称', L.table.payer, y, L.font.bodySize, font)
  drawRight(page, '収入金額', L.table.revenueRight, y, L.font.bodySize, font)
  drawRight(page, '源泉徴収税額', L.table.withholdingRight, y, L.font.bodySize, font)
  y -= 4
  page.drawLine({ start: { x: L.margin.left, y }, end: { x: L.page.width - L.margin.right, y }, thickness: 0.8, color: INK })
  y -= L.rowHeight

  if (r.incomeDetail.length === 0) {
    drawText(page, '（源泉徴収された所得はありません）', L.table.kind, y, L.font.bodySize, font)
    y -= L.rowHeight
  } else {
    for (const d of r.incomeDetail) {
      drawText(page, '事業（営業等）', L.table.kind, y, L.font.bodySize, font)
      drawText(page, d.payerName, L.table.payer, y, L.font.bodySize, font)
      drawRight(page, formatYen(d.revenue), L.table.revenueRight, y, L.font.bodySize, font)
      drawRight(page, formatYen(d.withholding), L.table.withholdingRight, y, L.font.bodySize, font)
      y -= L.rowHeight
    }
  }
  // 源泉徴収税額の合計
  page.drawLine({ start: { x: L.margin.left, y: y + L.rowHeight - 5 }, end: { x: L.page.width - L.margin.right, y: y + L.rowHeight - 5 }, thickness: 0.4, color: RULE })
  drawText(page, '源泉徴収税額の合計', L.table.payer, y, L.font.bodySize, font)
  drawRight(page, formatYen(r.withholding), L.table.withholdingRight, y, L.font.bodySize, font)
  y -= L.rowHeight

  // 所得から差し引かれる金額に関する事項
  y -= 6
  drawText(page, '■ 所得から差し引かれる金額に関する事項', L.margin.left, y, L.font.sectionSize, font)
  y -= L.rowHeight
  const deductions: [string, Yen][] = [
    ['社会保険料控除', r.inputs.socialInsurance as Yen],
    ['生命保険料控除', r.inputs.lifeInsurance as Yen],
    ['医療費控除', r.inputs.medical as Yen],
    ['配偶者・扶養控除', r.inputs.spouseDependents as Yen],
    ['基礎控除', r.inputs.basicDeduction as Yen],
    ['その他の所得控除', r.inputs.otherDeductions as Yen],
  ]
  for (const [label, amount] of deductions) {
    drawText(page, label, L.col.label, y, L.font.bodySize, font)
    drawRight(page, formatYen(amount), L.col.amountRight, y, L.font.bodySize, font)
    y -= L.rowHeight
  }
  drawFooter(page, font)
}

/** 確定申告書 第一表・第二表のPDF（2ページ・自前レイアウト・参考帳票）。 */
export async function renderIncomeTaxReturn(db: DataDb, fiscalYearId: number): Promise<Uint8Array> {
  const r = buildIncomeTaxReturn(db, fiscalYearId)
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]

  const doc = await PDFDocument.create()
  const font = await embedJapaneseFont(doc, INCOME_TAX_LAYOUT.font.file)
  const L = INCOME_TAX_LAYOUT

  renderPage1(doc.addPage([L.page.width, L.page.height]), font, r, db, fy)
  renderPage2(doc.addPage([L.page.width, L.page.height]), font, r, db, fy)

  return doc.save()
}
