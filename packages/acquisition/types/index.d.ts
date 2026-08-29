// `@kanean/acquisition` の型（実装は素の ESM）。
// 巡回手順は実ブラウザに強く依存するので JS のまま置き、**外から使う口だけ**をここで型付けする。

export declare const EXIT: { OK: 0; FAIL: 1; PROFILE_LOCKED: 2; PARTIAL: 4 }

export declare class ScrapeError extends Error {
  step: string
  hint?: string
  dumped?: boolean
  exitCode?: number
  diagnostic?: Diagnostic
  constructor(step: string, message: string, hint?: string)
}

export declare class CalibrationRejected extends Error {
  reasons: string[]
}

export type SelValue = string | number | string[]
export type Sel = Record<string, SelValue>

export interface Calibration {
  source: string
  origin: 'bundled' | 'override'
  version: string
  overridden: string[]
}

export interface Diagnostic {
  source: string
  step: string
  steps: string[]
  message: string
  hint: string | null
  url: string | null
  html: string | null
  screenshot: Buffer | null
  time: string
}

export interface StoredDiagnostic extends Omit<Diagnostic, 'html' | 'screenshot'> {
  artifactsDir: string
  screenshotPath: string | null
  htmlBytes: number
  htmlExcerpt: string | null
}

// --- 実装（src/index.mjs）の export と1:1（過不足は __tests__/types.test.mjs が機械検査・issue #170） ---

/** CLI 引数の仕様。 */
export type ArgSpec = Record<string, 'required' | 'optional' | 'flag'>
export declare function parseArgs(argv: string[], spec: ArgSpec): Record<string, string | boolean>
/** サイトスクリプトが受け取る引数の形（殻によらず同一）。 */
export declare const SCRAPE_ARG_SPEC: ArgSpec

/** '￥1,234' '▲1,234' 等 → **円整数**（解釈不能は null＝呼び出し側が行を skip する不変条件）。 */
export declare function yen(s: unknown): number | null
/** 'YYYY/M/D' '「M/D」+yearHint' 等 → ISO 'YYYY-MM-DD'（不能は null）。 */
export declare function isoDate(s: unknown, yearHint?: number | string): string | null

/** 古い順の {amount, direction, balance} で残高チェーンを検証（銀行トラックの生命線）。 */
export declare function verifyBalanceChain(
  txns: ScrapedTxn[],
): { ok: true } | { ok: false; index: number; expected: number; actual: number | undefined; row: ScrapedTxn }

/** サイトスクリプトが使ってよいブラウザ API の全量（殻の実装チェック用データ）。 */
export declare const BROWSER_API: { context: string[]; page: string[]; locator: string[] }

/** run.step() の実行器（失敗時に診断を captureDiagnostic で採取して sink へ流す）。 */
export interface StepRunner {
  steps: string[]
  setPage(page: unknown): void
  step<T>(name: string, fn: () => Promise<T> | T): Promise<T>
}
export declare function makeRunner(
  source: string,
  opts?: { sink?: DiagnosticsSink | null; log?: (msg: string) => void },
): StepRunner
export declare function captureDiagnostic(p: {
  source: string
  page: unknown
  err: ScrapeError
  steps?: string[]
}): Promise<Diagnostic>

/** URL / HTML から認証情報・セッション識別子を落とす（診断は redact 済みだけを持つ）。 */
export declare function redactUrl(rawUrl: string): string | null
export declare function redactHtml(html: string): string

/** 巡回で得た1取引（銀行・カード）。金額は円整数、方向とは分離。 */
export interface ScrapedTxn {
  txnDate: string
  amount: number
  direction: 'in' | 'out'
  description: string
  balance?: number
}

/** 巡回で得た1注文（EC）。 */
export interface ScrapedOrder {
  orderId: string
  orderDate: string
  orderTotal: number
  shipping: number
  pointsUsed: number
  lines: { lineNo: number; itemName: string; quantity: number; lineAmount: number; evidenceRef: string }[]
}

export interface ScrapeResult {
  source: string
  kind: 'bank' | 'card' | 'ec'
  script: string
  calibration: Calibration
  scrapedAt: string
  range: { since: string; until: string }
  transactions?: ScrapedTxn[]
  orders?: ScrapedOrder[]
  failedOrders?: { orderId: string; orderDate: string; reason: string }[]
  billingMonths?: { month: string; newUsageTotal: number; txnCount: number }[]
  verification?: Record<string, unknown>
  warnings: string[]
  partial?: boolean
  exitCode: number
}

