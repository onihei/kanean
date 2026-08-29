import { type Side, type Yen, yen } from '@kanean/shared'

export type { Side }

/**
 * 複式簿記の基本ルール（accounting-spec §1）。
 * - 貸借一致の検証。
 * - normal_balance の機械的決定（report_type + section）と例外。
 * - 残高 = normal_balance 側 − 反対側。
 */

export interface JournalLine {
  side: Side
  amount: Yen
}

/** 指定 side の合計。 */
export function totalBySide(lines: JournalLine[], side: Side): Yen {
  return yen(lines.filter((l) => l.side === side).reduce<number>((acc, l) => acc + l.amount, 0))
}

/** 1仕訳内で Σ借方 = Σ貸方 か。 */
export function isBalanced(lines: JournalLine[]): boolean {
  return totalBySide(lines, 'debit') === totalBySide(lines, 'credit')
}

/** 貸借不一致なら例外（confirmed 化の前提・§1.1）。 */
export function assertBalanced(lines: JournalLine[]): void {
  const debit = totalBySide(lines, 'debit')
  const credit = totalBySide(lines, 'credit')
  if (debit !== credit) {
    throw new Error(`貸借不一致: 借方 ${debit} ≠ 貸方 ${credit}`)
  }
}

export type Section =
  | '流動資産'
  | '固定資産'
  | '繰延資産'
  | '流動負債'
  | '固定負債'
  | '資本'
  | '売上'
  | '売上原価'
  | '経費'

const DEBIT_SECTIONS: ReadonlySet<Section> = new Set([
  '流動資産',
  '固定資産',
  '繰延資産',
  '売上原価',
  '経費',
])
const CREDIT_SECTIONS: ReadonlySet<Section> = new Set(['流動負債', '固定負債', '資本', '売上'])

/** 評価勘定・個人事業特有科目の例外（§1.2.1）。科目名で個別指定。 */
export const NORMAL_BALANCE_EXCEPTIONS: Readonly<Record<string, Side>> = {
  減価償却累計額: 'credit',
  貸倒引当金: 'credit',
  事業主貸: 'debit',
  事業主借: 'credit',
  '売上値引・返品': 'debit',
  '仕入値引・返品': 'credit',
}

/** section から normal_balance を機械的に決める（§1.2）。 */
export function normalBalanceForSection(section: Section): Side {
  if (DEBIT_SECTIONS.has(section)) return 'debit'
  if (CREDIT_SECTIONS.has(section)) return 'credit'
  throw new RangeError(`未知の section: ${section}`)
}

/** 例外科目を優先しつつ normal_balance を解決する。 */
export function resolveNormalBalance(section: Section, accountName?: string): Side {
  if (accountName && accountName in NORMAL_BALANCE_EXCEPTIONS) {
    return NORMAL_BALANCE_EXCEPTIONS[accountName]
  }
  return normalBalanceForSection(section)
}

/** 残高 = normal_balance 側 − 反対側（§1.2 末尾）。 */
export function accountBalance(normal: Side, totalDebit: Yen, totalCredit: Yen): Yen {
  return normal === 'debit' ? yen(totalDebit - totalCredit) : yen(totalCredit - totalDebit)
}
