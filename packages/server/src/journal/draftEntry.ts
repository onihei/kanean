import { journalEntries, journalLines } from '../db/data/schema.js'
import type { DataDb, DataTx } from '../db/router.js'
import type { ResolvedLineTax } from './lineTax.js'

/**
 * draft 仕訳（ヘッダ＋2行）の挿入ヘルパ（issue #122 = B10）。
 * 取込（銀行/EC/注文調整）・自動仕訳・振替名寄せの5経路で同文だった insert 2連を一本化する。
 * raw_transactions の update は経路毎に意味が違う（suggested の記録有無・settlement リンク等）ため
 * 呼び出し側に残す（options 化もしない）。
 */

export type TwoLineDraftHeader = {
  fiscalYearId: number
  entryDate: string
  description: string | null
  /** 'import' / 'auto_rule' / 'auto_institution' / 'transfer' 等（journal spec）。 */
  source: string
  sourceRef: string
}

export type TwoLineDraftLine = {
  side: 'debit' | 'credit'
  accountId: number
  subAccountId?: number | null
  /** resolveLineTax の結果を明示的に渡す（ここでは既定解決しない）。 */
  tax: ResolvedLineTax
  amount: number
}

/** ヘッダ＋lineNo=1/2 の2行を挿入し、entry id を返す。tx 内でも使える（DataTx 互換）。 */
export function createTwoLineDraftEntry(
  db: DataDb | DataTx,
  header: TwoLineDraftHeader,
  line1: TwoLineDraftLine,
  line2: TwoLineDraftLine,
): number {
  const now = new Date().toISOString()
  const entry = db
    .insert(journalEntries)
    .values({ ...header, status: 'draft', createdAt: now, updatedAt: now })
    .returning()
    .all()[0]
  const toRow = (line: TwoLineDraftLine, lineNo: number) => ({
    entryId: entry.id,
    lineNo,
    side: line.side,
    accountId: line.accountId,
    subAccountId: line.subAccountId ?? null,
    taxCategoryId: line.tax.taxCategoryId,
    taxAmount: line.tax.taxAmount,
    amount: line.amount,
    prorationApplied: false,
  })
  db.insert(journalLines)
    .values([toRow(line1, 1), toRow(line2, 2)])
    .run()
  return entry.id
}
