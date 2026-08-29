import { eq } from 'drizzle-orm'
import { PDFDocument } from 'pdf-lib'
import { type Yen } from '@kanean/shared'
import { INK, RULE, drawText, drawRight, embedJapaneseFont, formatYen, reiwa } from './assets.js'
import type { DataDb } from '../db/router.js'
import { businessSettings, fiscalYears } from '../db/data/schema.js'
import { buildBlueReturnStatement, type FormBox } from '../reports/blueReturnStatement.js'
import { AOIRO_P1 } from './templates/aoiroP1Layout.js'

/**
 * 青色申告決算書 損益ページのPDF生成（rank2・自前A4レイアウト描画）。
 *
 * buildBlueReturnStatement（rank3 の様式ボックス）を pdf-lib で損益計算書として描画する。
 * 数値ロジックは rank3 に集約し、本モジュールは描画層に徹する（座標は aoiroP1Layout に外部化）。
 * 日本語は IPAex ゴシックを fontkit でサブセット埋込（registerFontkit 必須・忘れると空白化）。
 *
 * ⚠️ 官製様式PDFが未入手のため自前レイアウト。入手後は座標オーバーレイ方式（architecture §8）へ差替え予定。
 * ⚠️ legalRisk:high — 提出可否は税理士サインオフ対象。本PDFは内部確認用の参考帳票。
 */




interface Row {
  box: string | null
  label: string
  amount: Yen
  /** 小計行（上罫線＋やや強調）。 */
  rule?: boolean
}

function statementRows(pl: ReturnType<typeof buildBlueReturnStatement>['pl']): Row[] {
  const b = (f: FormBox, rule = false): Row => ({ box: f.box, label: f.label, amount: f.amount, rule })
  return [
    b(pl.sales),
    b(pl.openStock),
    b(pl.purchase),
    b(pl.subtotalCost, true),
    b(pl.closeStock),
    b(pl.costOfSales, true),
    b(pl.grossProfit, true),
    ...pl.expenses.map((e) => b(e)),
    b(pl.expenseTotal, true),
    b(pl.netBeforeAdjust, true),
    b(pl.reserveBack),
    b(pl.reserveIn),
    b(pl.senju),
    b(pl.incomeBeforeDeduction, true),
    b(pl.blueDeduction),
    b(pl.income, true),
  ]
}



export async function renderAoiroPage1(db: DataDb, fiscalYearId: number): Promise<Uint8Array> {
  const { pl } = buildBlueReturnStatement(db, fiscalYearId)
  const settings = db.select().from(businessSettings).all()[0]
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]

  const doc = await PDFDocument.create()
  const font = await embedJapaneseFont(doc, AOIRO_P1.font.file)

  const L = AOIRO_P1
  const page = doc.addPage([L.page.width, L.page.height])

  // ヘッダ。
  let y = L.page.height - L.margin.top
  const title = '青色申告決算書（損益計算書）'
  drawText(page, title, (L.page.width - font.widthOfTextAtSize(title, L.font.titleSize)) / 2, y, L.font.titleSize, font)
  y -= L.font.titleSize + 8

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
  y -= 6
  // 見出し行。
  drawText(page, '科目', L.col.label, y, L.font.bodySize, font)
  drawRight(page, '金額（円）', L.col.amountRight, y, L.font.bodySize, font)
  y -= 4
  page.drawLine({ start: { x: L.margin.left, y }, end: { x: L.page.width - L.margin.right, y }, thickness: 0.8, color: INK })
  y -= L.rowHeight

  // 明細行。
  for (const r of statementRows(pl)) {
    if (r.rule) {
      page.drawLine({ start: { x: L.margin.left, y: y + L.rowHeight - 4 }, end: { x: L.page.width - L.margin.right, y: y + L.rowHeight - 4 }, thickness: 0.4, color: RULE })
    }
    if (r.box) drawText(page, r.box, L.col.box, y, L.font.bodySize, font)
    drawText(page, r.label, L.col.label, y, L.font.bodySize, font)
    drawRight(page, formatYen(r.amount), L.col.amountRight, y, L.font.bodySize, font)
    y -= L.rowHeight
  }

  // フッタ注記。
  drawText(
    page,
    '※ 自動生成の参考帳票です。提出前に税理士の確認を受けてください。',
    L.margin.left,
    L.margin.bottom,
    L.font.bodySize - 1,
    font,
  )

  return doc.save()
}
