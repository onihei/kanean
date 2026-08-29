import type { AcquisitionTarget } from '@kanean/shared'
import type { DataDb } from '../db/router.js'
import { listLinkedServices } from '../import/ecServices.js'
import { getWatermark, nextDay } from './watermark.js'

/**
 * 巡回対象（連携サービス）と、その投入先。wire 型（shared の AcquisitionTarget）から
 * watermark 由来の2項目（http/acquisition.ts が付ける）を除いた基礎情報。
 * Omit で定義する＝フィールドが wire 型とズレたら型検査で落ちる（issue #128 のドリフト再発防止）。
 */
export type AcquisitionTargetBase = Omit<AcquisitionTarget, 'continuousUntil' | 'hasCrawler'>

export class NoOpenFiscalYearError extends Error {
  readonly code = 'no_open_fiscal_year'
  constructor() {
    super('開いている会計年度がありません（取得範囲を決められません）')
    this.name = 'NoOpenFiscalYearError'
  }
}

export class UnknownSourceError extends Error {
  readonly code = 'unknown_source'
  constructor(source: string) {
    super(`連携サービスが登録されていません: ${source}`)
    this.name = 'UnknownSourceError'
  }
}

/** 登録済みの連携サービスを1つの形に揃えて列挙する。 */
export function listTargets(db: DataDb): { openFiscalYear: { startDate: string; endDate: string } | null; evidenceCapture: boolean; targets: AcquisitionTargetBase[] } {
  const linked = listLinkedServices(db)
  const targets: AcquisitionTargetBase[] = [
    ...linked.services.map((s) => ({ ...s, kind: 'ec' as const })),
    ...linked.bankAccounts.map((s) => ({ ...s, kind: 'bank' as const })),
    ...linked.cards.map((s) => ({ ...s, kind: 'card' as const })),
  ].map((s) => ({
    source: s.source,
    accountRef: s.accountRef,
    kind: s.kind,
    displayName: s.displayName,
    lastImportedAt: s.lastImportedAt,
    fetchSince: s.fetchSince,
  }))
  return {
    openFiscalYear: linked.openFiscalYear
      ? { startDate: linked.openFiscalYear.startDate, endDate: linked.openFiscalYear.endDate }
      : null,
    evidenceCapture: linked.evidenceCapture,
    targets,
  }
}

export function findTarget(db: DataDb, source: string): AcquisitionTargetBase {
  const found = listTargets(db).targets.find((t) => t.source === source)
  if (!found) throw new UnknownSourceError(source)
  return found
}

/**
 * 取得範囲＝**開いている会計期間 ∩ 前回取得以降**（acquisition spec）。
 * 人が範囲を限った場合はそれを尊重しつつ、`rangeLimited` を立てて差分の起点を前進させない。
 */
export function resolveRange(
  db: DataDb,
  dataDir: string,
  bookId: string,
  source: string,
  requested: { since?: string; until?: string } = {},
  today = new Date().toISOString().slice(0, 10),
): { since: string; until: string; rangeLimited: boolean } {
  const { openFiscalYear } = listTargets(db)
  if (!openFiscalYear) throw new NoOpenFiscalYearError()
  const target = findTarget(db, source)

  // 連続して取れている終端の翌日から。無ければ取込済み実績（fetchSince）、それも無ければ期首。
  const watermark = getWatermark(dataDir, bookId, source)
  const base = watermark ? nextDay(watermark) : (target.fetchSince ?? openFiscalYear.startDate)

  const naturalSince = maxDate(openFiscalYear.startDate, base)
  const naturalUntil = minDate(openFiscalYear.endDate, today)

  // 期間の外は取りに行かない。要求があっても開いている期間へ丸める。
  const since = requested.since ? clamp(requested.since, openFiscalYear) : naturalSince
  const until = requested.until ? clamp(requested.until, openFiscalYear) : naturalUntil

  // 起点より後ろから始める取得は、あいだに未取得の穴を残す
  const rangeLimited = since > naturalSince
  return { since, until: maxDate(since, until), rangeLimited }
}

function clamp(date: string, fy: { startDate: string; endDate: string }): string {
  return minDate(maxDate(date, fy.startDate), fy.endDate)
}

function maxDate(a: string, b: string): string {
  return a >= b ? a : b
}

function minDate(a: string, b: string): string {
  return a <= b ? a : b
}
