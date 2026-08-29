/** 手入力・編集フォームの明細行（UI 状態）と送信用への変換。 */
import type { ManualEntryLineInput } from '../api.js'

// UI 状態では「未選択」を 0 で表す（送信時に null へ変換）。
export type EntryLine = {
  side: 'debit' | 'credit'
  accountId: number
  amount: number
  subAccountId: number
  counterpartyId: number
  departmentId: number
}

export const emptyLine = (side: 'debit' | 'credit'): EntryLine => ({
  side,
  accountId: 0,
  amount: 0,
  subAccountId: 0,
  counterpartyId: 0,
  departmentId: 0,
})

export const toLineInput = (l: EntryLine): ManualEntryLineInput => ({
  side: l.side,
  accountId: l.accountId,
  amount: l.amount,
  subAccountId: l.subAccountId || null,
  counterpartyId: l.counterpartyId || null,
  departmentId: l.departmentId || null,
})

/** 貸借集計（ManualEntry / Journal 編集で同文だった式を1箇所に。issue #131）。 */
export interface EntryTotals {
  debitTotal: number
  creditTotal: number
  /** 借方計 − 貸方計。 */
  diff: number
  /** 貸借一致かつ金額が入っている（0円の仕訳は組めない）。 */
  balanced: boolean
}

export function entryTotals(lines: EntryLine[]): EntryTotals {
  const debitTotal = lines.filter((l) => l.side === 'debit').reduce((s, l) => s + (l.amount || 0), 0)
  const creditTotal = lines.filter((l) => l.side === 'credit').reduce((s, l) => s + (l.amount || 0), 0)
  const diff = debitTotal - creditTotal
  return { debitTotal, creditTotal, diff, balanced: diff === 0 && debitTotal > 0 }
}

/** 起票/保存できるか: 貸借一致・日付あり・全行が科目選択済みで正の円整数。 */
export function entriesReady(lines: EntryLine[], date: string): boolean {
  return (
    entryTotals(lines).balanced &&
    !!date &&
    lines.every((l) => l.accountId > 0 && l.amount > 0 && Number.isInteger(l.amount))
  )
}
