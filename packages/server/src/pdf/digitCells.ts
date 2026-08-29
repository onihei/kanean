import type { PDFFont, PDFPage } from 'pdf-lib'

/**
 * 官製様式の「1桁1マス」金額欄への差込描画。
 *
 * 確定申告書第一表・消費税申告書の金額欄は手書き用の桁マス（カンマ記号は様式側に事前印字）
 * なので、カンマ付き文字列の右寄せではなく1桁ずつマス中心に置く。e-Tax・市販ソフトの
 * 印刷出力と同方式。座標較正はテンプレートの桁マス罫線の実測による（templates/*）。
 */

/** 1桁1マス欄の差込定義。 */
export interface DigitCell {
  /** 右端マスの中心 x。 */
  x: number
  /** マス帯（セル箱）の中心 y（baseline ではない）。 */
  y: number
  /** 様式に事前印字された末尾0のマス数（千円=3・百円=2・万円=4）。値は 10^zeros の倍数前提。 */
  zeros?: number
  size?: number
}

/** 数字グリフの概算高さ／フォントサイズ比（IPAexゴシック近似）。マス中心 y → baseline の換算用。 */
const DIGIT_HEIGHT_RATIO = 0.72

/**
 * 金額を1桁ずつマス中心に置く（右詰め・カンマなし）。0 は空欄（官製様式の慣習）。
 * zeros 指定欄は事前印字の0マスを避け、値/10^zeros の桁を左へ詰める。倍数でない値は
 * 事前印字と衝突するため安全側で描かない（集計側で切捨て済みが前提）。負数は '-' が1マス使う。
 */
export function drawDigitCells(
  page: PDFPage,
  font: PDFFont,
  cell: DigitCell | undefined,
  amount: number,
  defaults: { pitch: number; size: number },
): void {
  if (!cell || amount === 0) return
  const zeros = cell.zeros ?? 0
  if (zeros > 0 && amount % 10 ** zeros !== 0) return
  const size = cell.size ?? defaults.size
  const baseline = cell.y - (DIGIT_HEIGHT_RATIO * size) / 2
  const text = String(amount / 10 ** zeros)
  for (let i = 0; i < text.length; i++) {
    const ch = text[text.length - 1 - i]
    // 右端マスから zeros 個（事前印字の0）を空けて右詰め
    const cx = cell.x - (zeros + i) * defaults.pitch
    page.drawText(ch, { x: cx - font.widthOfTextAtSize(ch, size) / 2, y: baseline, size, font })
  }
}
