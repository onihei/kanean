/**
 * 消費税及び地方消費税申告書（簡易課税）の自前レイアウト定義（外部データ化）。
 *
 * 数値は buildConsumptionTaxReturn（taxreturn/consumptionTax）に集約し、本レイアウトは座標のみ。
 * 官製様式PDF未同梱のため自前A4描画（incomeTaxLayout と同方針）。単位 pt・原点 左下。
 */
export interface ConsumptionTaxLayout {
  page: { width: number; height: number }
  margin: { top: number; bottom: number; left: number; right: number }
  font: {
    file: string
    titleSize: number
    headerSize: number
    sectionSize: number
    bodySize: number
  }
  rowHeight: number
  /** 税額計算（ラベル＋金額）。 */
  col: { label: number; amountRight: number }
  /** 税率別 課税標準額・売上税額テーブルの列 x。 */
  table: {
    rate: number // 税率 左端
    baseRight: number // 課税標準額 右端
    taxRight: number // 売上消費税額(国税) 右端
  }
}

const A4 = { width: 595.28, height: 841.89 }

export const CONSUMPTION_TAX_LAYOUT: ConsumptionTaxLayout = {
  page: A4,
  margin: { top: 42, bottom: 42, left: 48, right: 48 },
  font: { file: 'ipaexg.ttf', titleSize: 15, headerSize: 10, sectionSize: 11, bodySize: 9 },
  rowHeight: 18,
  col: {
    label: 70,
    amountRight: A4.width - 56,
  },
  table: {
    rate: 80,
    baseRight: 360,
    taxRight: A4.width - 56,
  },
}
