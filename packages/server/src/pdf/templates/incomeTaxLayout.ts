/**
 * 確定申告書（第一表・第二表）の自前レイアウト定義（外部データ化）。
 *
 * 数値は buildIncomeTaxReturn（taxreturn/incomeTax）に集約し、本レイアウトは座標・サイズのみ持つ。
 * 官製様式PDFは未同梱のため自前A4描画（青色決算書 損益の aoiroP1Layout と同方針）。入手後は
 * 座標オーバーレイ方式（architecture §8）へ差替え可能なよう、描画ロジックと座標を分離する。
 * 単位は pt（1/72 inch）、原点は左下。官製様式の欄番号は年度で変わるため本帳票では印字しない。
 */
export interface IncomeTaxLayout {
  page: { width: number; height: number }
  margin: { top: number; bottom: number; left: number; right: number }
  font: {
    /** assets/fonts からの相対ファイル名。 */
    file: string
    titleSize: number
    headerSize: number
    sectionSize: number
    bodySize: number
  }
  rowHeight: number
  /** 第一表（ラベル＋金額）。 */
  col: {
    /** 科目ラベル左端 x。 */
    label: number
    /** 金額右端 x（右寄せ基準）。 */
    amountRight: number
  }
  /** 第二表「所得の内訳」テーブルの列 x。 */
  table: {
    kind: number // 所得の種類 左端
    payer: number // 支払者の氏名・名称 左端
    revenueRight: number // 収入金額 右端
    withholdingRight: number // 源泉徴収税額 右端
  }
}

const A4 = { width: 595.28, height: 841.89 }

export const INCOME_TAX_LAYOUT: IncomeTaxLayout = {
  page: A4,
  margin: { top: 42, bottom: 42, left: 48, right: 48 },
  font: { file: 'ipaexg.ttf', titleSize: 15, headerSize: 10, sectionSize: 11, bodySize: 9 },
  rowHeight: 18,
  col: {
    label: 70,
    amountRight: A4.width - 56,
  },
  table: {
    kind: 56,
    payer: 150,
    revenueRight: A4.width - 170,
    withholdingRight: A4.width - 56,
  },
}
