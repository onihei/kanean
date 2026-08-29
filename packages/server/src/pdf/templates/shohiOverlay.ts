import type { DigitCell } from '../digitCells.js'

/**
 * 官製様式PDF（消費税及び地方消費税確定申告書 簡易課税用 第一表）への座標オーバーレイ定義。
 *
 * テンプレ = assets/forms/shohi_kani_r05.pdf（国税庁様式を gs 正規化した提出用 第一表 1ページ）。
 * 数値は buildConsumptionTaxReturn に集約し、本座標は各マスへの差込位置のみ。座標は pt・左下原点で、
 * embedPages（Form XObject）後の描画空間（= レンダラの座標空間）における実測値。
 *
 * 金額欄は1桁1マスの手書き用セル（13マス・カンマ記号は様式に事前印字）なので、
 * DigitCell（右端マス中心 x・マス帯中心 y）に1桁ずつ差込む（digitCells.ts）。
 * 較正の実測値（桁マス罫線のラスタ解析＋事前印字0グリフ位置で検証。2026-06 較正）:
 *   - 桁マスはピッチ 13.91・右端マス中心 324.7（全行共通）。マス帯高 14。
 *   - 国税ブロックは①〜⑪がマス帯中心 y=538.8 からピッチ 17.5 の等間隔。
 *   - 地方ブロック（⑰〜㉕）と合計㉖は等間隔でないため行ごとに実測。
 *
 * 事前印字の0（zeros）: ①課税標準額=000（千円未満切捨て）・⑨⑪⑱⑳㉒差引/納付税額=00
 * （百円未満切捨て）。対象金額は集計側（core simplifiedTax ほか）で切捨て済み。
 */

/** 右端マスの中心 x（全行共通。事前印字0の最終グリフ中心=324.7 と一致することを実測確認済み）。 */
const CELL_X = 324.7

const SHOHI_P1: Record<string, DigitCell> = {
  // この申告書による消費税の税額の計算（国税）
  'TAXBASE': { x: CELL_X, y: 538.8, zeros: 3 }, // ① 課税標準額（000事前印字）
  'SALESTAX': { x: CELL_X, y: 521.4 }, // ② 消費税額
  'DEEMED': { x: CELL_X, y: 486.5 }, // ④ 控除対象仕入税額（みなし）
  'RETURN': { x: CELL_X, y: 469.0 }, // ⑤ 返還等対価に係る税額
  'BADDEBT': { x: CELL_X, y: 451.5 }, // ⑥ 貸倒れに係る税額
  'DEDUCT_SUBTOTAL': { x: CELL_X, y: 434.2 }, // ⑦ 控除税額小計（④+⑤+⑥）
  'NET_NATIONAL': { x: CELL_X, y: 399.2, zeros: 2 }, // ⑨ 差引税額（国税・00事前印字）
  'PAY_NATIONAL': { x: CELL_X, y: 364.3, zeros: 2 }, // ⑪ 納付税額（国税・00事前印字）
  // この申告書による地方消費税の税額の計算
  'LOCAL_BASE': { x: CELL_X, y: 224.6, zeros: 2 }, // ⑱ 差引税額（地方の課税標準＝国税差引・00事前印字）
  'LOCAL_TAX': { x: CELL_X, y: 189.7, zeros: 2 }, // ⑳ 納税額（00事前印字）
  'LOCAL_PAY': { x: CELL_X, y: 154.75, zeros: 2 }, // ㉒ 納付譲渡割額（⑳−㉑・00事前印字）
  // 合計
  'TOTAL': { x: CELL_X, y: 76.2 }, // ㉖ 消費税及び地方消費税の合計（納付又は還付）税額
}

export interface ShohiOverlay {
  template: string
  font: string
  /** 桁マス差込のフォントサイズ（マス帯高14に対する手書き相当の大きさ）。 */
  digitSize: number
  /** 桁マスのピッチ。 */
  cellPitch: number
  page1: Record<string, DigitCell>
}

export const SHOHI_OVERLAY: ShohiOverlay = {
  template: 'shohi_kani_r05.pdf',
  font: 'ipaexg.ttf',
  digitSize: 12,
  cellPitch: 13.91,
  page1: SHOHI_P1,
}
