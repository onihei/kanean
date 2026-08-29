/**
 * 固定資産・減価償却・家事按分の wire 型。server が実装の正、web/mcp は読者（issue #236）。
 */
import type { Yen } from '../money.js'

export interface AssetYearView {
  /** 暦年（会計年度＝暦年前提）。 */
  year: number
  openingBookValue: Yen
  /** 本年分償却費（全額）。 */
  depreciationAmount: Yen
  /** 必要経費算入額（事業割合適用後）。 */
  businessAmount: Yen
  /** 家事分（経費不算入）。 */
  householdAmount: Yen
  closingBookValue: Yen
}

export interface FixedAssetView {
  id: number
  managementNo: string | null
  name: string
  accountName: string | null
  acquisitionCost: number
  acquiredDate: string | null
  businessStartDate: string | null
  depreciationMethod: string
  usefulLife: number | null
  depreciationRate: number | null
  businessUseRatio: number
  status: string
  /** 償却スケジュールを算定できたか（未知 method・耐用年数の率未解決は false）。 */
  supported: boolean
  /** 対象年度の償却（未供用/算定不可なら null）。 */
  current: AssetYearView | null
  /** 対象年度末の帳簿価額（未供用＝取得価額、償却済＝備忘1円）。 */
  bookValue: number
}

export interface AssetSchedule {
  asset: FixedAssetView
  supported: boolean
  years: AssetYearView[]
}

export interface CreateFixedAssetInput {
  name: string
  acquisitionCost: number
  acquiredDate?: string | null
  businessStartDate?: string | null
  depreciationMethod?: string
  usefulLife?: number | null
  depreciationRate?: number | null
  businessUseRatio?: number
  accountId?: number | null
  managementNo?: string | null
  note?: string | null
}

/** 償却の記帳方法（直接法 / 間接法）。 */
export type RecordMethod = 'direct' | 'indirect'

export interface DepreciationPostingResult {
  recordMethod: RecordMethod
  /** 起票した資産（＝仕訳）件数。 */
  posted: number
  /** 償却対象だが起票できなかった資産（直接法で資産科目未設定 等）。 */
  skipped: { assetId: number; name: string; reason: string }[]
  totalDepreciation: Yen
  totalBusinessAmount: Yen
}

/** 処分種別（除却 / 売却）。 */
export type DisposalType = 'retirement' | 'sale'

/** 固定資産の処分（除却・売却）結果。売却は未償却残高を事業主貸へ振替（譲渡所得は手計算）。 */
export interface DisposeResult {
  /** 処分種別（除却 / 売却）。 */
  disposalType: DisposalType
  /** 処分（除却損／売却振替）仕訳ID。一括償却資産（仕訳なし・3年継続）は起票しないため null。 */
  entryId: number | null
  /** 処分年度に計上した月割償却費（全額。計上なしは0）。 */
  currentYearDepreciation: Yen
  /** 処分年度の月割償却仕訳ID（計上なしは null）。 */
  depreciationEntryId: number | null
  /** 処分時の未償却残高（処分年度の月割償却を控除後）。 */
  bookValue: Yen
  /** 固定資産除却損（事業分）。売却は0（損益は譲渡所得＝スコープ外）。 */
  lossBusiness: Yen
  /** 除却の家事分（事業主貸へ振替）。売却は0。 */
  lossHousehold: Yen
  /** 売却で事業主貸へ振替えた未償却残高（全額）。除却は0。 */
  ownerTransfer: Yen
  /** 減価償却累計額（間接法の取崩額。処分年度の月割償却を含む）。 */
  accumulated: Yen
  /** 注記（期中処分で月割計上した／売却は譲渡所得が手計算 等。税理士サインオフ前）。 */
  note: string | null
}

// --- 家事按分 ---------------------------------------------------------------

export interface ProrationSettingView {
  id: number
  accountId: number
  accountName: string
  subAccountId: number | null
  subAccountName: string | null
  businessRatio: number
  method: string
  note: string | null
}

export interface ProrationPostingResult {
  posted: number
  lines: { accountName: string; subAccountName: string | null; expenseAmount: number; householdAmount: number }[]
  totalHousehold: Yen
}
