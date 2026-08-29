/**
 * server API クライアント。認証は無い（サーバは 127.0.0.1 限定バインド）。
 * すべてのリクエストは req() を通し、対象帳簿を `X-BookInfo-Id` で送る（books spec の解決順）。
 * 帳簿が1冊だけならヘッダ無しでも解決されるが、2冊以上では必須になるため一元的に付与する。
 */

/** 現在対象の帳簿。App が起動時に設定する（localStorage から復元）。 */
let currentBookId: string | null = null

export function setCurrentBookId(id: string | null): void {
  currentBookId = id
}
export function getCurrentBookId(): string | null {
  return currentBookId
}

/**
 * fetch のラッパ。生 fetch を直接使わないこと（帳簿ヘッダが漏れると、1冊の間は動いてしまい
 * 2冊目で初めて壊れる）。ブラウザネイティブの GET（<a href> / <img src>）は
 * ヘッダを載せられないため bookQuery() で `?bookId=` を付ける。
 */
/**
 * クエリ文字列を組む（issue #158。10箇所の URLSearchParams 定型を一本化）。
 * undefined / null / 空文字 / false は落とす。true は '1'。空なら ''、あれば先頭 ? 付き。
 * CSV パス等を組む画面側からも使う（issue #247 で export。手組みの URLSearchParams は作らない）。
 */
export function qsOf(params: Record<string, string | number | boolean | null | undefined>): string {
  const p = new URLSearchParams()
  for (const [k, v] of Object.entries(params)) {
    if (v == null || v === '' || v === false) continue
    p.set(k, v === true ? '1' : String(v))
  }
  const s = p.toString()
  return s ? `?${s}` : ''
}

function req(url: string, init?: RequestInit): Promise<Response> {
  const headers = new Headers(init?.headers)
  if (currentBookId) headers.set('X-BookInfo-Id', currentBookId)
  return fetch(url, { ...init, headers })
}

/**
 * Response をそのまま扱いたい特殊経路（様式PDFの ArrayBuffer 取得、デスクトップ限定ルートの
 * 存在確認など）向けの fetch。req() と同じく帳簿ヘッダを必ず付ける。JSON API は api.* を使うこと。
 */
export function apiFetch(path: string, init?: RequestInit): Promise<Response> {
  return req(path, init)
}

/** ブラウザネイティブの GET に付ける帳簿指定（エクスポート zip・証憑ダウンロード）。 */
export function bookQuery(sep: '?' | '&' = '?'): string {
  return currentBookId ? `${sep}bookId=${encodeURIComponent(currentBookId)}` : ''
}

/**
 * API エラー。サーバは2形式を返す: `{error: "文字列"}`（業務API）と
 * `{error: {code, message}}`（帳簿・モード・帳簿解決）。後者は code と付随情報（books）を
 * 呼び出し側が分岐に使うため、Error に載せて運ぶ。
 */
export class ApiError extends Error {
  code?: string
  /** 409 books_not_single・400 book_required が返す選択肢。 */
  books?: { id: string; name: string }[]
  /** 409 book_id_conflict（取り込み）が返す、扱いを選ぶための材料。 */
  conflict?: ImportConflict
  constructor(message: string, code?: string, books?: { id: string; name: string }[], conflict?: ImportConflict) {
    super(message)
    this.name = 'ApiError'
    this.code = code
    this.books = books
    this.conflict = conflict
  }
}

async function json<T>(res: Response): Promise<T> {
  if (!res.ok) {
    const body = (await res.json().catch(() => ({}))) as {
      error?: string | { code?: string; message?: string }
      books?: { id: string; name: string }[]
      conflict?: ImportConflict
    }
    const e = body.error
    if (e && typeof e === 'object') {
      throw new ApiError(e.message ?? `HTTP ${res.status}`, e.code, body.books, body.conflict)
    }
    throw new ApiError(e ?? `HTTP ${res.status}`)
  }
  return res.json() as Promise<T>
}

/**
 * 書類明細の編集状態（web ローカル）。読み（DocumentLineView）と書き（DocumentLineInput）の
 * 両用に使う緩い形。送信時は DocumentLineInput として受理される（id 等の余剰は無視される）。
 */
export interface DocumentLine {
  id?: number
  itemId?: number | null
  description?: string | null
  unitPrice?: number | null
  quantity?: number | null
  amount: number
  taxRate?: number | null
  withholding?: boolean
}

