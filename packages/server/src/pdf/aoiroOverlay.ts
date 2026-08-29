import { type PDFFont, type PDFPage } from 'pdf-lib'
import { type Yen } from '@kanean/shared'
import { depreciationBasis } from '@kanean/core'
import { formatYen, loadOverlay } from './assets.js'
import type { DataDb } from '../db/router.js'
import { buildBlueReturnStatement } from '../reports/blueReturnStatement.js'
import { buildBlueBalanceSheet } from '../reports/blueBalanceSheet.js'
import { buildBlueReturnSummary } from '../taxreturn/blueReturn.js'
import {
  depreciationBreakdown,
  monthlySalesPurchase,
  reserveAllowanceCalc,
  salaryBreakdown,
  senjuBreakdown,
  rentBreakdown,
  type DepreciationRow,
} from '../reports/breakdowns.js'
import { drawDigitCells } from './digitCells.js'
import { AOIRO_OVERLAY, TABLES, type ColDef } from './templates/aoiroOverlay.js'

/**
 * 官製様式PDF（青色申告決算書 一般用）への座標オーバーレイ出力（rank: official-overlay）。
 *
 * 数値は rank3/rank4（buildBlueReturnStatement 等）に集約し、本モジュールは
 * 「正規化済みテンプレPDFを読み込み、各欄に金額を差込」する描画層に徹する。
 * P1 損益と P2 月別表の計行は1桁1マスの手書き用セルなので drawDigitCells で
 * 1桁ずつマス中心に置く（0 は空欄）。その他はマスのない自由記入欄への右寄せ差込。
 * 座標は templates/aoiroOverlay.ts に外部化（年度様式差替え対応）。
 *
 * ⚠️ legalRisk:high — 提出可否は税理士サインオフ対象。本PDFは確認用の参考帳票。
 */



/** 列定義に従い align（left/right/center）で 1 セルを描く。 */
function drawCell(page: PDFPage, font: PDFFont, col: ColDef, text: string, baseY: number, defaultSize: number): void {
  if (text === '') return
  const size = col.size ?? defaultSize
  const w = font.widthOfTextAtSize(text, size)
  const x = col.align === 'right' ? col.x - w : col.align === 'center' ? col.x - w / 2 : col.x
  page.drawText(text, { x, y: baseY + (col.yOffset ?? 0), size, font })
}

/** 取得年月を和暦（R/H/S）に整形（narrow セル向け）。例: 2020-04 → R2.4。 */
function eraYearMonth(date: string | null): string {
  if (!date) return ''
  const y = Number(date.slice(0, 4))
  const m = Number(date.slice(5, 7))
  if (!y || !m) return ''
  if (y > 2019 || (y === 2019 && m >= 5)) return `R${y - 2018}.${m}`
  if (y > 1989 || (y === 1989 && m >= 1)) return `H${y - 1988}.${m}`
  return `S${y - 1925}.${m}`
}

const METHOD_JP: Record<string, string> = {
  straight_line: '定額',
  declining_balance: '定率',
  lump_sum: '一括',
  minor_special: '少額',
  old_straight_line: '旧定額',
  old_declining_balance: '旧定率',
}

/** ロ償却の基礎になる金額。税法規約は core（depreciationBasis）が正（issue #113）。 */
function basisOf(r: DepreciationRow): Yen {
  return depreciationBasis(r.depreciationMethod, r.acquisitionCost, r.openingBookValue)
}

/** ニ本年中の償却期間（分子の月数）。ホ＝ロ×ハ×(月/12) から逆算（full-year は 12）。 */
function depreciationMonths(r: DepreciationRow, basis: Yen): number {
  const denom = basis * (r.depreciationRate ?? 0)
  if (denom <= 0) return 12
  const m = Math.round((12 * r.depreciationAmount) / denom)
  return Math.min(12, Math.max(1, m))
}

function ratioText(ratio: number): string {
  return Number.isInteger(ratio) ? String(ratio) : ratio.toFixed(1)
}
function rateText(rate: number | null): string {
  if (rate == null) return ''
  return Number.isInteger(rate) ? String(rate) : rate.toFixed(3)
}

