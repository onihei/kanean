import type { AssetYearView, FixedAssetView, AssetSchedule, CreateFixedAssetInput } from '@kanean/shared'
export type { AssetYearView, FixedAssetView, AssetSchedule, CreateFixedAssetInput }
import { eq } from 'drizzle-orm'
import { yen, rateFraction } from '@kanean/shared'
import {
  straightLineRate,
  straightLineSchedule,
  lumpSumSchedule,
  minorSpecialYear,
  decliningBalanceRate,
  decliningBalanceSchedule,
  type DepreciationYear,
} from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { accounts, fixedAssets, fiscalYears } from '../db/data/schema.js'
import { getOpenFiscalYear } from '../db/lookups.js'

/**
 * 固定資産台帳（depreciation-spec）。core の償却スケジュールを暦年にマッピングする。
 * straight_line（定額法）/ declining_balance（定率法200%）/ lump_sum（一括償却）/
 * minor_special（少額特例）を算定し、未知の method・率未解決は supported=false で素通し表示。
 * 償却スケジュールは都度計算（純関数）。depreciation_entries への永続化・仕訳起票は posting.ts。
 */

/** 少額減価償却資産特例（措法28の2）の1資産あたり取得価額上限（30万円・未満が対象）。 */
const MINOR_SPECIAL_LIMIT = 300_000

/**
 * 登録を受け付ける償却方法。スケジュール算定対応の4種＋台帳・青色決算書表示のみ対応の旧法2種
 * （旧法は buildSchedule が supported:false を返し、aoiroOverlay が旧定額/旧定率として描画する）。
 */
const DEPRECIATION_METHODS = [
  'straight_line',
  'declining_balance',
  'lump_sum',
  'minor_special',
  'old_straight_line',
  'old_declining_balance',
] as const

/** YYYY-MM-DD 形式かつ実在する日付か（2026-02-30 等を弾く）。 */
function assertIsoDate(value: string, label: string): void {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) throw new Error(`${label} は YYYY-MM-DD 形式で指定してください`)
  const dt = new Date(`${value}T00:00:00Z`)
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== value) {
    throw new Error(`${label} ${value} は存在しない日付です`)
  }
}

const monthOf = (iso: string): number => Number(iso.slice(5, 7))
const yearOf = (iso: string): number => Number(iso.slice(0, 4))

/** 供用開始日（属する月）から期末（12月）までの月数。暦年前提。端数日は1月に切上げ済み扱い。 */
function firstYearMonths(serviceStartIso: string): number {
  return 12 - monthOf(serviceStartIso) + 1
}

/** 定額法の償却率を解決する（保持値優先、無ければ耐用年数表）。 */
function resolveRate(asset: { depreciationRate: number | null; usefulLife: number | null }): number | null {
  if (asset.depreciationRate != null) return asset.depreciationRate
  if (asset.usefulLife != null) {
    try {
      return straightLineRate(asset.usefulLife)
    } catch {
      return null
    }
  }
  return null
}

type AssetRow = typeof fixedAssets.$inferSelect

/** 償却率の解決結果（判別共用体）。一括償却・少額特例・旧法・率未解決は null。 */
export type ResolvedDepRates =
  | { method: 'straight_line'; rate: number }
  | { method: 'declining_balance'; rate: number; revisedRate: number | null; guaranteeRate: number | null }

/**
 * 償却方法に応じた償却率の解決ポリシー（**期末一括起票と処分時月割の単一真実源**）。
 * - 定額法: DB 保持率を優先、無ければ耐用年数表（straightLineRate）。
 * - 定率法: 改定償却率・保証率の3点が必要なため**保持率 depreciation_rate は使わず**、
 *   必ず耐用年数表（decliningBalanceRate）で解決する（保持率のみでは改定/保証が欠ける）。
 * 率を解決できない（表未収載・耐用年数なし等）場合は null。
 * ⚠️ この解決規則が register（期末償却 buildSchedule）と retirement（処分時月割）で
 * 別実装に分かれると、同一資産に異なる率が使われ「総額は不変」（retirement.ts 冒頭）の
 * 不変条件が壊れる。変更は必ず本関数で行うこと。
 */
export function resolveDepreciationRates(
  asset: Pick<AssetRow, 'depreciationMethod' | 'depreciationRate' | 'usefulLife'>,
): ResolvedDepRates | null {
  switch (asset.depreciationMethod) {
    case 'straight_line': {
      const rate = resolveRate(asset)
      return rate == null ? null : { method: 'straight_line', rate }
    }
    case 'declining_balance': {
      if (asset.usefulLife == null) return null
      try {
        const r = decliningBalanceRate(asset.usefulLife)
        return { method: 'declining_balance', rate: r.rate, revisedRate: r.revisedRate, guaranteeRate: r.guaranteeRate }
      } catch {
        return null // 償却率表に未収載の耐用年数
      }
    }
    default:
      return null
  }
}

