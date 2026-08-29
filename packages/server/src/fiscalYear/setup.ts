import type { FiscalYearView } from '@kanean/shared'
export type { FiscalYearView }
import type { DataDb } from '../db/router.js'
import { fiscalYears } from '../db/data/schema.js'

type FiscalYearRow = typeof fiscalYears.$inferSelect

const MIN_YEAR = 2000
const MAX_YEAR = 2100

/**
 * 初回セットアップの推奨会計年度（西暦）。
 * 確定申告は前年分を翌年（おおむね2〜3月）に提出するため、1〜4月に使い始める人は
 * 前年分を処理しに来るのが大半。よって 1〜4月は前年、それ以外は当年を既定にする。
 * 個人事業は暦年（1/1〜12/31）前提。
 */
export function suggestInitialFiscalYear(now: Date): number {
  const month = now.getMonth() + 1 // 1-12
  const year = now.getFullYear()
  return month <= 4 ? year - 1 : year
}

/**
 * 初回の会計年度（暦年 1/1〜12/31・open）を1本だけ作成する。
 * - 年度がまだ無いときの初期設定専用。既に年度があれば拒否（翌年度の追加は決算・繰越で行う）。
 * - CSV先頭行から年度を推測する旧仕様（壊れたCSVで年度が誤確定する）を置き換える。
 */
export function createInitialFiscalYear(db: DataDb, year: number, now = new Date()): FiscalYearRow {
  if (!Number.isInteger(year) || year < MIN_YEAR || year > MAX_YEAR) {
    throw new Error(`会計年度の指定が不正です（${MIN_YEAR}〜${MAX_YEAR}の西暦で指定してください）`)
  }
  const existing = db.select({ id: fiscalYears.id }).from(fiscalYears).all()
  if (existing.length > 0) {
    throw new Error('会計年度は既に設定されています（翌年度の追加は「決算・繰越」から行います）')
  }
  return db
    .insert(fiscalYears)
    .values({ startDate: `${year}-01-01`, endDate: `${year}-12-31`, status: 'open', createdAt: now.toISOString() })
    .returning()
    .all()[0]
}
