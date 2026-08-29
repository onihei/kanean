import { type Yen, yen } from '@kanean/shared'
import { loadOverlay } from './assets.js'
import type { DataDb } from '../db/router.js'
import { buildConsumptionTaxReturn } from '../taxreturn/consumptionTax.js'
import { drawDigitCells } from './digitCells.js'
import { SHOHI_OVERLAY } from './templates/shohiOverlay.js'

/**
 * 官製様式PDF（消費税申告書 簡易課税 第一表）への座標オーバーレイ出力。
 *
 * 数値は buildConsumptionTaxReturn に集約。金額欄は1桁1マスの手書き用セルなので
 * drawDigitCells で1桁ずつマス中心に置く。テンプレは gs 正規化で未平衡CTMが残るため embedPages
 * で背景化し原点座標で描く（aoiroOverlay/kakuteiOverlay と同方式）。座標は templates/shohiOverlay。
 *
 * ⚠️ legalRisk:high — 提出可否は税理士サインオフ対象。本PDFは確認用の参考帳票。
 */


export async function renderShohiOverlay(db: DataDb, fiscalYearId: number): Promise<Uint8Array> {
  const r = buildConsumptionTaxReturn(db, fiscalYearId)
  const { doc, font, pages } = await loadOverlay(SHOHI_OVERLAY.template, SHOHI_OVERLAY.font)
  const L = SHOHI_OVERLAY
  const p1 = pages[0]
  const m = L.page1
  const cellDefaults = { pitch: L.cellPitch, size: L.digitSize }
  const put = (code: string, amount: Yen) => drawDigitCells(p1, font, m[code], amount, cellDefaults)

  const deductSubtotal = yen(r.deemedDeduction + r.returnNational + r.badDebtNational)
  put('TAXBASE', r.taxBaseTotal) // ①
  put('SALESTAX', r.salesTaxNational) // ②
  put('DEEMED', r.deemedDeduction) // ④
  put('RETURN', r.returnNational) // ⑤
  put('BADDEBT', r.badDebtNational) // ⑥
  put('DEDUCT_SUBTOTAL', deductSubtotal) // ⑦
  put('NET_NATIONAL', r.national) // ⑨ 差引税額（国税）
  put('PAY_NATIONAL', r.national) // ⑪ 納付税額（国税・中間0前提）
  put('LOCAL_BASE', r.national) // ⑯ 地方計算の基礎（国税差引）
  put('LOCAL_TAX', r.local) // 譲渡割額 納税額
  put('LOCAL_PAY', r.local) // 納付譲渡割額
  put('TOTAL', r.payable) // 60 合計税額

  return doc.save()
}