// ---- wire 型は shared が正（issue #128 / #236）。ここは import + 再輸出のみ ----
import type {
  Side,
  AccountBalanceRow, TrialBalance, PlSectionView, ProfitAndLoss, BsSectionView, BalanceSheet,
  LedgerRow, GeneralLedger, SubLedger, TrendRow, MonthlyTrend,
  TaxSalesRow, TaxSalesBase, TaxSalesSummary,
  TaxExcludedPlRow, TaxExcludedPlSection, TaxExcludedProfitAndLoss,
  DepartmentColumn, DepartmentMatrixRow, DepartmentTrialBalance, DepartmentPlSection, DepartmentProfitAndLoss,
  CompareCell, ComparativeRow, ComparativeTrialBalance, ComparativePlSection, ComparativeProfitAndLoss,
  ComparativeBsSection, ComparativeBalanceSheet,
  EntryLineView, EntryView, ListEntriesFilter,
  JobState, ImportCounts, AcquisitionJob, AcquisitionTarget, AcquisitionTargets, ClassificationPolicy,
  BookInfo, AppMode, McpLinkStatus, ImportBookResult, ImportConflict, ImportMode,
  BusinessSettingsView, BusinessSettingsPatch, FiscalYearView,
  Account, TaxCategory, Counterparty, CounterpartyInput, SubAccount, SubAccountInput,
  Department, Item, ItemInput, Tag, Rule, RuleInput, RuleMatchField, RuleMatchOp, RuleDirection,
  ServiceKind, ServiceCatalogEntry, LinkedService,
  ImportFormat,
  ManualEntryLineInput, DraftOriginSource, DraftOrigin, DraftLineView, DraftView, ListDraftsOpts,
  BatchConfirmResult, AuditLogView,
  ImportStatus, SkippedDuplicate, ParseError, ImportSummary, JournalizeSummary, CsvImportResult,
  RawStatus, RawYearScope, RawTransactionView, RawTransactionListResponse,
  TransferSide, TransferCandidateView, LinkedTransferView,
  ReconcileGap, AccountReconcile, ReconcileReport,
  TaxForecastScenario, TaxForecastWhatIf, TaxForecast,
  ConsumptionTaxBaseRow, ConsumptionTaxReturn, BlueReturnSummary,
  TaxReturnInputsView, IncomeDetailRow, IncomeTaxReturn,
  DepreciationRow, DepreciationBreakdown, BreakdownRow, ExpenseBreakdown,
  MonthlySalesPurchaseRow, MonthlySalesPurchase, ReserveAllowanceCalc,
  FormBox, BlueReturnStatementPl, BsFormRow, BlueBalanceSheet, BlueStatementReport,
  AssetYearView, FixedAssetView, AssetSchedule, CreateFixedAssetInput,
  RecordMethod, DepreciationPostingResult, DisposalType, DisposeResult,
  ProrationSettingView, ProrationPostingResult,
  OpeningBalanceView, BsPart, BsAccountView, BsSubAccountView, OpeningBalanceTotals,
  OpeningBalancesResponse, CapitalTransferPreview, RolloverResult, RolloverPrecheck,
  AttachmentMeta, DocumentLineView, DocumentView, DocumentLineInput, DocumentInput,
  FilingIssueLevel, FilingIssue, FilingPrecheck, FilingItemKind, FilingSheetItem, FilingSheetGroup,
  FilingChecksum, FilingInstructionSheet, FilingTaxKind, FilingMethod, FilingRecord,
} from '@kanean/shared'

