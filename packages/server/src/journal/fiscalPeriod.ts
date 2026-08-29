/**
 * 会計期間ゲート（[[journal]]「取込明細からの自動仕訳」・[docs/csv-format.md] C-8）。
 *
 * 「その日付が会計年度の [start_date, end_date] に入るか」の判定を1箇所に持つ。同じ判定が
 * 取込（importer / ecImport / bankImport）と手入力（manualEntry）に散っていて、**仕訳化
 * （journalize）にだけ無かった**ため、繰越後に残った過年度の取込明細を復帰すると
 * `entry_date` が自分の会計年度の外にある仕訳ができていた。式を1つにして、抜けた層にも当てる。
 *
 * 判定は ISO 日付（YYYY-MM-DD）の辞書順比較。会計年度は暦年で重ならないため、これで一意に決まる。
 */

/** 会計期間の範囲（fiscal_years の必要部分だけ）。 */
export interface FiscalPeriod {
  startDate: string
  endDate: string
}

/** 期間ゲートに弾かれたことを呼出側が識別できる例外（route 層は 400 に対応づける）。 */
export class OutOfFiscalPeriodError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'OutOfFiscalPeriodError'
  }
}

/** 日付が会計期間に含まれるか（両端を含む）。 */
export function isInFiscalPeriod(fy: FiscalPeriod, date: string): boolean {
  return date >= fy.startDate && date <= fy.endDate
}

/**
 * 含まれなければ投げる。`label` は「何の日付か」（既定 `entryDate`）で、メッセージの主語になる。
 * 日付と範囲の両方を出す（利用者が「どちらがずれているか」を判断できるように）。
 */
export function assertInFiscalPeriod(fy: FiscalPeriod, date: string, label = 'entryDate'): void {
  if (!isInFiscalPeriod(fy, date)) {
    throw new OutOfFiscalPeriodError(`${label} ${date} は会計年度 [${fy.startDate}, ${fy.endDate}] の範囲外です`)
  }
}
