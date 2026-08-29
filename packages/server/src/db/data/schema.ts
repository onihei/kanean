import { sqliteTable, text, integer, real, uniqueIndex, index, primaryKey } from 'drizzle-orm/sqlite-core'

/**
 * Data plane（books/{book_id}.sqlite）。data-model §2。
 * 金額は INTEGER（円）、日付は TEXT（ISO8601）、比率は REAL、真偽は INTEGER(0/1)。
 */

// 2.1 事業者設定（1行）
export const businessSettings = sqliteTable('business_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  businessName: text('business_name'),
  ownerName: text('owner_name'),
  phone: text('phone'),
  entityType: text('entity_type').notNull().default('individual'),
  filingType: text('filing_type').notNull().default('blue'), // blue / white
  filingForm: text('filing_form'), // general / real_estate
  industry: text('industry'),
  prefecture: text('prefecture'),
  ebookStorage: integer('ebook_storage', { mode: 'boolean' }).notNull().default(false),
  // 青色申告特別控除65万円の要件（e-Tax電子申告 または 優良な電子帳簿の保存）を満たすか。
  // 既定 false＝保守的に55万円（複式簿記）。true で65万円。事実認定は申告者/税理士の責任。
  blueDeductionETax: integer('blue_deduction_e_tax', { mode: 'boolean' }).notNull().default(false),
  // 連携サービス取込時に証憑（注文明細のスクショ/HTML）を保存するか（電帳法・電子取引データ保存ピラー）。
  // 既定 false＝保存せず取込を速くする。true で取込スキルが証跡を保存。e-Tax申告なら65万控除に電子帳簿保存は
  // 不要だが、電子取引データの保存義務は控除要件とは別。対応要否は申告者/税理士判断（システムは電帳法準拠を宣言しない）。
  evidenceCapture: integer('evidence_capture', { mode: 'boolean' }).notNull().default(false),
  taxMethod: text('tax_method').notNull().default('simplified'),
  taxBusinessCategory: text('tax_business_category'), // 第1〜6種
  accountingMethod: text('accounting_method').notNull().default('tax_included'),
  roundingSales: text('rounding_sales').notNull().default('floor'),
  roundingPurchase: text('rounding_purchase').notNull().default('floor'),
  depreciationRecordMethod: text('depreciation_record_method').notNull().default('indirect'),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 2.2 会計年度
export const fiscalYears = sqliteTable(
  'fiscal_years',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
    status: text('status').notNull().default('open'), // open / closed
    createdAt: text('created_at').notNull(),
  },
  // 同一開始日の年度の二重作成を防ぐ（ensureOpenFiscalYear・年度繰越の冪等性）。
  (t) => [uniqueIndex('fiscal_years_start_date_uq').on(t.startDate)],
)

// 2.3.1 分類
export const accountCategories = sqliteTable('account_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  reportType: text('report_type').notNull(), // BS / PL
  section: text('section').notNull(), // 流動資産 等
  name: text('name').notNull(),
  sortOrder: integer('sort_order').notNull().default(0),
})

// 2.3.2 決算書科目
export const statementItems = sqliteTable('statement_items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  categoryId: integer('category_id')
    .notNull()
    .references(() => accountCategories.id),
  name: text('name').notNull(),
  statementLineCode: text('statement_line_code'),
  sortOrder: integer('sort_order').notNull().default(0),
})

// 2.3.5 税区分マスタ（accounts より前に定義：FK 参照のため）
export const taxCategories = sqliteTable('tax_categories', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  code: text('code').notNull().unique(),
  label: text('label').notNull(),
  taxability: text('taxability').notNull(), // taxable / non_taxable / out_of_scope
  direction: text('direction').notNull(), // sale / purchase / none
  rate: integer('rate'), // 10 / 8 / 0 / NULL
  simplifiedCategory: text('simplified_category'),
  adjustment: text('adjustment').notNull().default('none'), // none / return / bad_debt
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
})