export async function renderAoiroOverlay(db: DataDb, fiscalYearId: number): Promise<Uint8Array> {
  // gs 正規化テンプレは content stream に未平衡な座標変換が残り、load して直描き／copyPages すると
  // CTM を継承して描画位置がズレる。テンプレ各ページを Form XObject 化（embedPages）し、新規の
  // 白紙ページへ drawPage して背景にし、その上に金額を描く（描画はページ原点＝左下のクリーン座標）。
  const { doc, font, pages } = await loadOverlay(AOIRO_OVERLAY.template, AOIRO_OVERLAY.font)
  const L = AOIRO_OVERLAY

  // --- ページ1: 損益計算書（1桁1マス欄。0 は空欄＝官製様式の慣習） ---
  const p1 = pages[0]
  const map1 = L.pages[0]
  const { pl } = buildBlueReturnStatement(db, fiscalYearId)
  const cellDefaults = { pitch: L.cellPitch, size: L.digitSize }
  const put1 = (code: string, amount: Yen) => drawDigitCells(p1, font, map1[code], amount, cellDefaults)

  put1('AOIRO.PL.SALES', pl.sales.amount)
  put1('AOIRO.PL.OPEN_STOCK', pl.openStock.amount)
  put1('AOIRO.PL.PURCHASE', pl.purchase.amount)
  put1('AOIRO.PL.SUBTOTAL_COST', pl.subtotalCost.amount)
  put1('AOIRO.PL.CLOSE_STOCK', pl.closeStock.amount)
  put1('AOIRO.PL.COST', pl.costOfSales.amount)
  put1('AOIRO.PL.GROSS', pl.grossProfit.amount)
  for (const e of pl.expenses) put1(e.code, e.amount) // 標準⑧〜㉔ + 空欄 + 雑費
  put1('AOIRO.PL.EXP_TOTAL', pl.expenseTotal.amount)
  put1('AOIRO.PL.NET_BEFORE_ADJ', pl.netBeforeAdjust.amount)
  put1('AOIRO.PL.RESERVE_BACK', pl.reserveBack.amount)
  put1('AOIRO.PL.RESERVE_IN', pl.reserveIn.amount)
  put1('AOIRO.PL.SENJU', pl.senju.amount)
  put1('AOIRO.PL.INCOME_BEFORE', pl.incomeBeforeDeduction.amount)
  put1('AOIRO.PL.BLUE_DEDUCT', pl.blueDeduction.amount)
  put1('AOIRO.PL.INCOME', pl.income.amount)

  // --- ページ2: 月別売上仕入・各種内訳・青色申告特別控除額の計算 ---
  renderPage2(pages[1], font, db, fiscalYearId, cellDefaults)

  // --- ページ3: 減価償却費の計算 ---
  renderPage3(pages[2], font, db, fiscalYearId)

  // --- ページ4: 貸借対照表 ---
  renderPage4(pages[3], font, db, fiscalYearId)

  return doc.save()
}

/** 右寄せ（空文字はスキップ）。 */
function drawRight(page: PDFPage, font: PDFFont, x: number, y: number, text: string, size: number): void {
  if (text === '') return
  page.drawText(text, { x: x - font.widthOfTextAtSize(text, size), y, size, font })
}
/** 金額（0/未設定は空欄）。 */
function amt(v: Yen): string {
  return v === 0 ? '' : formatYen(v)
}

/** 左寄せ（空文字スキップ・長すぎる名称は切り詰め）。 */
function drawLeft(page: PDFPage, font: PDFFont, x: number, y: number, text: string, size: number, maxW?: number): void {
  if (text === '') return
  let t = text
  if (maxW) {
    while (t.length > 1 && font.widthOfTextAtSize(t, size) > maxW) t = t.slice(0, -1)
  }
  page.drawText(t, { x, y, size, font })
}

