import type { DigitCell } from '../digitCells.js'

/**
 * 官製様式PDF（確定申告書 第一表・第二表 一般用）への座標オーバーレイ定義（外部データ化）。
 *
 * テンプレ = assets/forms/kakutei_r05.pdf（国税庁様式を gs 正規化した提出用2ページ）。
 * 数値は buildIncomeTaxReturn に集約し、本座標は「どのマスに差込むか」のみを持つ。
 * 年度様式が変わったらテンプレ差替え＋本座標の再較正で対応する。座標は pt・左下原点で、
 * embedPages（Form XObject）後の描画空間（= レンダラの座標空間）における実測値。
 *
 * 第一表の金額欄は1桁1マスの手書き用セル（カンマ記号は様式に事前印字）なので、
 * DigitCell（右端マス中心 x・マス帯中心 y）に1桁ずつ差込む（digitCells.ts）。
 * 較正の実測値（桁マス罫線のラスタ解析。2026-06 較正）:
 *   - 行はマス帯中心 y=650.0 からピッチ 16.5 の等間隔（マス帯高 14）。左右列で共通。
 *   - 桁マスはピッチ 14.0。右端マス中心は左列（収入・所得・控除）=283.0／右列（税金の計算）=534.6。
 *   - 先頭（左端）マスのみ幅広（約26pt）。通常マス7個＋幅広1個 ≒ 8桁。
 *
 * 事前印字の0（zeros）:
 *   ㉚課税される所得金額=000（千円）・51納める税金=00（百円）・㉓扶養控除/㉔基礎控除=0000（万円）。
 *   対象金額は集計側で各単位に切捨て済み（taxableIncome=千円・payable=百円。万円欄は入力値を検証）。
 */

/** 左列（収入金額等・所得金額等・所得から差し引かれる金額）の右端マス中心 x。 */
const LEFT_X = 283.0
/** 右列（税金の計算）の右端マス中心 x。 */
const RIGHT_X = 534.6

// ===== ページ1: 第一表 =====
const K1: Record<string, DigitCell> = {
  // 収入金額等
  'REVENUE_BIZ': { x: LEFT_X, y: 650.0 }, // ㋐ 事業（営業等）収入
  // 所得金額等
  'INCOME_BIZ': { x: LEFT_X, y: 452.0 }, // ① 事業（営業等）所得
  'INCOME_TOTAL': { x: LEFT_X, y: 287.0 }, // ⑫ 合計
  // 所得から差し引かれる金額
  'DEDUCT_SOCIAL': { x: LEFT_X, y: 270.5 }, // ⑬ 社会保険料控除
  'DEDUCT_LIFE': { x: LEFT_X, y: 237.5 }, // ⑮ 生命保険料控除
  // 配偶者控除と扶養控除を区別できないため、lump 値（spouseDependents）は扶養控除㉓へ寄せる（近似）
  'DEDUCT_DEPEND': { x: LEFT_X, y: 155.0, zeros: 4 }, // ㉓ 扶養控除（0000事前印字）
  'DEDUCT_BASIC': { x: LEFT_X, y: 138.5, zeros: 4 }, // ㉔ 基礎控除（0000事前印字）
  'DEDUCT_MEDICAL': { x: LEFT_X, y: 89.0 }, // ㉗ 医療費控除
  'DEDUCT_TOTAL': { x: LEFT_X, y: 56.0 }, // ㉙ 合計
  // 税金の計算
  'TAXABLE': { x: RIGHT_X, y: 650.0, zeros: 3 }, // ㉚ 課税される所得金額（000事前印字）
  'BASE_TAX': { x: RIGHT_X, y: 633.5 }, // ㉛ 上の㉚に対する税額
  'SURTAX': { x: RIGHT_X, y: 485.0 }, // 44 復興特別所得税額（×2.1%）
  'TAX_TOTAL': { x: RIGHT_X, y: 468.5 }, // 45 所得税及び復興特別所得税の額
  'WITHHOLDING': { x: RIGHT_X, y: 435.5 }, // 48 源泉徴収税額
  'TAX_PAYABLE': { x: RIGHT_X, y: 419.0 }, // 49 申告納税額
  'PAY_FINAL': { x: RIGHT_X, y: 386.0, zeros: 2 }, // 51 第3期分の税額（納める税金・00事前印字）
  'REFUND': { x: RIGHT_X, y: 369.5 }, // 52 還付される税金
}

// ===== ページ2: 第二表（所得の内訳） =====
// 自由記入欄（桁マスなし）のため従来どおり右寄せ/左寄せのテキスト差込。
export interface IncomeDetailTableDef {
  /** 所得の種類 左端 x。 */
  kindX: number
  /** 種目 左端 x。 */
  itemX: number
  /** 支払者の名称 左端 x。 */
  payerX: number
  /** 収入金額 右端 x。 */
  revenueX: number
  /** 源泉徴収税額 右端 x。 */
  withholdingX: number
  /** データ行 baseline y（上→下）。 */
  rowY: number[]
  /** 49 源泉徴収税額の合計額 baseline y。 */
  totalY: number
  size: number
}

const K2_INCOME_DETAIL: IncomeDetailTableDef = {
  kindX: 36,
  itemX: 100,
  payerX: 124,
  revenueX: 268,
  withholdingX: 300,
  rowY: [548, 530, 512, 494],
  totalY: 478,
  size: 7,
}

export interface KakuteiOverlay {
  template: string
  font: string
  /** 桁マス差込のフォントサイズ（マス帯高14に対する手書き相当の大きさ）。 */
  digitSize: number
  /** 桁マスのピッチ。 */
  cellPitch: number
  /** 第一表（1桁1マス欄）。 */
  page1: Record<string, DigitCell>
  incomeDetail: IncomeDetailTableDef
}

export const KAKUTEI_OVERLAY: KakuteiOverlay = {
  template: 'kakutei_r05.pdf',
  font: 'ipaexg.ttf',
  digitSize: 12,
  cellPitch: 14.0,
  page1: K1,
  incomeDetail: K2_INCOME_DETAIL,
}