// 2.5 取引先（sub_accounts より前：FK のため）
export const counterparties = sqliteTable('counterparties', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  nameKana: text('name_kana'),
  honorific: text('honorific'),
  customerCode: text('customer_code'),
  invoiceRegNo: text('invoice_reg_no'),
  peppolId: text('peppol_id'),
  paymentTermMonth: text('payment_term_month'),
  paymentTermDay: text('payment_term_day'),
  holidayAdjustment: text('holiday_adjustment'),
  zip: text('zip'),
  prefecture: text('prefecture'),
  address1: text('address1'),
  address2: text('address2'),
  phone: text('phone'),
  email: text('email'),
  ccEmail: text('cc_email'),
  contactName: text('contact_name'),
  contactTitle: text('contact_title'),
  memo: text('memo'),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 2.3.3 勘定科目
export const accounts = sqliteTable('accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  statementItemId: integer('statement_item_id')
    .notNull()
    .references(() => statementItems.id),
  name: text('name').notNull(),
  defaultTaxCategoryId: integer('default_tax_category_id').references(() => taxCategories.id),
  searchKey: text('search_key'),
  normalBalance: text('normal_balance').notNull(), // debit / credit
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  isSystem: integer('is_system', { mode: 'boolean' }).notNull().default(false),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 2.3.4 補助科目
export const subAccounts = sqliteTable('sub_accounts', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id),
  name: text('name').notNull(),
  defaultTaxCategoryId: integer('default_tax_category_id').references(() => taxCategories.id),
  counterpartyId: integer('counterparty_id').references(() => counterparties.id),
  linkedAccountRef: text('linked_account_ref'),
  importSourceType: text('import_source_type'), // 取込口座の source_type（口座マスタ F-IMP-8。取込口座でない補助科目は null）
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 2.4 部門
export const departments = sqliteTable('departments', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  sortOrder: integer('sort_order').notNull().default(0),
})

// 2.6 品目
export const items = sqliteTable('items', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  itemCode: text('item_code'),
  unitPrice: integer('unit_price'),
  defaultQuantity: integer('default_quantity'),
  unit: text('unit'),
  detail: text('detail'),
  taxRate: integer('tax_rate'),
  withholding: integer('withholding', { mode: 'boolean' }).notNull().default(false),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
})

// 2.7 開始残高
export const openingBalances = sqliteTable(
  'opening_balances',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fiscalYearId: integer('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id),
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    subAccountId: integer('sub_account_id').references(() => subAccounts.id),
    side: text('side').notNull(), // debit / credit
    amount: integer('amount').notNull(),
  },
  // 同一(年度,科目,補助科目)の二重登録を防ぐ（accountAggregates は全行を合算するため
  // 重複行は開始残高の二重計上になる）。SQLite の UNIQUE は NULL を相異とみなすため、
  // 補助科目=NULL の科目レベル行の一意性はサービス層 upsert（isNull マッチ）が担保する。
  (t) => [uniqueIndex('opening_balances_fy_acc_sub_uq').on(t.fiscalYearId, t.accountId, t.subAccountId)],
)

// 2.7.1 確定申告書の入力（帳簿から導出できない所得控除・予定納税。年度別・Phase4）
export const taxReturnInputs = sqliteTable(
  'tax_return_inputs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fiscalYearId: integer('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id),
    basicDeduction: integer('basic_deduction').notNull().default(480000), // 基礎控除（既定48万）
    socialInsurance: integer('social_insurance').notNull().default(0), // 社会保険料控除
    lifeInsurance: integer('life_insurance').notNull().default(0), // 生命保険料控除
    medical: integer('medical').notNull().default(0), // 医療費控除
    spouseDependents: integer('spouse_dependents').notNull().default(0), // 配偶者・扶養控除
    otherDeductions: integer('other_deductions').notNull().default(0), // その他の所得控除
    estimatedPrepaid: integer('estimated_prepaid').notNull().default(0), // 予定納税額
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  (t) => [uniqueIndex('tax_return_inputs_fy_uq').on(t.fiscalYearId)],
)

// 2.8.1 仕訳ヘッダ
export const journalEntries = sqliteTable(
  'journal_entries',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fiscalYearId: integer('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id),
    entryDate: text('entry_date').notNull(),
    slipNo: text('slip_no'),
    description: text('description'),
    memo: text('memo'),
    source: text('source').notNull().default('manual'),
    sourceRef: text('source_ref'),
    status: text('status').notNull().default('draft'), // draft / confirmed
    createdAt: text('created_at').notNull(),
    updatedAt: text('updated_at').notNull(),
  },
  // 年度ゲート（等値）＋期間絞込（範囲）＋ ORDER BY entry_date を単一レンジスキャンに。
  // status は2値で選択性が低いためインデックス列に含めない（スキャン中フィルタで十分）。
  (t) => [index('journal_entries_fy_date_idx').on(t.fiscalYearId, t.entryDate)],
)

