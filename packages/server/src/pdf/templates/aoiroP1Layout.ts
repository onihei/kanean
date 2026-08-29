/**
 * 青色申告決算書 損益ページ（1ページ目相当）の自前レイアウト定義（外部データ化）。
 *
 * rank2 は官製様式PDFが未入手のため pdf-lib で損益計算書を自前A4描画する。座標・サイズを
 * このモジュールに分離し、後日 官製様式PDFを入手したら座標オーバーレイ方式（architecture §8）へ
 * 差し替えやすくする（年度様式の差替え対応）。単位は pt（1/72 inch）、原点は左下。
 */
export interface AoiroP1Layout {
  /** ページサイズ（A4 縦）。 */
  page: { width: number; height: number }
  margin: { top: number; bottom: number; left: number; right: number }
  font: {
    /** assets/fonts からの相対ファイル名（aoiroPdf が ../../assets/fonts 配下を解決）。 */
    file: string
    titleSize: number
    headerSize: number
    bodySize: number
  }
  /** 1行の高さ。 */
  rowHeight: number
  col: {
    /** 丸数字（box）の左端 x。 */
    box: number
    /** 科目ラベルの左端 x。 */
    label: number
    /** 金額の右端 x（右寄せ基準）。 */
    amountRight: number
  }
}

const A4 = { width: 595.28, height: 841.89 }

export const AOIRO_P1: AoiroP1Layout = {
  page: A4,
  margin: { top: 42, bottom: 42, left: 48, right: 48 },
  font: { file: 'ipaexg.ttf', titleSize: 15, headerSize: 10, bodySize: 9 },
  rowHeight: 16,
  col: {
    box: 50,
    label: 80,
    amountRight: A4.width - 50,
  },
}