/** core の償却スケジュール（DepreciationYear[]）を暦年・期首残高付きの AssetYearView[] へ写像。 */
function toYearViews(sched: DepreciationYear[], startYear: number, firstOpening: number): AssetYearView[] {
  let opening = firstOpening
  return sched.map((y, i) => {
    const view: AssetYearView = {
      year: startYear + i,
      openingBookValue: yen(opening),
      depreciationAmount: y.depreciationAmount,
      businessAmount: y.businessAmount,
      householdAmount: y.householdAmount,
      closingBookValue: y.closingBookValue,
    }
    opening = y.closingBookValue
    return view
  })
}

/**
 * 償却スケジュールを暦年付きで生成する。
 * straight_line（定額法）/ declining_balance（定率法200%）/ lump_sum（一括償却・3年均等）/
 * minor_special（少額特例・即時）に対応。定率法は耐用年数から償却率/改定償却率/保証率を解決する。
 */
export function buildSchedule(asset: AssetRow): { supported: boolean; years: AssetYearView[] } {
  const serviceStart = asset.businessStartDate ?? asset.acquiredDate
  if (!serviceStart) return { supported: false, years: [] }
  const startYear = yearOf(serviceStart)
  const cost = yen(asset.acquisitionCost)

  switch (asset.depreciationMethod) {
    case 'straight_line': {
      const resolved = resolveDepreciationRates(asset)
      if (resolved?.method !== 'straight_line') return { supported: false, years: [] }
      try {
        const sched = straightLineSchedule({ acquisitionCost: cost, rate: resolved.rate, businessUseRatio: asset.businessUseRatio, firstYearMonths: firstYearMonths(serviceStart) })
        return { supported: true, years: toYearViews(sched, startYear, asset.acquisitionCost) }
      } catch {
        // DB 保持率が公示率の桁形（小数5桁以内）でない旧データ等は rateFraction が拒否する。
        // 誤った率で黙って計算するより未対応として表示する（一覧・帳票を落とさない）。
        return { supported: false, years: [] }
      }
    }
    case 'declining_balance': {
      const resolved = resolveDepreciationRates(asset)
      if (resolved?.method !== 'declining_balance') return { supported: false, years: [] }
      const sched = decliningBalanceSchedule({
        acquisitionCost: cost,
        rate: resolved.rate,
        revisedRate: resolved.revisedRate,
        guaranteeRate: resolved.guaranteeRate,
        businessUseRatio: asset.businessUseRatio,
        firstYearMonths: firstYearMonths(serviceStart),
      })
      return { supported: true, years: toYearViews(sched, startYear, asset.acquisitionCost) }
    }
    case 'lump_sum':
      return { supported: true, years: toYearViews(lumpSumSchedule(cost), startYear, asset.acquisitionCost) }
    case 'minor_special':
      // 取得価額30万円以上は少額特例の対象外（誤指定時は即時全額経費にせず未対応扱い）。
      if (asset.acquisitionCost >= MINOR_SPECIAL_LIMIT) return { supported: false, years: [] }
      return { supported: true, years: toYearViews([minorSpecialYear(cost, asset.businessUseRatio)], startYear, asset.acquisitionCost) }
    default:
      return { supported: false, years: [] }
  }
}

/** 対象暦年の償却行と期末帳簿価額を取り出す。 */
function viewForYear(asset: AssetRow, targetYear: number): Pick<FixedAssetView, 'supported' | 'current' | 'bookValue'> {
  const { supported, years } = buildSchedule(asset)
  if (!supported) return { supported: false, current: null, bookValue: asset.acquisitionCost }
  const startYear = years[0]?.year ?? targetYear
  if (targetYear < startYear) return { supported: true, current: null, bookValue: asset.acquisitionCost } // 未供用
  const hit = years.find((y) => y.year === targetYear)
  if (hit) return { supported: true, current: hit, bookValue: hit.closingBookValue }
  // スケジュール終了後＝備忘1円のまま据え置き。
  const last = years[years.length - 1]
  return { supported: true, current: null, bookValue: last?.closingBookValue ?? asset.acquisitionCost }
}

function openYear(db: DataDb): typeof fiscalYears.$inferSelect | undefined {
  return getOpenFiscalYear(db)
}

function accountNameOf(db: DataDb, accountId: number | null): string | null {
  if (accountId == null) return null
  return db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, accountId)).all()[0]?.name ?? null
}