// 2.8.2 仕訳明細
export const journalLines = sqliteTable(
  'journal_lines',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    entryId: integer('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    lineNo: integer('line_no').notNull(),
    side: text('side').notNull(), // debit / credit
    accountId: integer('account_id')
      .notNull()
      .references(() => accounts.id),
    subAccountId: integer('sub_account_id').references(() => subAccounts.id),
    departmentId: integer('department_id').references(() => departments.id),
    counterpartyId: integer('counterparty_id').references(() => counterparties.id),
    amount: integer('amount').notNull(),
    taxCategoryId: integer('tax_category_id').references(() => taxCategories.id),
    taxAmount: integer('tax_amount'),
    isQualifiedInvoice: integer('is_qualified_invoice', { mode: 'boolean' }),
    prorationApplied: integer('proration_applied', { mode: 'boolean' }).notNull().default(false),
    description: text('description'),
  },
  // SQLite は FK 列を自動インデックスしない。仕訳→明細の引き当て（buildEntryView ほか）は
  // (entry_id, line_no) で ORDER BY line_no まで充足。元帳・科目フィルタは account_id / sub_account_id。
  (t) => [
    index('journal_lines_entry_idx').on(t.entryId, t.lineNo),
    index('journal_lines_account_idx').on(t.accountId),
    index('journal_lines_sub_account_idx').on(t.subAccountId),
  ],
)

// 2.8.3 証憑
export const attachments = sqliteTable(
  'attachments',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    targetType: text('target_type').notNull(), // journal_entry / filing_record（document は将来）
    targetId: integer('target_id').notNull(),
    fileName: text('file_name'),
    storagePath: text('storage_path'), // attachmentDir(bookId) 配下の相対リーフ名（自前生成。クライアント名は使わない）
    contentType: text('content_type'),
    sha256: text('sha256'), // SHA-256 hex（電帳法 真実性確保の基盤＝改ざん検知用。タイムスタンプ認定はスコープ外）
    fileSize: integer('file_size'),
    uploadedAt: text('uploaded_at'),
  },
  (t) => [index('attachments_target_idx').on(t.targetType, t.targetId)],
)

// 2.8.3b 申告の完了記録（filing spec）。提出の事実を年分ごとに記録する（有効性は判定しない）。
// 同一年度に複数可（税目違い・訂正/修正の再提出）。控え PDF 等は attachments
// （target_type='filing_record'）に紐づく。
export const filingRecords = sqliteTable(
  'filing_records',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    fiscalYearId: integer('fiscal_year_id')
      .notNull()
      .references(() => fiscalYears.id),
    taxKind: text('tax_kind').notNull(), // income_tax / consumption
    method: text('method').notNull(), // corner_etax / paper / other
    submittedOn: text('submitted_on').notNull(), // YYYY-MM-DD
    receiptNumber: text('receipt_number'),
    memo: text('memo'),
    createdAt: text('created_at').notNull(),
  },
  (t) => [index('filing_records_fy_idx').on(t.fiscalYearId)],
)

// 2.8.4 タグ
export const tags = sqliteTable('tags', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull().unique(),
})

export const entryTags = sqliteTable(
  'entry_tags',
  {
    entryId: integer('entry_id')
      .notNull()
      .references(() => journalEntries.id),
    tagId: integer('tag_id')
      .notNull()
      .references(() => tags.id),
  },
  (t) => [primaryKey({ columns: [t.entryId, t.tagId] })],
)

// 2.9.1 自動仕訳ルール
export const autoJournalRules = sqliteTable('auto_journal_rules', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  priority: integer('priority').notNull().default(100),
  matchField: text('match_field').notNull(), // description / amount / source
  matchOp: text('match_op').notNull(), // contains / equals / regex / range
  matchValue: text('match_value').notNull(),
  direction: text('direction').notNull().default('any'), // in / out / any
  resultAccountId: integer('result_account_id').references(() => accounts.id),
  resultSubAccountId: integer('result_sub_account_id').references(() => subAccounts.id),
  resultTaxCategoryId: integer('result_tax_category_id').references(() => taxCategories.id),
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 2.9.2 履歴学習
export const mappingHistory = sqliteTable('mapping_history', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceType: text('source_type').notNull(),
  pattern: text('pattern').notNull(),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id),
  subAccountId: integer('sub_account_id').references(() => subAccounts.id),
  taxCategoryId: integer('tax_category_id').references(() => taxCategories.id),
  hitCount: integer('hit_count').notNull().default(0),
  lastUsedAt: text('last_used_at'),
})