/** ページ2「月別売上仕入・各種内訳・青色申告特別控除額の計算」。 */
function renderPage2(
  page: PDFPage,
  font: PDFFont,
  db: DataDb,
  fiscalYearId: number,
  cellDefaults: { pitch: number; size: number },
): void {
  const t = TABLES.p2

  // 月別売上(収入)金額及び仕入金額（1〜12月は自由記入欄・計行は桁マス）
  const m = monthlySalesPurchase(db, fiscalYearId)
  for (let i = 0; i < 12; i++) {
    const y = t.monthly.rowY[i]
    drawRight(page, font, t.monthly.salesX, y, amt(m.rows[i].sales), t.monthly.size)
    drawRight(page, font, t.monthly.purchaseX, y, amt(m.rows[i].purchases), t.monthly.size)
  }
  drawDigitCells(page, font, t.monthly.totalSales, m.salesTotal, cellDefaults)
  drawDigitCells(page, font, t.monthly.totalPurchase, m.purchasesTotal, cellDefaults)

  // 給料賃金の内訳（氏名＋合計）
  if (t.salary.rowY.length) {
    const sal = salaryBreakdown(db, fiscalYearId)
    sal.rows.slice(0, t.salary.rowY.length).forEach((r, i) => {
      drawLeft(page, font, t.salary.nameX, t.salary.rowY[i], r.name, t.salary.labelSize, t.salary.amountX - t.salary.nameX - 90)
      drawRight(page, font, t.salary.amountX, t.salary.rowY[i], amt(r.amount), t.salary.size)
    })
    drawRight(page, font, t.salary.amountX, t.salary.totalY, amt(sal.total), t.salary.size)
  }

  // 専従者給与の内訳（氏名＋合計）
  if (t.senju.rowY.length) {
    const sj = senjuBreakdown(db, fiscalYearId)
    sj.rows.slice(0, t.senju.rowY.length).forEach((r, i) => {
      drawLeft(page, font, t.senju.nameX, t.senju.rowY[i], r.name, t.senju.labelSize, t.senju.amountX - t.senju.nameX - 90)
      drawRight(page, font, t.senju.amountX, t.senju.rowY[i], amt(r.amount), t.senju.size)
    })
    drawRight(page, font, t.senju.amountX, t.senju.totalY, amt(sj.total), t.senju.size)
  }

  // 地代家賃の内訳（支払先＋必要経費算入額）
  if (t.rent.rowY.length) {
    const rent = rentBreakdown(db, fiscalYearId)
    rent.rows.slice(0, t.rent.rowY.length).forEach((r, i) => {
      drawLeft(page, font, t.rent.nameX, t.rent.rowY[i], r.name, t.rent.labelSize, t.rent.rentX - t.rent.nameX - 20)
      drawRight(page, font, t.rent.rentX, t.rent.rowY[i], amt(r.amount), t.rent.size)
      drawRight(page, font, t.rent.expenseX, t.rent.rowY[i], amt(r.amount), t.rent.size)
    })
  }

  // 青色申告特別控除額の計算（⑦控除前所得・⑨控除額）
  if (t.deduction.valueX) {
    const s = buildBlueReturnSummary(db, fiscalYearId)
    drawRight(page, font, t.deduction.valueX, t.deduction.incomeBeforeY, amt(s.incomeBeforeDeduction), t.deduction.size)
    const y = s.deductionLimit >= 550_000 ? t.deduction.deduction65Y : t.deduction.deduction10Y
    drawRight(page, font, t.deduction.valueX, y, amt(s.deduction), t.deduction.size)
  }

  // 貸倒引当金繰入額の計算（①〜⑤・⑤=繰入額が無ければ表全体を空欄）
  if (t.reserve.valueX && t.reserve.rowY.length >= 6) {
    const rc = reserveAllowanceCalc(db, fiscalYearId)
    if (rc.total > 0) {
      const r = t.reserve
      drawRight(page, font, r.valueX, r.rowY[1], amt(rc.individual), r.size) // ① 個別評価（0→空欄）
      drawRight(page, font, r.valueX, r.rowY[2], amt(rc.grossReceivables), r.size) // ② 年末一括評価貸金
      drawRight(page, font, r.valueX, r.rowY[3], amt(rc.limit), r.size) // ③ 繰入限度額（②×5.5%）
      drawRight(page, font, r.valueX, r.rowY[4], amt(rc.lumpReserve), r.size) // ④ 一括繰入額
      drawRight(page, font, r.valueX, r.rowY[5], amt(rc.total), r.size) // ⑤ 繰入額計
    }
  }
}

