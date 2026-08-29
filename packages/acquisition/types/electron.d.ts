// Electron 実行殻の型。`electron` は引数で受け取る（素の Node からも読み込めるようにするため）。

export declare const ACQUISITION_PARTITION: string
export declare const DEFAULT_ACTION_TIMEOUT_MS: number

export declare function normalizeUserAgent(rawUserAgent: string): string
/** UA Client Hints を巡回ウィンドウへ適用する（遷移の**前**に呼ぶ）。 */
export declare function applyClientHints(win: unknown, userAgent: string): Promise<void>

export interface AcquisitionContext {
  pages(): unknown[]
  newPage(): Promise<unknown>
  waitForEvent(event: string, opts?: { timeout?: number }): Promise<unknown | null>
  close(): Promise<void>
  fetchBinary(url: string): Promise<{ ok: boolean; status: number; body: Buffer }>
}

export declare function createElectronContext(p: {
  electron: unknown
  partition?: string
  onWindow?: (win: unknown) => void
  windowOptions?: Record<string, unknown>
}): AcquisitionContext

export declare function clearAcquisitionSession(electron: unknown, partition?: string): Promise<void>