function toView(db: DataDb, asset: AssetRow, targetYear: number): FixedAssetView {
  const { supported, current, bookValue } = viewForYear(asset, targetYear)
  return {
    id: asset.id,
    managementNo: asset.managementNo,
    name: asset.name,
    accountName: accountNameOf(db, asset.accountId),
    acquisitionCost: asset.acquisitionCost,
    acquiredDate: asset.acquiredDate,
    businessStartDate: asset.businessStartDate,
    depreciationMethod: asset.depreciationMethod,
    usefulLife: asset.usefulLife,
    depreciationRate: asset.depreciationRate,
    businessUseRatio: asset.businessUseRatio,
    status: asset.status,
    supported,
    current,
    bookValue,
  }
}

/** 固定資産一覧（対象は open 年度の暦年での償却）。 */
export function listFixedAssets(db: DataDb): FixedAssetView[] {
  const fy = openYear(db)
  const targetYear = fy ? yearOf(fy.startDate) : new Date().getFullYear()
  return db
    .select()
    .from(fixedAssets)
    .all()
    .sort((a, b) => (a.managementNo ?? '').localeCompare(b.managementNo ?? '') || a.id - b.id)
    .map((a) => toView(db, a, targetYear))
}

/** 1資産の全期間スケジュール。 */
export function fixedAssetSchedule(db: DataDb, assetId: number): AssetSchedule {
  const asset = db.select().from(fixedAssets).where(eq(fixedAssets.id, assetId)).all()[0]
  if (!asset) throw new Error(`固定資産 ${assetId} が見つかりません`)
  const fy = openYear(db)
  const targetYear = fy ? yearOf(fy.startDate) : new Date().getFullYear()
  const { supported, years } = buildSchedule(asset)
  return { asset: toView(db, asset, targetYear), supported, years }
}

/** 固定資産を登録する。 */
export function createFixedAsset(db: DataDb, input: CreateFixedAssetInput): number {
  if (!input.name?.trim()) throw new Error('名称が必要')
  if (!Number.isInteger(input.acquisitionCost) || input.acquisitionCost <= 0) throw new Error('取得価額は正の整数')
  const ratio = input.businessUseRatio ?? 100
  // 整数%前提（applyRate は整数 num/den のみ。非整数は桁落ち回避のため弾く）。
  if (!Number.isInteger(ratio) || ratio < 0 || ratio > 100) throw new Error('事業利用比率は 0..100 の整数')
  const method = input.depreciationMethod ?? 'straight_line'
  // HTTP 境界は無検証キャストのため、不正値（typo・未知 method・NaN 日付等）はここで遮断する。
  if (!(DEPRECIATION_METHODS as readonly string[]).includes(method)) throw new Error(`償却方法 "${method}" は未対応です`)
  if (input.acquiredDate != null) assertIsoDate(input.acquiredDate, '取得日')
  if (input.businessStartDate != null) assertIsoDate(input.businessStartDate, '供用開始日')
  if (input.usefulLife != null && (!Number.isInteger(input.usefulLife) || input.usefulLife <= 0)) {
    throw new Error('耐用年数は正の整数')
  }
  if (input.depreciationRate != null) {
    if (!(Number.isFinite(input.depreciationRate) && input.depreciationRate > 0 && input.depreciationRate <= 1)) {
      throw new Error('償却率は 0 より大きく 1 以下')
    }
    try {
      // 償却計算は整数分数（rateFraction）で行うため、公示率の桁形（小数5桁以内）のみ受け付ける。
      rateFraction(input.depreciationRate)
    } catch {
      throw new Error('償却率は公示の償却率（小数5桁以内）で指定してください')
    }
  }
  // 少額特例（措法28の2）は1資産あたり取得価額30万円未満が適格要件。
  if (method === 'minor_special' && input.acquisitionCost >= MINOR_SPECIAL_LIMIT) {
    throw new Error('少額減価償却資産特例は取得価額30万円未満が対象です')
  }
  const now = new Date().toISOString()
  return db
    .insert(fixedAssets)
    .values({
      name: input.name.trim(),
      managementNo: input.managementNo ?? null,
      accountId: input.accountId ?? null,
      acquisitionCost: input.acquisitionCost,
      acquiredDate: input.acquiredDate ?? null,
      businessStartDate: input.businessStartDate ?? null,
      depreciationMethod: method,
      usefulLife: input.usefulLife ?? null,
      depreciationRate: input.depreciationRate ?? null,
      businessUseRatio: ratio,
      note: input.note ?? null,
      status: 'active',
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()[0].id
}
