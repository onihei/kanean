/**
 * 決算整理（開始残高・元入金振替・年度繰越）の wire 型。server が実装の正（issue #236）。
 */
import type { Yen } from '../money.js'

export interface OpeningBalanceView {
  id: number
  accountId: number
  accountName: string
  subAccountId: number | null
  subAccountName: string | null
  section: string
  /** debit / credit（DB text 列由来のため string）。 */
  side: string
  amount: number
}

/** 貸借対照表の三部（資産の部/負債の部/資本の部）。グリッドの見出し用。 */
export type BsPart = '資産の部' | '負債の部' | '資本の部'

export interface BsAccountView {
  id: number
  name: string
  section: string
  part: BsPart
  /** debit / credit（DB text 列由来のため string）。 */
  normalBalance: string
  sortOrder: number
}

/** BS 科目配下の補助科目（開始残高グリッドが各科目の下に並べる）。 */
export interface BsSubAccountView {
  id: number
  accountId: number
  name: string
  sortOrder: number
}

/** 開始残高の貸借合計と一致判定（data-model §2.7・サーバで集計）。 */
export interface OpeningBalanceTotals {
  totalDebit: number
  totalCredit: number
  /** 借方合計 − 貸方合計。0 で一致。 */
  difference: number
  balanced: boolean
}

/** GET /opening-balances（開始残高グリッドの一括応答）。 */
export interface OpeningBalancesResponse {
  balances: OpeningBalanceView[]
  accounts: BsAccountView[]
  subAccounts: BsSubAccountView[]
  totals: OpeningBalanceTotals
}

export interface CapitalTransferPreview {
  fiscalYearId: number
  /** 前期末元入金（元入金の期末残高）。 */
  priorMotoire: Yen
  /** 当期所得（控除前所得金額 ㊸ ＝ 損益計算書の当期所得）。 */
  incomeBeforeDeduction: Yen
  /** 事業主借 期末残高。 */
  ownerLoan: Yen
  /** 事業主貸 期末残高。 */
  ownerDraw: Yen
  /** 当期の元入金増減（＝ 当期所得 + 事業主借 − 事業主貸）。 */
  netChange: Yen
  /** 翌期首の元入金（＝翌期 opening_balances の元入金）。 */
  nextMotoire: Yen
}

export interface RolloverResult {
  nextFiscalYearId: number
  nextMotoire: Yen
  /** 生成した翌期 opening_balances の件数。 */
  generated: number
}

/** 繰越前の警告（read-only）。当期に未処理のまま残る取込明細の件数。繰越はブロックしない。 */
export interface RolloverPrecheck {
  unprocessedRaw: { pending: number; ignored: number }
}