// 2.10.1 取込バッチ
export const importBatches = sqliteTable('import_batches', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  sourceType: text('source_type').notNull(), // bank_ufj / bank_shinsei / card_mufg_visa / amazon / rakuten
  accountRef: text('account_ref'),
  fileName: text('file_name'),
  importedAt: text('imported_at'),
  rowCount: integer('row_count'),
  status: text('status').notNull().default('done'), // done / partial / failed
  errorCount: integer('error_count').notNull().default(0), // 行単位の取込失敗件数（部分取込）
  errorSample: text('error_sample'), // 失敗行の内訳サンプル JSON（先頭 N 件・[{rowNo,raw,message}]）
})

// 2.10.2 取込明細（原データ）
export const rawTransactions = sqliteTable(
  'raw_transactions',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    batchId: integer('batch_id')
      .notNull()
      .references(() => importBatches.id),
    txnDate: text('txn_date').notNull(),
    amount: integer('amount').notNull(),
    direction: text('direction').notNull(), // in / out
    balance: integer('balance'), // CSV残高（差引残高/残高。残高同期・突合用・銀行のみ。カード等は null）
    description: text('description'),
    rawPayload: text('raw_payload'),
    dedupHash: text('dedup_hash').notNull(),
    accountRef: text('account_ref').notNull(),
    // 決済リンク（口座間振替の名寄せ。Phase3）。対になる明細の raw_transactions.id を相互に指す（ソフト参照。
    // raw は物理削除されないため整合は settlement ロジックが保つ）。null=未名寄せ。
    settlementRawId: integer('settlement_raw_id'),
    suggestedAccountId: integer('suggested_account_id').references(() => accounts.id),
    suggestedSubAccountId: integer('suggested_sub_account_id').references(() => subAccounts.id),
    suggestedTaxCategoryId: integer('suggested_tax_category_id').references(() => taxCategories.id),
    // 後付け分類（acquisition classify）の根拠（proposedAccount/reason/confidence/policyRef の JSON）。
    // raw_payload は取込時の原本で、UI CSV の配列 payload には相乗りできない（issue #144）。
    proposalJson: text('proposal_json'),
    status: text('status').notNull().default('pending'), // pending / journalized / ignored
    journalEntryId: integer('journal_entry_id').references(() => journalEntries.id),
  },
  (t) => [
    uniqueIndex('raw_txn_dedup_uq').on(t.accountRef, t.dedupHash),
    // 仕訳→取込明細の逆引き（確定時の学習・確定取消/削除時の戻し）。
    index('raw_txn_journal_entry_idx').on(t.journalEntryId),
    // 取込レビュー一覧（status 絞込＋txn_date 降順）と pending 件数（ホーム表示）。
    index('raw_txn_status_date_idx').on(t.status, t.txnDate),
    // バッチ単位の再仕訳（journalizeBatch の WHERE batch_id AND status='pending'）。
    index('raw_txn_batch_status_idx').on(t.batchId, t.status),
  ],
)

