/**
 * マスタ系の wire 型（科目・税区分・取引先・補助科目・部門・品目・タグ・自動仕訳ルール・
 * 連携サービス・取込フォーマット）。server が実装の正、web/mcp は読者（issue #236）。
 *
 * DB の text 列に由来するフィールド（normalBalance / taxability 等）は string のまま公開する
 * （Drizzle 推論型が string であり、列挙へ絞ると server 側で組立てが型検査を通らないため。
 * 取りうる値はコメントに残す）。
 */

/** 勘定科目（GET /accounts。分類・貸借は join した分類マスタ由来）。 */
export interface Account {
  id: number
  name: string
  /** debit / credit。 */
  normalBalance: string
  /** 分類（現金及び預金・経費・売上（収入）金額 等）。かんたん入力の科目絞り込みに使う。 */
  category: string
  /** BS / PL。 */
  reportType: string
}

/** 税区分（GET /tax-categories）。 */
export interface TaxCategory {
  id: number
  code: string
  label: string
  /** taxable / non_taxable / out_of_scope。 */
  taxability: string
  /** sale / purchase / none。 */
  direction: string
  rate: number | null
}

/** 取引先（counterparties 行のうち一覧・選択が使う部分）。wire は行全体を返す。 */
export interface Counterparty {
  id: number
  name: string
  nameKana: string | null
  honorific: string | null
  customerCode: string | null
  invoiceRegNo: string | null
  phone: string | null
  email: string | null
  prefecture: string | null
  address1: string | null
  address2: string | null
  memo: string | null
  isActive: boolean
}

export interface CounterpartyInput {
  name: string
  nameKana?: string | null
  honorific?: string | null
  customerCode?: string | null
  /** 適格請求書発行事業者 登録番号（T+13桁）。 */
  invoiceRegNo?: string | null
  peppolId?: string | null
  paymentTermMonth?: string | null
  paymentTermDay?: string | null
  holidayAdjustment?: string | null
  zip?: string | null
  prefecture?: string | null
  address1?: string | null
  address2?: string | null
  phone?: string | null
  email?: string | null
  ccEmail?: string | null
  contactName?: string | null
  contactTitle?: string | null
  memo?: string | null
}

/** 補助科目（sub_accounts 行の公開部分）。 */
export interface SubAccount {
  id: number
  accountId: number
  name: string
  defaultTaxCategoryId: number | null
  counterpartyId: number | null
  linkedAccountRef: string | null
  isActive: boolean
}

export interface SubAccountInput {
  accountId: number
  name: string
  defaultTaxCategoryId?: number | null
  counterpartyId?: number | null
  linkedAccountRef?: string | null
}

export interface Department {
  id: number
  name: string
  isActive: boolean
}

export interface Item {
  id: number
  name: string
  itemCode: string | null
  unitPrice: number | null
  defaultQuantity: number | null
  unit: string | null
  detail: string | null
  taxRate: number | null
  withholding: boolean
  isActive: boolean
}

export interface ItemInput {
  name: string
  itemCode?: string | null
  unitPrice?: number | null
  defaultQuantity?: number | null
  unit?: string | null
  detail?: string | null
  /** 消費税率%（10 / 8。非課税は null）。 */
  taxRate?: number | null
  withholding?: boolean
}

export interface Tag {
  id: number
  name: string
}

// --- 自動仕訳ルール --------------------------------------------------------

export type RuleMatchField = 'description' | 'amount' | 'source'
export type RuleMatchOp = 'contains' | 'equals' | 'regex' | 'range'
export type RuleDirection = 'in' | 'out' | 'any'

/** 自動仕訳ルール（auto_journal_rules 行の公開形。列挙値は RuleInput 検証が担保）。 */
export interface Rule {
  id: number
  name: string
  priority: number
  matchField: RuleMatchField
  matchOp: RuleMatchOp
  matchValue: string
  direction: RuleDirection
  resultAccountId: number | null
  resultSubAccountId: number | null
  resultTaxCategoryId: number | null
  isActive: boolean
}

