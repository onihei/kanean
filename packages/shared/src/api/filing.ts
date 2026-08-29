/**
 * 申告の提出支援（filing）の wire 型。server が実装の正、web/mcp は読者。
 *
 * 入力指示書は「確定申告書等作成コーナーのどの画面のどの欄に何を入れるか」の転記値一覧。
 * 値はすべて tax-return の組成（BlueStatementReport / IncomeTaxReturn / ConsumptionTaxReturn）
 * からの射影で、指示書のための新しい計算は存在しない。画面・欄の対応は
 * docs/filing-corner-mapping.md を正とする。
 */
import type { Yen } from '../money.js'
import type { OpenableTab } from '../appLink.js'
import type { AttachmentMeta } from './documents.js'

// --- 申告前チェック（GET /filing/precheck） ----------------------------------

export type FilingIssueLevel = 'blocking' | 'warning'

export interface FilingIssue {
  level: FilingIssueLevel
  /** 安定した識別子（bs_unbalanced / deduction_inputs_missing など）。 */
  code: string
  message: string
  /** 該当画面（アプリ内導線）。無ければ null。 */
  screen: OpenableTab | null
}

/**
 * 申告前チェックの結果。issues が空でも「提出可能」を意味しない（表示規約・filing spec）。
 */
export interface FilingPrecheck {
  fiscalYearId: number
  /** 年分（暦年）。 */
  year: number
  issues: FilingIssue[]
  /** 承認待ち draft 件数（warning としても issues に現れる）。 */
  draftCount: number
  /** 参考値・税理士確認前の免責（UI 必須表示）。 */
  disclaimer: string
}

// --- 入力指示書（GET /filing/instruction-sheet） -----------------------------

/**
 * input=転記者が入力する欄 / select=選択肢を選ぶ欄 /
 * verify=作成コーナーが自動計算する欄（入力せず一致を確認する）。
 */
export type FilingItemKind = 'input' | 'select' | 'verify'

export interface FilingSheetItem {
  kind: FilingItemKind
  /** 作成コーナーの欄ラベル。 */
  field: string
  /** 転記値（金額は円整数の数字列、選択肢は選択肢名）。 */
  value: string
  /** 金額の場合の円整数（コピー・突合用）。金額以外は null。 */
  amount: Yen | null
  note: string | null
}

export interface FilingSheetGroup {
  /** docs/filing-corner-mapping.md の節 ID（A2 など）。 */
  id: string
  /** 画面名。 */
  screen: string
  items: FilingSheetItem[]
}

/** 送信前に作成コーナーの計算結果と1円単位で突き合わせる検算ブロック。 */
export interface FilingChecksum {
  /** 所得税の申告納税額（納付。還付の場合 0）。 */
  incomeTaxPayable: Yen
  /** 所得税の還付される税金（納付の場合 0）。 */
  incomeTaxRefund: Yen
  /** 消費税 差引税額（国税）。 */
  consumptionNational: Yen
  /** 地方消費税額。 */
  consumptionLocal: Yen
  /** 消費税 納付税額 合計。 */
  consumptionTotal: Yen
}

export interface FilingInstructionSheet {
  fiscalYearId: number
  /** 年分（暦年）。 */
  year: number
  groups: FilingSheetGroup[]
  checksum: FilingChecksum
  /** 消費税申告（簡易課税）の前提が成立し C 群を含むか。 */
  consumptionApplicable: boolean
  /** 参考値・税理士確認前の免責（UI 必須表示）。 */
  disclaimer: string
}

// --- 完了記録（/filing/records） ---------------------------------------------

export const FILING_TAX_KINDS = ['income_tax', 'consumption'] as const
export type FilingTaxKind = (typeof FILING_TAX_KINDS)[number]

export const FILING_METHODS = ['corner_etax', 'paper', 'other'] as const
export type FilingMethod = (typeof FILING_METHODS)[number]

export const FILING_TAX_KIND_LABELS: Readonly<Record<FilingTaxKind, string>> = {
  income_tax: '所得税',
  consumption: '消費税',
}

export const FILING_METHOD_LABELS: Readonly<Record<FilingMethod, string>> = {
  corner_etax: '作成コーナー（e-Tax送信）',
  paper: '書面提出',
  other: 'その他',
}

export interface FilingRecord {
  id: number
  fiscalYearId: number
  taxKind: FilingTaxKind
  method: FilingMethod
  /** 提出日（YYYY-MM-DD）。 */
  submittedOn: string
  receiptNumber: string | null
  memo: string | null
  createdAt: string
  /** 控え（受信通知・申告書控え PDF 等）のメタ。[[attachments]] と同一形式。 */
  attachments: AttachmentMeta[]
}

// --- 貸借対照表 固定行の様式ラベル（青色決算書4ページ目） ---------------------
// BsFormRow.label は空欄行のみ科目名を持つ（固定行は官製様式に印字済のため undefined）。
// 指示書・画面での行名解決に使う row → ラベルの対応。server の行割当
// （reports/blueBalanceSheet.ts）と同じ様式を指す。

export const BS_ASSET_ROW_LABELS: Readonly<Record<number, string>> = {
  1: '現金',
  2: '当座預金',
  3: '定期預金',
  4: 'その他の預金',
  5: '受取手形',
  6: '売掛金',
  7: '有価証券',
  8: '棚卸資産',
  9: '前払金',
  10: '貸付金',
  11: '建物',
  12: '建物附属設備',
  13: '機械装置',
  14: '車両運搬具',
  15: '工具器具備品',
  16: '土地',
  24: '事業主貸',
}

export const BS_LIAB_ROW_LABELS: Readonly<Record<number, string>> = {
  1: '支払手形',
  2: '買掛金',
  3: '借入金',
  4: '未払金',
  5: '前受金',
  6: '預り金',
  14: '貸倒引当金',
  22: '事業主借',
  23: '元入金',
  24: '青色申告特別控除前の所得金額',
}