// 2.10.3 取込フォーマット定義（汎用列マッピング・ユーザー定義の新フォーマット。Phase3「対応フォーマット拡充」）
// config = ColumnMappingConfig の JSON（列番号マッピング・金額モード・エンコーディング等）。
// source_type 文字列空間では `format:{id}`（types.customSourceType）として組込3形式と共存する。
export const importFormats = sqliteTable('import_formats', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  config: text('config').notNull(), // ColumnMappingConfig の JSON
  isActive: integer('is_active', { mode: 'boolean' }).notNull().default(true),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 2.11.1 固定資産
export const fixedAssets = sqliteTable('fixed_assets', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  managementNo: text('management_no'),
  name: text('name').notNull(),
  reflectNameToDescription: integer('reflect_name_to_description', { mode: 'boolean' })
    .notNull()
    .default(false),
  accountId: integer('account_id').references(() => accounts.id),
  acquisitionCost: integer('acquisition_cost').notNull(),
  quantityOrArea: real('quantity_or_area').notNull().default(1),
  acquiredDate: text('acquired_date'),
  businessStartDate: text('business_start_date'),
  depreciationMethod: text('depreciation_method').notNull(), // straight_line / declining_balance / lump_sum / minor_special / old_*
  usefulLife: integer('useful_life'),
  depreciationRate: real('depreciation_rate'),
  businessUseRatio: real('business_use_ratio').notNull().default(100),
  realEstateRatio: real('real_estate_ratio'),
  openingBookValue: integer('opening_book_value'),
  specialDepreciationAmount: integer('special_depreciation_amount'),
  retiredDate: text('retired_date'),
  includeInBlueReturn: integer('include_in_blue_return', { mode: 'boolean' })
    .notNull()
    .default(true),
  note: text('note'),
  status: text('status').notNull().default('active'), // active / retired（除却）/ sold（売却）
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 2.11.2 償却明細（年度別）
export const depreciationEntries = sqliteTable('depreciation_entries', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fixedAssetId: integer('fixed_asset_id')
    .notNull()
    .references(() => fixedAssets.id),
  fiscalYearId: integer('fiscal_year_id')
    .notNull()
    .references(() => fiscalYears.id),
  openingBookValue: integer('opening_book_value').notNull(),
  depreciationAmount: integer('depreciation_amount').notNull(),
  businessAmount: integer('business_amount').notNull(),
  closingBookValue: integer('closing_book_value').notNull(),
  journalEntryId: integer('journal_entry_id').references(() => journalEntries.id),
})

// 2.12 家事按分設定
export const prorationSettings = sqliteTable('proration_settings', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  fiscalYearId: integer('fiscal_year_id')
    .notNull()
    .references(() => fiscalYears.id),
  accountId: integer('account_id')
    .notNull()
    .references(() => accounts.id),
  subAccountId: integer('sub_account_id').references(() => subAccounts.id),
  businessRatio: real('business_ratio').notNull(),
  method: text('method').notNull().default('year_end'), // year_end / each
  note: text('note'),
})

// 2.13.1 帳票（見積/納品/請求/領収）
export const documents = sqliteTable('documents', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  docType: text('doc_type').notNull(), // quote / delivery / invoice / receipt
  docNo: text('doc_no'),
  counterpartyId: integer('counterparty_id').references(() => counterparties.id),
  honorific: text('honorific'),
  subject: text('subject'),
  issueDate: text('issue_date'),
  dueDate: text('due_date'),
  revenueRecognitionDate: text('revenue_recognition_date'),
  paymentInfo: text('payment_info'),
  remarks: text('remarks'),
  memo: text('memo'),
  subtotal: integer('subtotal'),
  taxTotal: integer('tax_total'),
  withholdingTotal: integer('withholding_total'),
  total: integer('total'),
  status: text('status').notNull().default('draft'),
  convertedFromId: integer('converted_from_id'),
  journalEntryId: integer('journal_entry_id').references(() => journalEntries.id),
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
})

// 2.14 監査ログ（仕訳の訂正・確定取消・削除の履歴。電子帳簿保存法の訂正・削除履歴の土台）
// 物理削除する仕訳でも before スナップショット（JSON）で原状を保持＝削除履歴を残す。
export const auditLogs = sqliteTable(
  'audit_logs',
  {
    id: integer('id').primaryKey({ autoIncrement: true }),
    targetType: text('target_type').notNull(), // journal_entry
    targetId: integer('target_id').notNull(), // journal_entries.id（削除後も値は保持）
    action: text('action').notNull(), // update / unconfirm / delete
    before: text('before'), // 変更前スナップショット(JSON: ヘッダ＋明細)
    after: text('after'), // 変更後スナップショット(JSON)。delete は null
    note: text('note'), // 訂正理由（任意）
    at: text('at').notNull(), // 実施日時 ISO8601
  },
  // 仕訳別の履歴照会（attachments_target_idx と同パターン）。追記専用・行が大きく単調増加するため。
  (t) => [index('audit_logs_target_idx').on(t.targetType, t.targetId)],
)

// 2.13.2 帳票明細
export const documentLines = sqliteTable('document_lines', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  documentId: integer('document_id')
    .notNull()
    .references(() => documents.id),
  lineNo: integer('line_no').notNull(),
  itemId: integer('item_id').references(() => items.id),
  description: text('description'),
  deliveryDate: text('delivery_date'),
  unitPrice: integer('unit_price'),
  quantity: real('quantity'),
  amount: integer('amount'),
  taxRate: integer('tax_rate'),
  withholding: integer('withholding', { mode: 'boolean' }).notNull().default(false),
  deliveryDocNo: text('delivery_doc_no'),
})