export interface SiteModule {
  SOURCE: string
  KIND: 'bank' | 'card' | 'ec'
  EVIDENCE_KEY: string
  SCRIPT: string
  DEFAULT_SEL: Sel
  NAVIGABLE_KEYS: string[]
  /**
   * 失敗の粒度（issue #171）: 'all'＝1箇所でも検算が崩れたら throw（部分成功なし・銀行/カード）/
   * 'order'＝注文単位で failedOrders に積み partial（EC）。partial/exitCode は run.mjs が一元判定。
   */
  FAILURE_GRANULARITY: 'all' | 'order'
  scrape(ctx: unknown): Promise<Record<string, unknown>>
}

export declare const SITES: Record<string, SiteModule>
export declare const SOURCES: string[]
export declare const ALIASES: Record<string, string>
export declare function getSite(nameOrSource: string): SiteModule | null

export declare function validateSelectors(
  defaults: Sel,
  candidate: unknown,
  navigableKeys?: string[],
): { ok: true; value: Sel } | { ok: false; reasons: string[] }

export declare function mergeSelectors(
  source: string,
  defaults: Sel,
  override: Sel | null,
  navigableKeys?: string[],
): { sel: Sel; calibration: Calibration }

export declare function bundledVersion(defaults: Sel): string

export declare function selectorsDir(dataDir: string): string
export declare function selectorsPath(dataDir: string, source: string): string
export declare function readOverride(dataDir: string, source: string): Sel | null
export declare function writeOverride(
  dataDir: string,
  source: string,
  defaults: Sel,
  candidate: unknown,
  navigableKeys?: string[],
): { file: string; overridden: string[] }
export declare function clearOverride(dataDir: string, source: string): { file: string; existed: boolean }

export declare function diagnosticsDir(dataDir: string, source: string): string
export declare function dataDirDiagnosticsSink(dataDir: string, source: string): DiagnosticsSink & { dir: string }
export declare function readDiagnostic(
  dataDir: string,
  source: string,
  opts?: { htmlExcerptChars?: number },
): StoredDiagnostic | null

/** 証跡ストア（enabled=false なら保存せず ref は fallback を返す）。 */
export interface EvidenceStore {
  enabled: boolean
  save(relPath: string, buffer: Buffer): Promise<string | null>
  ref(relPath: string, fallback: string): string
}

/** 失敗診断の書き出し先。 */
export interface DiagnosticsSink {
  dir?: string
  dump(record: Diagnostic): Promise<string>
}

/** 巡回契約を満たすブラウザ文脈（runtime/electron の AcquisitionContext と同形）。 */
export interface ScrapeContext {
  pages(): unknown[]
  newPage(): Promise<unknown>
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<unknown | null>
  close(): Promise<void>
  fetchBinary(url: string): Promise<{ ok: boolean; status: number; body: Buffer }>
}

/**
 * runScrape の入力（issue #170 で Record<string, unknown> を廃止）。
 * キー名の打ち間違い（例 selectorsOverride の綴り違い＝較正が黙って無効）を型検査で止める。
 */
export interface RunScrapeOptions {
  site: SiteModule
  context: ScrapeContext
  args: { since: string; until: string; loginTimeout?: string }
  /** `$DATA_DIR` 側の上書き較正（無ければ同梱を使う）。 */
  selectorsOverride?: Sel | null
  evidence?: EvidenceStore
  sink?: DiagnosticsSink | null
  tools?: { pdfToText?(buffer: Buffer | Uint8Array): Promise<string> }
  log?: (msg: string) => void
  onWaiting?: (message: string) => void | Promise<void>
  isAborted?: () => boolean
}

export declare function runScrape(p: RunScrapeOptions): Promise<ScrapeResult>
export declare const NO_EVIDENCE: EvidenceStore

export declare function evidenceDir(dataDir: string, key: string): string
export declare function dataDirEvidenceStore(dataDir: string, key: string, enabled: boolean): EvidenceStore

/** PDF をテキストへ（同梱の pdf.js。外部コマンドに依存しない）。**非同期**。 */
export declare function pdfToText(buffer: Buffer | Uint8Array): Promise<string>
/** 座標付き断片から `-layout` 相当の行を組む（純関数）。 */
export declare function layoutFromItems(
  items: { str: string; x: number; y: number; w?: number }[],
): string
