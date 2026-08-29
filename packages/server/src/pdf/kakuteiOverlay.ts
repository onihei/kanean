import { type PDFFont, type PDFPage } from 'pdf-lib'
import { type Yen } from '@kanean/shared'
import { formatYen, loadOverlay } from './assets.js'
import type { DataDb } from '../db/router.js'
import { buildIncomeTaxReturn } from '../taxreturn/incomeTax.js'
import { drawDigitCells } from './digitCells.js'
import { KAKUTEI_OVERLAY } from './templates/kakuteiOverlay.js'

/**
 * 官製様式PDF（確定申告書 第一表・第二表）への座標オーバーレイ出力。
 *
 * 数値は buildIncomeTaxReturn に集約し、本モジュールは正規化済みテンプレへ金額を差込む描画層。
 * 第一表の金額欄は1桁1マスの手書き用セルなので drawDigitCells で1桁ずつマス中心に置く。
 * テンプレは gs 正規化未平衡CTMが残るため embedPages（Form XObject）で背景化し原点座標で描く
 * （aoiroOverlay と同方式）。座標は templates/kakuteiOverlay に外部化。
 *
 * ⚠️ legalRisk:high — 提出可否は税理士サインオフ対象。本PDFは確認用の参考帳票。
 */



/** 左寄せ（空文字スキップ・長すぎる名称は切り詰め）。 */
function drawLeft(page: PDFPage, font: PDFFont, x: number, y: number, text: string, size: number, maxW?: number): void {
  if (!text) return
  let t = text
  if (maxW) while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1)
  page.drawText(t, { x, y, size, font })
}
function drawRight(page: PDFPage, font: PDFFont, x: number, y: number, text: string, size: number): void {
  if (!text) return
  page.drawText(text, { x: x - font.widthOfTextAtSize(text, size), y, size, font })
}

export async function renderKakuteiOverlay(db: DataDb, fiscalYearId: number): Promise<Uint8Array> {
  const r = buildIncomeTaxReturn(db, fiscalYearId)
  const { doc, font, pages } = await loadOverlay(KAKUTEI_OVERLAY.template, KAKUTEI_OVERLAY.font)
  const L = KAKUTEI_OVERLAY

  // --- 第一表（1桁1マス欄。zeros 付き欄＝㉓㉔万円/㉚千円/51百円は drawDigitCells が桁を左へ詰める） ---
  const p1 = pages[0]
  const m = L.page1
  const cellDefaults = { pitch: L.cellPitch, size: L.digitSize }
  const put = (code: string, amount: Yen | number) => drawDigitCells(p1, font, m[code], amount, cellDefaults)
  put('REVENUE_BIZ', r.businessRevenue)
  put('INCOME_BIZ', r.businessIncome)
  put('INCOME_TOTAL', r.totalIncome)
  put('DEDUCT_SOCIAL', r.inputs.socialInsurance as Yen)
  put('DEDUCT_LIFE', r.inputs.lifeInsurance as Yen)
  put('DEDUCT_MEDICAL', r.inputs.medical as Yen)
  put('DEDUCT_TOTAL', r.totalDeductions)
  put('DEDUCT_BASIC', r.inputs.basicDeduction)
  put('DEDUCT_DEPEND', r.inputs.spouseDependents)
  put('TAXABLE', r.taxableIncome)
  put('BASE_TAX', r.baseTax)
  put('SURTAX', r.surtax)
  put('TAX_TOTAL', r.taxWithSurtax)
  put('WITHHOLDING', r.withholding)
  put('TAX_PAYABLE', r.payableRaw) // ㊾ 申告納税額（floor前）。計算の正は core — 描画層で再計算しない
  put('PAY_FINAL', r.payable)
  put('REFUND', r.refund)

  // --- 第二表: 所得の内訳 ---
  if (pages[1]) renderIncomeDetail(pages[1], font, r)

  return doc.save()
}

function renderIncomeDetail(page: PDFPage, font: PDFFont, r: ReturnType<typeof buildIncomeTaxReturn>): void {
  const t = KAKUTEI_OVERLAY.incomeDetail
  r.incomeDetail.slice(0, t.rowY.length).forEach((d, i) => {
    const y = t.rowY[i]
    drawLeft(page, font, t.kindX, y, '事業', t.size)
    drawLeft(page, font, t.itemX, y, '営業', t.size)
    drawLeft(page, font, t.payerX, y, d.payerName, t.size, t.revenueX - t.payerX - 12)
    drawRight(page, font, t.revenueX, y, formatYen(d.revenue), t.size)
    drawRight(page, font, t.withholdingX, y, formatYen(d.withholding), t.size)
  })
  drawRight(page, font, t.withholdingX, t.totalY, formatYen(r.withholding), t.size) // 49 源泉徴収税額の合計額
}