export interface RuleInput {
  name: string
  priority?: number
  matchField: RuleMatchField
  matchOp: RuleMatchOp
  matchValue: string
  direction?: RuleDirection
  resultAccountId: number
  resultSubAccountId?: number | null
  resultTaxCategoryId?: number | null
}

// --- 連携サービス（カタログ駆動の口座マスタ） ------------------------------

export type ServiceKind = 'bank' | 'card' | 'ec'

/** 追加可能なサービス（GET /services/catalog の静的定義）。 */
export interface ServiceCatalogEntry {
  /** サービスキー（= 補助科目に記憶する import_source_type。bank/card は組込 source_type と一致）。 */
  key: string
  /** 表示名（登録時の補助科目名の既定）。 */
  label: string
  kind: ServiceKind
  /** 自動作成する補助科目の親勘定科目名（`accounts.name` で解決）。 */
  parentAccountName: string
  /** CSV取込に対応するか（false=内部IF/スキル経由・将来対応）。 */
  csv: boolean
}

/** 登録済みの連携サービス（= 取込口座の補助科目）＋カタログメタ＋draft件数。 */
export interface LinkedService {
  /** = 補助科目 id（サービス毎の draft 絞り込みキー）。 */
  subAccountId: number
  /** import_source_type（= カタログ key）。旧データ等で未記憶は ''。 */
  serviceKey: string
  /** 表示名（補助科目名）。 */
  name: string
  /** 取込時の口座解決キー（= linked_account_ref）。自動採番。 */
  accountRef: string
  /** 親勘定科目（普通預金・未払金 等）。 */
  accountId: number
  accountName: string
  /** カタログ由来のメタ（未知キー＝旧 format:{id}/null は null）。 */
  label: string | null
  kind: ServiceKind | null
  /** CSV取込に対応するか（カタログ csv。未知キーは false）。 */
  csv: boolean
  /** このサービスの確認待ち（draft）件数（open 年度）。 */
  draftCount: number
}

/** 口座マスタ（取込口座・F-IMP-8）。取込フォームの選択肢。 */
export interface ImportAccount {
  subAccountId: number
  /** 補助科目名（表示用）。 */
  name: string
  /** account_ref（= linked_account_ref）。取込時の口座解決キー。 */
  accountRef: string
  /** 親勘定科目（普通預金・未払金 等）。 */
  accountId: number
  accountName: string
  /** 取込形式（記憶していれば選択時に自動設定）。旧データは null。 */
  sourceType: string | null
  isActive: boolean
}

// --- 取込フォーマット定義（汎用列マッピング） ------------------------------

export type ImportEncoding = 'shift_jis' | 'utf8'

/** 金額のマッピング方式。 */
export type AmountMapping =
  /** 出金列・入金列が別（UFJ/新生型）。値ありの側が金額・方向。 */
  | { mode: 'split'; paidCol: number; receivedCol: number }
  /** 符号付き1列。負=出金 / 0以上=入金。 */
  | { mode: 'signed'; amountCol: number }
  /** 金額列＋方向列。方向列の値が outValues のいずれかなら出金、それ以外は入金。 */
  | { mode: 'single'; amountCol: number; directionCol: number; outValues: string[] }

/** 1フォーマットの列マッピング設定（import_formats.config に JSON 保存）。 */
export interface ColumnMappingConfig {
  encoding: ImportEncoding
  /** スキップする先頭行数（ヘッダ。0以上）。 */
  headerRows: number
  /** 取引日の列番号（0始まり）。 */
  dateCol: number
  /** 摘要列（0始まり・複数指定で半角正規化のうえ空白連結）。空配列可（摘要なし）。 */
  descCols: number[]
  amount: AmountMapping
  /** 残高列（任意・銀行系の突合用。null/未指定なら残高を取らない）。 */
  balanceCol?: number | null
  /** 取込時の口座マスタ自動登録で用いる既定の親勘定科目名（未指定なら呼び出し側既定）。 */
  defaultAccountName?: string | null
}

export interface ImportFormat {
  id: number
  name: string
  config: ColumnMappingConfig | null
  /** config が壊れて解釈できない時の原因（list での行隔離用。正常時は未設定）。 */
  configError?: string
  isActive: boolean
}