/** ページ4「貸借対照表」に資産/負債・資本の期首・期末を差し込む。 */
function renderPage4(page: PDFPage, font: PDFFont, db: DataDb, fiscalYearId: number): void {
  const t = TABLES.p4BalanceSheet
  const bs = buildBlueBalanceSheet(db, fiscalYearId)

  for (const r of bs.assets) {
    const y = t.rowY[r.row]
    if (y == null) continue
    if (r.label) page.drawText(r.label, { x: t.assetLabelX, y, size: t.labelSize, font })
    drawRight(page, font, t.assetKishu, y, amt(r.opening), t.size)
    drawRight(page, font, t.assetKimatsu, y, amt(r.closing), t.size)
  }
  for (const r of bs.liabilities) {
    const y = t.rowY[r.row]
    if (y == null) continue
    if (r.label) page.drawText(r.label, { x: t.liabLabelX, y, size: t.labelSize, font })
    drawRight(page, font, t.liabKishu, y, amt(r.opening), t.size)
    drawRight(page, font, t.liabKimatsu, y, amt(r.closing), t.size)
  }
  // 合計行
  drawRight(page, font, t.assetKishu, t.totalY, amt(bs.assetTotal.opening), t.size)
  drawRight(page, font, t.assetKimatsu, t.totalY, amt(bs.assetTotal.closing), t.size)
  drawRight(page, font, t.liabKishu, t.totalY, amt(bs.liabTotal.opening), t.size)
  drawRight(page, font, t.liabKimatsu, t.totalY, amt(bs.liabTotal.closing), t.size)
}

/** ページ3「減価償却費の計算」表に資産明細を差し込む（最大行数まで・超過分は計のみ反映）。 */
function renderPage3(page: PDFPage, font: PDFFont, db: DataDb, fiscalYearId: number): void {
  const t = TABLES.p3Depreciation
  const { rows, depreciationTotal, businessAmountTotal } = depreciationBreakdown(db, fiscalYearId)
  const colOf = (field: string) => t.cols.find((c) => c.field === field)
  const cell = (field: string, text: string, baseY: number) => {
    const c = colOf(field)
    if (c) drawCell(page, font, c, text, baseY, t.size)
  }

  for (let i = 0; i < Math.min(rows.length, t.rowY.length); i++) {
    const r = rows[i]
    const y = t.rowY[i]
    const basis = basisOf(r)
    const special = r.specialDepreciation ?? 0
    cell('name', r.name, y)
    cell('qty', r.quantityOrArea ? String(r.quantityOrArea) : '', y)
    cell('acquired', eraYearMonth(r.acquiredDate), y)
    cell('cost', formatYen(r.acquisitionCost), y)
    cell('basis', formatYen(basis), y)
    cell('method', METHOD_JP[r.depreciationMethod] ?? '', y)
    cell('life', r.usefulLife != null ? String(r.usefulLife) : '', y)
    cell('rate', rateText(r.depreciationRate), y)
    cell('months', String(depreciationMonths(r, basis)), y)
    cell('dep', formatYen(r.depreciationAmount), y)
    cell('special', special ? formatYen(special as Yen) : '', y)
    cell('total', formatYen((r.depreciationAmount + special) as Yen), y)
    cell('ratio', ratioText(r.businessUseRatio), y)
    cell('expense', formatYen(r.businessAmount), y)
    cell('closing', formatYen(r.closingBookValue), y)
  }

  // 計（合計）行: ホ普通償却費計 / ト合計 / リ必要経費算入額計（== 損益⑱）。
  const specialTotal = rows.reduce((s, r) => s + (r.specialDepreciation ?? 0), 0)
  cell('dep', formatYen(depreciationTotal), t.totalRowY)
  cell('total', formatYen((depreciationTotal + specialTotal) as Yen), t.totalRowY)
  cell('expense', formatYen(businessAmountTotal), t.totalRowY)
}