export type {
  Side,
  AccountBalanceRow, TrialBalance, PlSectionView, ProfitAndLoss, BsSectionView, BalanceSheet,
  LedgerRow, GeneralLedger, SubLedger, TrendRow, MonthlyTrend,
  TaxSalesRow, TaxSalesBase, TaxSalesSummary,
  TaxExcludedPlRow, TaxExcludedPlSection, TaxExcludedProfitAndLoss,
  DepartmentColumn, DepartmentMatrixRow, DepartmentTrialBalance, DepartmentPlSection, DepartmentProfitAndLoss,
  CompareCell, ComparativeRow, ComparativeTrialBalance, ComparativePlSection, ComparativeProfitAndLoss,
  ComparativeBsSection, ComparativeBalanceSheet,
  EntryLineView, EntryView, ListEntriesFilter,
  JobState, ImportCounts, AcquisitionJob, AcquisitionTarget, AcquisitionTargets, ClassificationPolicy,
  BookInfo, AppMode, McpLinkStatus, ImportBookResult, ImportConflict, ImportMode,
  BusinessSettingsView, BusinessSettingsPatch, FiscalYearView,
  Account, TaxCategory, Counterparty, CounterpartyInput, SubAccount, SubAccountInput,
  Department, Item, ItemInput, Tag, Rule, RuleInput, RuleMatchField, RuleMatchOp, RuleDirection,
  ServiceKind, ServiceCatalogEntry, LinkedService,
  ImportFormat,
  ManualEntryLineInput, DraftOriginSource, DraftOrigin, DraftLineView, DraftView, ListDraftsOpts,
  BatchConfirmResult, AuditLogView,
  ImportStatus, SkippedDuplicate, ParseError, ImportSummary, JournalizeSummary, CsvImportResult,
  RawStatus, RawYearScope, RawTransactionView, RawTransactionListResponse,
  TransferSide, TransferCandidateView, LinkedTransferView,
  ReconcileGap, AccountReconcile, ReconcileReport,
  TaxForecastScenario, TaxForecastWhatIf, TaxForecast,
  ConsumptionTaxBaseRow, ConsumptionTaxReturn, BlueReturnSummary,
  TaxReturnInputsView, IncomeDetailRow, IncomeTaxReturn,
  DepreciationRow, DepreciationBreakdown, BreakdownRow, ExpenseBreakdown,
  MonthlySalesPurchaseRow, MonthlySalesPurchase, ReserveAllowanceCalc,
  FormBox, BlueReturnStatementPl, BsFormRow, BlueBalanceSheet, BlueStatementReport,
  AssetYearView, FixedAssetView, AssetSchedule, CreateFixedAssetInput,
  RecordMethod, DepreciationPostingResult, DisposalType, DisposeResult,
  ProrationSettingView, ProrationPostingResult,
  OpeningBalanceView, BsPart, BsAccountView, BsSubAccountView, OpeningBalanceTotals,
  OpeningBalancesResponse, CapitalTransferPreview, RolloverResult, RolloverPrecheck,
  AttachmentMeta, DocumentLineView, DocumentView, DocumentLineInput, DocumentInput,
  FilingIssueLevel, FilingIssue, FilingPrecheck, FilingItemKind, FilingSheetItem, FilingSheetGroup,
  FilingChecksum, FilingInstructionSheet, FilingTaxKind, FilingMethod, FilingRecord,
}

export const api = {
  // 既定はアクティブのみ。アーカイブ済みを見せる画面（設定の帳簿パネル）だけ includeArchived を渡す。
  books: (includeArchived = false) =>
    getJson<{ books: BookInfo[] }>(`/api/books${qsOf({ includeArchived })}`)
      .then((d) => d.books),
  createBook: (name: string) => postJson<{ book: BookInfo }>('/api/books', { name }).then((d) => d.book),
  renameBook: (id: string, name: string) => patchJson<{ ok: true }>(`/api/books/${id}`, { name }),
  archiveBook: (id: string) => postJson<{ ok: true }>(`/api/books/${id}/archive`, {}),
  unarchiveBook: (id: string) => postJson<{ ok: true }>(`/api/books/${id}/unarchive`, {}),
  /**
   * エクスポート zip を取り込む（エクスポートの対。data-ops spec）。
   * ボディは zip の生バイト列（multipart にしない＝ブラウザが File をそのままストリームするので、
   * 証憑を含む大きなエクスポートでもメモリに載せずに送れる）。
   * `mode` 未指定で帳簿IDが衝突すると ApiError（code=`book_id_conflict`・`conflict` 付き）。
   */
  importBook: (file: File, mode?: ImportMode) =>
    req(`/api/import${mode ? `?mode=${mode}` : ''}`, { method: 'POST', body: file }).then((r) =>
      json<ImportBookResult>(r),
    ),
  // AI 連携の疎通状態（web-app spec「AI 連携の疎通案内」）。返るのは**観測できた事実**だけで、
  // 「クライアントが導入されているか」は含まない（アプリからは判別できない）。
  mcpLink: () => getJson<McpLinkStatus>('/api/mcp-link'),
  // アプリモード（未設定は null）。起動シーケンスの最初に呼ぶ。
  appMode: () => getJson<{ mode: AppMode | null }>('/api/app-mode').then((d) => d.mode),
  setAppMode: (mode: AppMode) => putJson<{ mode: AppMode }>('/api/app-mode', { mode }).then((d) => d.mode),
  accounts: () => getJson<{ accounts: Account[] }>('/api/accounts').then((d) => d.accounts),
  businessSettings: () =>
    getJson<{ settings: BusinessSettingsView }>('/api/business-settings').then((d) => d.settings),
  updateBusinessSettings: (patch: BusinessSettingsPatch) =>
    putJson<{ settings: BusinessSettingsView }>('/api/business-settings', patch).then((d) => d.settings),
  drafts: (filter?: number | ListDraftsOpts) => {
    // 後方互換: 数値1個は従来の subAccountId 指定。
    const f: ListDraftsOpts = typeof filter === 'number' ? { subAccountId: filter } : filter ?? {}
    return getJson<{ drafts: DraftView[] }>(`/api/drafts${qsOf({ subAccountId: f.subAccountId, from: f.from, to: f.to, q: f.q, confidence: f.confidence })}`)
      .then((d) => d.drafts)
  },
  confirmBatch: (ids: number[]) =>
    postJson<{ results: BatchConfirmResult[]; confirmed: number; failed: number }>(
      '/api/entries/confirm-batch',
      { ids },
    ),
  taxForecast: (params?: { extraExpense?: number; extraDeduction?: number }) => {
    return getJson<{ forecast: TaxForecast | null }>(`/api/tax-forecast${qsOf({ extraExpense: params?.extraExpense, extraDeduction: params?.extraDeduction })}`)
      .then((d) => d.forecast)
  },
  acquisitionTargets: () => getJson<AcquisitionTargets>('/api/acquisition/targets'),
  acquisitionJobs: () =>
    getJson<{ jobs: AcquisitionJob[] }>('/api/acquisition/jobs').then((d) => d.jobs),
  startAcquisition: (source: string) => postJson<AcquisitionJob>('/api/acquisition/jobs', { source }),
  acquisitionJob: (jobId: string) =>
    getJson<AcquisitionJob>(`/api/acquisition/jobs/${encodeURIComponent(jobId)}`),
  abortAcquisition: (jobId: string) =>
    postJson<AcquisitionJob>(`/api/acquisition/jobs/${encodeURIComponent(jobId)}/abort`, {}),
  forgetAcquisitionLogins: () => postJson<{ ok: true }>('/api/desktop/acquisition/forget-logins', {}),
  classificationPolicy: () =>
    getJson<ClassificationPolicy>('/api/acquisition/policy'),
  saveClassificationPolicy: (text: string) =>
    putJson<ClassificationPolicy>('/api/acquisition/policy', { text }),
  resetClassificationPolicy: () =>
    delJson<ClassificationPolicy & { hadOverride: boolean }>('/api/acquisition/policy'),
  serviceCatalog: () =>
    getJson<{ catalog: ServiceCatalogEntry[] }>('/api/services/catalog').then((d) => d.catalog),
  services: () =>
    getJson<{ services: LinkedService[] }>('/api/services').then((d) => d.services),
  registerService: (input: { serviceKey: string; name?: string | null }) =>
    postJson<{ service: LinkedService }>('/api/services', input).then((d) => d.service),
  importCsv: (sourceType: string, accountRef: string, file: File): Promise<CsvImportResult> =>
    req(`/api/import${qsOf({ sourceType, accountRef })}`, {
      method: 'POST',
      body: file,
    }).then((r) => json<CsvImportResult>(r)),
  setLine: (lineId: number, patch: { accountId?: number; subAccountId?: number | null; taxCategoryId?: number | null }) =>
    patchJson<{ ok: true }>(`/api/lines/${lineId}`, patch),
  taxCategories: () =>
    getJson<{ taxCategories: TaxCategory[] }>('/api/tax-categories').then((d) => d.taxCategories),
  confirm: (entryId: number) =>
    postJson<{ ok: true }>(`/api/entries/${entryId}/confirm`, {}),
  createEntry: (input: {
    entryDate: string
    description?: string | null
    status?: 'draft' | 'confirmed'
    lines: ManualEntryLineInput[]
  }) =>
    postJson<{ id: number }>('/api/entries', input),
  trialBalance: (period?: { from?: string; to?: string }) => {
    return getJson<{ report: TrialBalance | null }>(`/api/reports/trial-balance${qsOf({ from: period?.from, to: period?.to })}`)
      .then((d) => d.report)
  },
  pl: () => getJson<{ report: ProfitAndLoss | null }>('/api/reports/pl').then((d) => d.report),
  taxExcludedPl: () =>
    getJson<{ report: TaxExcludedProfitAndLoss | null }>('/api/reports/tax-excluded-pl').then((d) => d.report),
  bs: () => getJson<{ report: BalanceSheet | null }>('/api/reports/bs').then((d) => d.report),
  monthlyTrend: () =>
    getJson<{ report: MonthlyTrend | null }>('/api/reports/monthly-trend').then((d) => d.report),
  taxSales: () =>
    getJson<{ report: TaxSalesSummary | null }>('/api/reports/tax-sales').then((d) => d.report),
  consumptionTaxReturn: () =>
    getJson<{ report: ConsumptionTaxReturn | null }>('/api/tax-return/consumption').then((d) => d.report),
  blueDeduction: () =>
    getJson<{ report: BlueReturnSummary | null }>('/api/tax-return/blue-deduction').then((d) => d.report),
  blueStatement: () =>
    getJson<{ report: BlueStatementReport | null }>('/api/tax-return/blue-statement').then((d) => d.report),
  depreciationBreakdown: () =>
    getJson<{ report: DepreciationBreakdown | null }>('/api/reports/breakdown/depreciation').then((d) => d.report),
  salaryBreakdown: () =>
    getJson<{ report: ExpenseBreakdown | null }>('/api/reports/breakdown/salary').then((d) => d.report),
  rentBreakdown: () =>
    getJson<{ report: ExpenseBreakdown | null }>('/api/reports/breakdown/rent').then((d) => d.report),
  senjuBreakdown: () =>
    getJson<{ report: ExpenseBreakdown | null }>('/api/reports/breakdown/senju').then((d) => d.report),
  monthlySalesPurchase: () =>
    getJson<{ report: MonthlySalesPurchase | null }>('/api/reports/breakdown/monthly-sales-purchase').then((d) => d.report),
  setBlueDeduction65: (qualifiesFor65: boolean) =>
    postJson<{ ok: true }>('/api/tax-return/blue-deduction/settings', { qualifiesFor65 }),
  incomeTaxReturn: () =>
    getJson<{ report: IncomeTaxReturn | null }>('/api/tax-return/income-tax').then((d) => d.report),
  setTaxReturnInputs: (input: Partial<TaxReturnInputsView>) =>
    postJson<{ ok: true }>('/api/tax-return/income-tax/inputs', input),
  postWithholdingSale: (input: { entryDate: string; counterpartyId?: number | null; gross: number; withholdingBase: number; description?: string | null }) =>
    postJson<{ result: { entryId: number; withholding: number; deposit: number } }>('/api/tax-return/withholding-sale', input).then((d) => d.result),
  // 申告の提出支援（filing spec）。precheck・指示書は参照系（年度なしは null）。
  filingPrecheck: () =>
    getJson<{ precheck: FilingPrecheck | null }>('/api/filing/precheck').then((d) => d.precheck),
  filingSheet: () =>
    getJson<{ sheet: FilingInstructionSheet | null }>('/api/filing/instruction-sheet').then((d) => d.sheet),
  filingRecords: (year?: number) =>
    getJson<{ records: FilingRecord[] }>(`/api/filing/records${qsOf({ year })}`).then((d) => d.records),
  createFilingRecord: (input: { taxKind: FilingTaxKind; method: FilingMethod; submittedOn: string; receiptNumber?: string | null; memo?: string | null }) =>
    postJson<{ record: FilingRecord }>('/api/filing/records', input).then((d) => d.record),
  deleteFilingRecord: (id: number) => delJson<{ ok: true }>(`/api/filing/records/${id}`),
  uploadFilingAttachment: (recordId: number, file: File) =>
    req(`/api/filing/records/${recordId}/attachments${qsOf({ fileName: file.name })}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }).then((r) => json<{ attachment: AttachmentMeta }>(r)).then((d) => d.attachment),
  departmentTrialBalance: (period?: { from?: string; to?: string }) => {
    return getJson<{ report: DepartmentTrialBalance | null }>(`/api/reports/department-trial-balance${qsOf({ from: period?.from, to: period?.to })}`)
      .then((d) => d.report)
  },
  departmentPl: (period?: { from?: string; to?: string }) => {
    return getJson<{ report: DepartmentProfitAndLoss | null }>(`/api/reports/department-pl${qsOf({ from: period?.from, to: period?.to })}`)
      .then((d) => d.report)
  },
  ledger: (accountId: number) =>
    getJson<{ report: GeneralLedger | null }>(`/api/reports/ledger/${accountId}`).then((d) => d.report),
  subLedger: (subAccountId: number) =>
    getJson<{ report: SubLedger | null }>(`/api/reports/sub-ledger/${subAccountId}`).then((d) => d.report),
  reconciliation: () =>
    getJson<{ report: ReconcileReport }>('/api/reports/reconciliation').then((d) => d.report),
  importFormats: (includeInactive = false) =>
    getJson<{ formats: ImportFormat[] }>(`/api/import-formats${qsOf({ includeInactive })}`)
      .then((d) => d.formats),
  rawTransactions: (status?: RawStatus, years: RawYearScope = 'open') =>
    getJson<RawTransactionListResponse>(`/api/raw-transactions${qsOf({ status, years: years === 'all' ? 'all' : undefined })}`),
  ignoreRaw: (id: number) => postJson<{ ok: true }>(`/api/raw-transactions/${id}/ignore`, {}),
  restoreRaw: (id: number) => postJson<{ ok: true }>(`/api/raw-transactions/${id}/restore`, {}),
  transferCandidates: () =>
    getJson<{ candidates: TransferCandidateView[] }>('/api/settlement/transfer-candidates').then((d) => d.candidates),
  linkedTransfers: () =>
    getJson<{ links: LinkedTransferView[] }>('/api/settlement/links').then((d) => d.links),
  linkTransfer: (outRawId: number, inRawId: number) => postJson<{ ok: true }>('/api/settlement/link', { outRawId, inRawId }),
  unlinkTransfer: (rawId: number) => postJson<{ ok: true }>('/api/settlement/unlink', { rawId }),
  fiscalYears: () =>
    getJson<{ fiscalYears: FiscalYearView[] }>('/api/fiscal-years').then((d) => d.fiscalYears),
  // 初回セットアップ: 推奨年度の取得・対象年度の確定（暦年1本を open で作成）。
  suggestedFiscalYear: () =>
    getJson<{ year: number }>('/api/fiscal-years/suggested').then((d) => d.year),
  createInitialFiscalYear: (year: number) =>
    postJson<{ fiscalYear: FiscalYearView }>('/api/fiscal-years', { year }).then((d) => d.fiscalYear),
  comparePl: (fiscalYearId?: number, compareTo?: number) =>
    getJson<{ report: ComparativeProfitAndLoss | null }>(`/api/reports/comparison/pl${compareQs(fiscalYearId, compareTo)}`)
      .then((d) => d.report),
  compareTrialBalance: (fiscalYearId?: number, compareTo?: number) =>
    getJson<{ report: ComparativeTrialBalance | null }>(`/api/reports/comparison/trial-balance${compareQs(fiscalYearId, compareTo)}`)
      .then((d) => d.report),
  compareBs: (fiscalYearId?: number, compareTo?: number) =>
    getJson<{ report: ComparativeBalanceSheet | null }>(`/api/reports/comparison/bs${compareQs(fiscalYearId, compareTo)}`)
      .then((d) => d.report),
  /**
   * CSV を取得して名前付きでダウンロード（Blob 経由）。
   * Shift_JIS で欠落した文字があれば（X-Export-Lossy-Chars ヘッダ）警告文字列を返す。
   */
  downloadCsv: async (path: string, filename: string): Promise<string | void> => {
    const res = await req(path)
    if (!res.ok) throw new Error((await res.json().catch(() => ({}))).error ?? `HTTP ${res.status}`)
    const lossy = res.headers.get('X-Export-Lossy-Chars')
    const url = URL.createObjectURL(await res.blob())
    const a = document.createElement('a')
    a.href = url
    a.download = filename
    document.body.appendChild(a)
    a.click()
    a.remove()
    URL.revokeObjectURL(url)
    if (lossy) return `Shift_JIS に変換できない文字（${decodeURIComponent(lossy)}）が ? に置換されました。該当の摘要・科目名・取引先名を見直してください。`
  },
  entries: (filter: ListEntriesFilter = {}) => {
    return getJson<{ entries: EntryView[] }>(`/api/entries${qsOf({ status: filter.status, from: filter.from, to: filter.to, q: filter.q, accountId: filter.accountId || undefined })}`)
      .then((d) => d.entries)
  },
  updateEntry: (
    id: number,
    input: { entryDate: string; description?: string | null; lines: ManualEntryLineInput[]; note?: string | null },
  ) =>
    putJson<{ ok: true }>(`/api/entries/${id}`, input),
  unconfirmEntry: (id: number, note?: string | null) =>
    postJson<{ ok: true }>(`/api/entries/${id}/unconfirm`, { note: note ?? null }),
  deleteEntry: (id: number, note?: string | null) =>
    delJson<{ ok: true }>(`/api/entries/${id}`, { note: note ?? null }),
  auditLogs: (targetId?: number) =>
    getJson<{ logs: AuditLogView[] }>(`/api/audit-logs${targetId ? `?targetId=${targetId}` : ''}`)
      .then((d) => d.logs),
  fixedAssets: () =>
    getJson<{ assets: FixedAssetView[] }>('/api/fixed-assets').then((d) => d.assets),
  assetSchedule: (id: number) =>
    getJson<{ schedule: AssetSchedule }>(`/api/fixed-assets/${id}/schedule`).then((d) => d.schedule),
  usedAssetUsefulLife: (legalYears: number, elapsedMonths: number) =>
    getJson<{ usefulLife: number }>(`/api/fixed-assets/used-useful-life?legalYears=${legalYears}&elapsedMonths=${elapsedMonths}`)
      .then((d) => d.usefulLife),
  createAsset: (asset: CreateFixedAssetInput) =>
    postJson<{ id: number }>('/api/fixed-assets', asset),
  postDepreciation: () =>
    postJson<{ result: DepreciationPostingResult }>('/api/fixed-assets/post-depreciation', {}).then((d) => d.result),
  retireAsset: (id: number, retiredDate: string) =>
    postJson<{ result: DisposeResult }>(`/api/fixed-assets/${id}/retire`, { retiredDate }).then((d) => d.result),
  sellAsset: (id: number, soldDate: string) =>
    postJson<{ result: DisposeResult }>(`/api/fixed-assets/${id}/sell`, { soldDate }).then((d) => d.result),
  // 証憑（添付ファイル）。
  entryAttachments: (entryId: number) =>
    getJson<{ attachments: AttachmentMeta[] }>(`/api/entries/${entryId}/attachments`).then((d) => d.attachments),
  uploadAttachment: (entryId: number, file: File) =>
    req(`/api/entries/${entryId}/attachments${qsOf({ fileName: file.name })}`, {
      method: 'POST',
      headers: { 'Content-Type': file.type || 'application/octet-stream' },
      body: file,
    }).then((r) => json<{ attachment: AttachmentMeta }>(r)).then((d) => d.attachment),
  deleteAttachment: (id: number) =>
    delJson<{ ok: true }>(`/api/attachments/${id}`),
  /** プレビュー/DL 用 URL（<a href> / window.open）。 */
  attachmentUrl: (id: number) => `/api/attachments/${id}/download${bookQuery()}`,
  // 書類（請求書）。
  documents: (filter?: { docType?: string; status?: string }) => {
    return getJson<{ documents: DocumentView[] }>(`/api/documents${qsOf({ docType: filter?.docType, status: filter?.status })}`).then((d) => d.documents)
  },
  createDocument: (input: DocumentInput) => postJson<{ id: number }>('/api/documents', input).then((d) => d.id),
  issueDocument: (id: number) =>
    postJson<{ result: { entryId: number; grossTotal: number; withholding: number; receivable: number } }>(`/api/documents/${id}/issue`, {}).then((d) => d.result),
  collectDocument: (id: number, paymentDate: string, depositAccountId?: number | null) =>
    postJson<{ result: { entryId: number; amount: number } }>(`/api/documents/${id}/collect`, { paymentDate, depositAccountId }).then((d) => d.result),
  voidDocument: (id: number) => postJson<{ ok: true }>(`/api/documents/${id}/void`, {}),
  createReceipt: (id: number) => postJson<{ id: number }>(`/api/documents/${id}/receipt`, {}).then((d) => d.id),
  prorationSettings: () =>
    getJson<{ settings: ProrationSettingView[] }>('/api/proration-settings').then((d) => d.settings),
  upsertProration: (input: { accountId: number; subAccountId?: number | null; businessRatio: number; note?: string | null }) =>
    postJson<{ id: number }>('/api/proration-settings', input),
  deleteProration: (id: number) =>
    delJson<{ ok: true }>(`/api/proration-settings/${id}`),
  postProration: () =>
    postJson<{ result: ProrationPostingResult }>('/api/proration/post', {}).then((d) => d.result),

  // --- 決算整理（開始残高・元入金振替） ----------------------------------------
  openingBalances: () =>
    getJson<OpeningBalancesResponse>('/api/opening-balances'),
  upsertOpeningBalance: (input: { accountId: number; subAccountId?: number | null; side: 'debit' | 'credit'; amount: number }) =>
    postJson<{ id: number }>('/api/opening-balances', input),
  deleteOpeningBalance: (id: number) =>
    delJson<{ ok: true }>(`/api/opening-balances/${id}`),
  capitalTransferPreview: () =>
    getJson<{ preview: CapitalTransferPreview }>('/api/closing/capital-transfer/preview').then((d) => d.preview),
  rolloverPrecheck: () => getJson<RolloverPrecheck>('/api/closing/rollover/precheck'),
  executeRollover: () =>
    postJson<{ result: RolloverResult }>('/api/closing/rollover', { confirm: true }).then((d) => d.result),

  // --- マスタ -----------------------------------------------------------------
  counterparties: (includeInactive = false) =>
    getJson<{ counterparties: Counterparty[] }>(`/api/counterparties${qsOf({ includeInactive })}`)
      .then((d) => d.counterparties),
  createCounterparty: (input: CounterpartyInput) => postJson<{ id: number }>('/api/counterparties', input),
  updateCounterparty: (id: number, input: CounterpartyInput) => putJson<{ ok: true }>(`/api/counterparties/${id}`, input),
  setCounterpartyActive: (id: number, isActive: boolean) => postJson<{ ok: true }>(`/api/counterparties/${id}/active`, { isActive }),

  subAccounts: (accountId?: number, includeInactive = false) => {
    return getJson<{ subAccounts: SubAccount[] }>(`/api/sub-accounts${qsOf({ accountId: accountId || undefined, includeInactive })}`)
      .then((d) => d.subAccounts)
  },
  createSubAccount: (input: SubAccountInput) => postJson<{ id: number }>('/api/sub-accounts', input),
  /** 取引先別の補助科目を get-or-create（開始残高の取引先別繰越用。請求書起票と同じ補助科目に収束）。 */
  linkCounterpartySubAccount: (input: { accountId: number; counterpartyId: number }) =>
    postJson<{ id: number }>('/api/sub-accounts/by-counterparty', input).then((d) => d.id),
  updateSubAccount: (id: number, input: Omit<SubAccountInput, 'accountId'>) => putJson<{ ok: true }>(`/api/sub-accounts/${id}`, input),
  setSubAccountActive: (id: number, isActive: boolean) => postJson<{ ok: true }>(`/api/sub-accounts/${id}/active`, { isActive }),

  departments: (includeInactive = false) =>
    getJson<{ departments: Department[] }>(`/api/departments${qsOf({ includeInactive })}`)
      .then((d) => d.departments),
  createDepartment: (name: string) => postJson<{ id: number }>('/api/departments', { name }),
  updateDepartment: (id: number, name: string) => putJson<{ ok: true }>(`/api/departments/${id}`, { name }),
  setDepartmentActive: (id: number, isActive: boolean) => postJson<{ ok: true }>(`/api/departments/${id}/active`, { isActive }),

  items: (includeInactive = false) =>
    getJson<{ items: Item[] }>(`/api/items${qsOf({ includeInactive })}`)
      .then((d) => d.items),
  createItem: (input: ItemInput) => postJson<{ id: number }>('/api/items', input),
  updateItem: (id: number, input: ItemInput) => putJson<{ ok: true }>(`/api/items/${id}`, input),
  setItemActive: (id: number, isActive: boolean) => postJson<{ ok: true }>(`/api/items/${id}/active`, { isActive }),

  tags: () => getJson<{ tags: Tag[] }>('/api/tags').then((d) => d.tags),
  createTag: (name: string) => postJson<{ id: number }>('/api/tags', { name }),
  deleteTag: (id: number) => delJson<{ ok: true }>(`/api/tags/${id}`),

  rules: (includeInactive = false) =>
    getJson<{ rules: Rule[] }>(`/api/rules${qsOf({ includeInactive })}`)
      .then((d) => d.rules),
  createRule: (input: RuleInput) => postJson<{ id: number }>('/api/rules', input),
  updateRule: (id: number, input: RuleInput) => putJson<{ ok: true }>(`/api/rules/${id}`, input),
  setRuleActive: (id: number, isActive: boolean) => postJson<{ ok: true }>(`/api/rules/${id}/active`, { isActive }),
  deleteRule: (id: number) => delJson<{ ok: true }>(`/api/rules/${id}`),
}

/** 前期比較クエリ（fiscalYearId 省略=open 年度 / compareTo 省略=前期自動）。 */
function compareQs(fiscalYearId?: number, compareTo?: number): string {
  return qsOf({ fiscalYearId: fiscalYearId || undefined, compareTo: compareTo || undefined })
}

/** GET → JSON（83 箇所にあった `req(path).then((r) => json(r))` の手書きを畳む・issue #132）。 */
function getJson<T>(url: string): Promise<T> {
  return req(url).then((r) => json<T>(r))
}
/** DELETE → JSON。body は理由付き削除（deleteEntry の監査 note 等）用。 */
function delJson<T>(url: string, body?: unknown): Promise<T> {
  return req(
    url,
    body === undefined
      ? { method: 'DELETE' }
      : { method: 'DELETE', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
  ).then((r) => json<T>(r))
}
/** JSON body の POST/PUT 共通ヘルパー。 */
function postJson<T>(url: string, body: unknown): Promise<T> {
  return req(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r))
}
function putJson<T>(url: string, body: unknown): Promise<T> {
  return req(url, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r))
}
function patchJson<T>(url: string, body: unknown): Promise<T> {
  return req(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  }).then((r) => json<T>(r))
}
