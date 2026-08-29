import type { DisposalType, DisposeResult } from '@kanean/shared'
export type { DisposalType, DisposeResult }
import { and, eq, sql } from 'drizzle-orm'
import { yen, applyRate } from '@kanean/shared'
import { assertBalanced, retirementYearDepreciation, type DepreciationYear } from '@kanean/core'
import { resolveDepreciationRates } from './register.js'
import type { DataDb } from '../db/router.js'
import { requireAccountIdByName as accountIdByName } from '../db/lookups.js'
import {
  accountCategories,
  accounts,
  businessSettings,
  depreciationEntries,
  fiscalYears,
  fixedAssets,
  journalEntries,
  journalLines,
  statementItems,
} from '../db/data/schema.js'

/**
 * 固定資産の処分（除却・売却）処理（depreciation-spec §7）。台帳からの処分を自動化する。
 *
 * 除却（retirement・status=retired）: 未償却残高を按分し、事業分→固定資産除却損／家事分→事業主貸。
 *   間接法: 借)減価償却累計額[累計] 借)固定資産除却損[事業分] 借)事業主貸[家事分] / 貸)対象資産[取得価額]
 *   直接法: 借)固定資産除却損[事業分] 借)事業主貸[家事分] / 貸)対象資産[未償却残高]
 *
 * 売却（sale・status=sold）: 売却損益は**譲渡所得**で事業所得と別計算（売却代金・取得費・譲渡損益の
 *   計算は本システム対象外＝手計算）。台帳側のみ自動化し、未償却残高の**全額を事業主貸へ振替**えて
 *   事業の帳簿から落とす（除却損＝P/L には計上しない）。参照CSVの「資産譲渡損（事業主貸）」に対応。
 *   間接法: 借)減価償却累計額[累計] 借)事業主貸[未償却残高] / 貸)対象資産[取得価額]
 *   直接法: 借)事業主貸[未償却残高] / 貸)対象資産[未償却残高]
 *
 * 処分年度の償却（depreciation-spec §7）: 定額法/定率法は**期首〜処分月で月割した当期償却**を先に
 * 起票（source='retirement'/'sale'）し、その後の未償却残高を除却損／事業主貸へ振替える。これにより
 * 当期の減価償却費と処分（除却損／売却振替）が正しく区分される（総額は不変）。当年度償却が既に起票済み
 * ／一括償却・少額特例等で月割対象外の場合は note で明示する。
 *   未償却残高 = 取得価額 − Σ(depreciation_entries.depreciationAmount)（処分年度の月割を含む実累計）。
 *
 * 一括償却資産（lump_sum）は除却・売却いずれでも処分損益を認識せず3年均等償却を継続（spec §5・所令§139）。
 * ⚠️ legalRisk:high — 処分損の計上時期・按分・譲渡区分（譲渡所得）は税理士サインオフ対象。
 */

const LOSS_NAME = '固定資産除却損'
const OWNER_DRAW = '事業主貸'
const ACCUMULATED = '減価償却累計額'
const DEP_EXPENSE = '減価償却費'

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/

function recordMethodOf(db: DataDb): 'direct' | 'indirect' {
  const s = db.select({ m: businessSettings.depreciationRecordMethod }).from(businessSettings).all()[0]
  return s?.m === 'direct' ? 'direct' : 'indirect'
}

/** 固定資産除却損（経費）科目を取得。無ければ経費カテゴリ配下に作成する（既存DBの自己修復）。 */
function ensureLossAccount(db: DataDb): number {
  const existing = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, LOSS_NAME)).all()[0]
  if (existing) return existing.id

  const cat = db
    .select({ id: accountCategories.id })
    .from(accountCategories)
    .where(and(eq(accountCategories.reportType, 'PL'), eq(accountCategories.name, '経費')))
    .all()[0]
  if (!cat) throw new Error('経費カテゴリが見つかりません（シード未完）')

  const [{ maxOrder }] = db.select({ maxOrder: sql<number>`coalesce(max(${accounts.sortOrder}), 0)` }).from(accounts).all()
  const now = new Date().toISOString()
  const item = db.insert(statementItems).values({ categoryId: cat.id, name: LOSS_NAME, sortOrder: maxOrder + 1 }).returning().all()[0]
  return db
    .insert(accounts)
    .values({ statementItemId: item.id, name: LOSS_NAME, normalBalance: 'debit', isSystem: true, isActive: true, sortOrder: maxOrder + 2, createdAt: now, updatedAt: now })
    .returning()
    .all()[0].id
}

const monthOf = (iso: string): number => Number(iso.slice(5, 7))
const yearOf = (iso: string): number => Number(iso.slice(0, 4))


/** 後方互換: 除却の戻り値型。 */
export type RetireResult = DisposeResult

/** 固定資産を処分（除却 or 売却）し、処分仕訳を起票する（confirmed）。 */
export function disposeFixedAsset(db: DataDb, fiscalYearId: number, assetId: number, disposedDate: string, disposalType: DisposalType): DisposeResult {
  const isSale = disposalType === 'sale'
  const label = isSale ? '売却日' : '除却日'
  if (!ISO_DATE.test(disposedDate)) throw new Error(`${label}は YYYY-MM-DD 形式で指定してください`)
  // 桁形だけでなく実在日付か（2024-02-30 等を弾く。manualEntry と同規約）。
  const dt = new Date(`${disposedDate}T00:00:00Z`)
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== disposedDate) {
    throw new Error(`${label} ${disposedDate} は存在しない日付です`)
  }
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fiscalYearId} が見つかりません`)
  if (disposedDate < fy.startDate || disposedDate > fy.endDate) throw new Error(`${label}は当会計年度の範囲内で指定してください`)

  const asset = db.select().from(fixedAssets).where(eq(fixedAssets.id, assetId)).all()[0]
  if (!asset) throw new Error(`固定資産 ${assetId} が見つかりません`)
  if (asset.status !== 'active') throw new Error(asset.status === 'sold' ? '既に売却済みの固定資産です' : '既に除却済みの固定資産です')

  const newStatus = isSale ? 'sold' : 'retired'

  // 一括償却資産（depreciation-spec §5・所令§139）: 年の途中で除却・売却しても処分損益を認識せず
  // 3年均等償却を継続する。よって処分仕訳は起票せず、台帳の status・retiredDate のみ記録する。残りの
  // 1/3 は期末の postDepreciation が3年枠内で継続起票する（posting.ts のフィルタが lump_sum の処分済み
  // 資産を対象に含む。3年を超える年は buildSchedule が該当年を返さず自然に止まる）。
  if (asset.depreciationMethod === 'lump_sum') {
    const posted = db
      .select({ dep: depreciationEntries.depreciationAmount })
      .from(depreciationEntries)
      .where(eq(depreciationEntries.fixedAssetId, assetId))
      .all()
    const priorAccumulated = posted.reduce<number>((s, r) => s + r.dep, 0)
    const now = new Date().toISOString()
    db.update(fixedAssets).set({ status: newStatus, retiredDate: disposedDate, updatedAt: now }).where(eq(fixedAssets.id, assetId)).run()
    return {
      disposalType,
      entryId: null,
      currentYearDepreciation: yen(0),
      depreciationEntryId: null,
      bookValue: yen(Math.max(0, asset.acquisitionCost - priorAccumulated)),
      lossBusiness: yen(0),
      lossHousehold: yen(0),
      ownerTransfer: yen(0),
      accumulated: yen(priorAccumulated),
      note: isSale
        ? '一括償却資産は売却後も3年均等償却を継続し、譲渡損益・取得費を認識しません（所令§139）。譲渡所得の計上は不要です。残りの償却は期末の減価償却起票で継続されます。'
        : '一括償却資産は除却後も3年均等償却を継続し、除却損を計上しません（spec §5）。残りの償却は期末の減価償却起票で継続されます。',
    }
  }

  if (!asset.accountId) throw new Error('対象資産の勘定科目が未設定のため処分仕訳を作成できません')

  // 既に起票済みの償却累計（処分年度より前の年度＝通常 + 既出の当年度分）。
  const prior = db.select({ dep: depreciationEntries.depreciationAmount }).from(depreciationEntries).where(eq(depreciationEntries.fixedAssetId, assetId)).all()
  const priorAccumulated = prior.reduce<number>((s, r) => s + r.dep, 0)

  // 処分年度の月割償却を算定する（定額法/定率法・当年度未起票・供用日ありのときのみ）。
  const serviceStart = asset.businessStartDate ?? asset.acquiredDate
  const alreadyPostedThisYear =
    db
      .select({ id: depreciationEntries.id })
      .from(depreciationEntries)
      .where(and(eq(depreciationEntries.fixedAssetId, assetId), eq(depreciationEntries.fiscalYearId, fiscalYearId)))
      .all().length > 0

  let currentDep: DepreciationYear | null = null
  let monthsUsed = 12
  let prorationAttempted = false
  // 率の解決は register と共有（期末一括起票と同一ポリシー。別実装だと総額不変の前提が壊れる）。
  const params = resolveDepreciationRates(asset)
  if (params && serviceStart && !alreadyPostedThisYear) {
    const serviceStartYear = yearOf(serviceStart)
    const serviceStartMonth = monthOf(serviceStart)
    const dispYearIndex = yearOf(disposedDate) - serviceStartYear
    // 処分年度の償却月数: 取得年に処分なら供用月〜処分月、翌年以降なら期首月〜処分月。
    const startMonth = dispYearIndex === 0 ? serviceStartMonth : monthOf(fy.startDate)
    const months = monthOf(disposedDate) - startMonth + 1
    if (dispYearIndex >= 0 && months >= 1 && months <= 12) {
      monthsUsed = months
      prorationAttempted = true
      // 注意: 定率法は core が取得価額起点の理論スケジュールで期首残高（と改定取得価額の状態）を
      // 復元するため、過年度の償却起票を毎期行っている（=台帳が schedule どおり）前提で正しい。
      // 過年度の起票漏れがあると当期月割の期首残高が実残高と乖離しうる（その場合は帳簿自体が要修正）。
      currentDep = retirementYearDepreciation({
        method: params.method,
        acquisitionCost: yen(asset.acquisitionCost),
        rate: params.rate,
        revisedRate: params.method === 'declining_balance' ? params.revisedRate : null,
        guaranteeRate: params.method === 'declining_balance' ? params.guaranteeRate : null,
        businessUseRatio: asset.businessUseRatio,
        firstYearMonths: 12 - serviceStartMonth + 1,
        retirementYearIndex: dispYearIndex,
        retirementMonths: months,
      })
    }
  }
  // 月割を試みたが core が null（＝既に備忘1円まで償却済み）を返した場合。
  const fullyDepreciated = prorationAttempted && currentDep == null
  const postCurrent = currentDep != null && currentDep.depreciationAmount > 0
  const currentDepAmount = postCurrent ? currentDep!.depreciationAmount : 0

  // 処分年度の月割償却を含む実累計と未償却残高。
  const accumulated = priorAccumulated + currentDepAmount
  const bookValue = Math.max(0, asset.acquisitionCost - accumulated)

  // 未償却残高の振替先:
  //   除却 = 事業分→固定資産除却損 / 家事分→事業主貸（家事分は円未満切捨て・事業分＝残り。家事按分と同規約）。
  //   売却 = 全額→事業主貸（損益は譲渡所得＝スコープ外。除却損は計上しない）。
  const lossHousehold = isSale ? yen(0) : applyRate(yen(bookValue), 100 - asset.businessUseRatio, 100, 'floor')
  const lossBusiness = isSale ? yen(0) : yen(bookValue - lossHousehold)
  const ownerTransfer = isSale ? yen(bookValue) : yen(0)
  // 事業主貸への借方合計（売却＝未償却残高全額、除却＝家事分）。
  const ownerDrawDebit = isSale ? bookValue : lossHousehold

  const recordMethod = recordMethodOf(db)
  const lossId = lossBusiness > 0 ? ensureLossAccount(db) : 0
  const ownerDrawId = accountIdByName(db, OWNER_DRAW)
  const depExpenseId = postCurrent ? accountIdByName(db, DEP_EXPENSE) : 0
  const accumulatedId = recordMethod === 'indirect' ? accountIdByName(db, ACCUMULATED) : 0
  const now = new Date().toISOString()

  // 貸方（対象資産）: 間接法＝取得価額全額、直接法＝未償却残高（累計は資産科目で直接控除済み）。
  const creditAmount = recordMethod === 'indirect' ? asset.acquisitionCost : bookValue

  // 処分（除却損 or 売却振替）仕訳の明細。
  const lines: { side: 'debit' | 'credit'; accountId: number; amount: number }[] = []
  if (recordMethod === 'indirect' && accumulated > 0) {
    lines.push({ side: 'debit', accountId: accumulatedId, amount: accumulated })
  }
  if (lossBusiness > 0) lines.push({ side: 'debit', accountId: lossId, amount: lossBusiness })
  if (ownerDrawDebit > 0) lines.push({ side: 'debit', accountId: ownerDrawId, amount: ownerDrawDebit })
  if (creditAmount > 0) lines.push({ side: 'credit', accountId: asset.accountId, amount: creditAmount })

  if (lines.length === 0) {
    throw new Error(
      isSale
        ? '売却対象に未償却残高がありません（既に全額償却済み）。台帳振替は不要です。譲渡所得は別途手計算してください。'
        : '除却対象に未償却残高がありません（既に全額償却済みのため除却仕訳は不要です）。',
    )
  }
  assertBalanced(lines.map((l) => ({ side: l.side, amount: yen(l.amount) })))

  // 処分年度の月割償却仕訳の明細（postCurrent のときのみ）。
  const depLines: { side: 'debit' | 'credit'; accountId: number; amount: number }[] = []
  if (postCurrent) {
    if (currentDep!.businessAmount > 0) depLines.push({ side: 'debit', accountId: depExpenseId, amount: currentDep!.businessAmount })
    if (currentDep!.householdAmount > 0) depLines.push({ side: 'debit', accountId: ownerDrawId, amount: currentDep!.householdAmount })
    // 貸方: 間接法＝累計額、直接法＝対象資産。
    depLines.push({ side: 'credit', accountId: recordMethod === 'indirect' ? accumulatedId : asset.accountId, amount: currentDepAmount })
    assertBalanced(depLines.map((l) => ({ side: l.side, amount: yen(l.amount) })))
  }

  const source = isSale ? 'sale' : 'retirement'
  const note = noteFor({
    disposalType,
    postCurrent,
    monthsUsed,
    alreadyPostedThisYear,
    fullyDepreciated,
    method: asset.depreciationMethod,
    disposedAtYearEnd: disposedDate === fy.endDate,
  })

  return db.transaction((tx) => {
    // 1) 処分年度の月割償却（source='retirement'/'sale'）。洗い替え対象外。
    let depreciationEntryId: number | null = null
    if (postCurrent) {
      const depEntry = tx
        .insert(journalEntries)
        .values({ fiscalYearId, entryDate: disposedDate, description: `${isSale ? '減価償却（売却年度）' : '減価償却（除却年度）'} ${asset.name}`, source, sourceRef: String(asset.id), status: 'confirmed', createdAt: now, updatedAt: now })
        .returning()
        .all()[0]
      let dln = 1
      for (const l of depLines) {
        tx.insert(journalLines).values({ entryId: depEntry.id, lineNo: dln++, side: l.side, accountId: l.accountId, amount: l.amount }).run()
      }
      const openingThisYear = asset.acquisitionCost - priorAccumulated
      tx.insert(depreciationEntries)
        .values({ fixedAssetId: assetId, fiscalYearId, openingBookValue: openingThisYear, depreciationAmount: currentDepAmount, businessAmount: currentDep!.businessAmount, closingBookValue: openingThisYear - currentDepAmount, journalEntryId: depEntry.id })
        .run()
      depreciationEntryId = depEntry.id
    }

    // 2) 処分（除却損 or 売却振替）仕訳。
    const entry = tx
      .insert(journalEntries)
      .values({ fiscalYearId, entryDate: disposedDate, description: `${isSale ? '固定資産売却（譲渡）' : '固定資産除却'} ${asset.name}`, source, sourceRef: String(asset.id), status: 'confirmed', createdAt: now, updatedAt: now })
      .returning()
      .all()[0]
    let lineNo = 1
    for (const l of lines) {
      tx.insert(journalLines).values({ entryId: entry.id, lineNo: lineNo++, side: l.side, accountId: l.accountId, amount: l.amount }).run()
    }
    tx.update(fixedAssets).set({ status: newStatus, retiredDate: disposedDate, updatedAt: now }).where(eq(fixedAssets.id, assetId)).run()
    return {
      disposalType,
      entryId: entry.id,
      currentYearDepreciation: yen(currentDepAmount),
      depreciationEntryId,
      bookValue: yen(bookValue),
      lossBusiness,
      lossHousehold,
      ownerTransfer,
      accumulated: yen(accumulated),
      note,
    }
  })
}

/** 固定資産を除却し、除却損仕訳を起票する（confirmed・source='retirement'）。 */
export function retireFixedAsset(db: DataDb, fiscalYearId: number, assetId: number, retiredDate: string): RetireResult {
  return disposeFixedAsset(db, fiscalYearId, assetId, retiredDate, 'retirement')
}

/**
 * 固定資産を売却し、未償却残高を事業主貸へ振替える仕訳を起票する（confirmed・source='sale'）。
 * 売却損益（譲渡所得）の計算は本システム対象外（手計算）。台帳側＝簿価の事業主貸振替のみ自動化。
 */
export function sellFixedAsset(db: DataDb, fiscalYearId: number, assetId: number, soldDate: string): DisposeResult {
  return disposeFixedAsset(db, fiscalYearId, assetId, soldDate, 'sale')
}

/** 処分処理の注記を組み立てる（月割の計上有無・要確認事項・譲渡所得の手計算）。 */
function noteFor(args: {
  disposalType: DisposalType
  postCurrent: boolean
  monthsUsed: number
  alreadyPostedThisYear: boolean
  fullyDepreciated: boolean
  method: string
  disposedAtYearEnd: boolean
}): string | null {
  if (args.disposalType === 'sale') {
    // 売却は常に譲渡所得の手計算を促す。期中なら月割償却を計上した旨も付す。
    const prefix =
      args.postCurrent && args.monthsUsed < 12
        ? `期中売却: 当年度の月割償却（${args.monthsUsed}ヶ月）を計上のうえ、未償却残高を事業主貸へ振替えました。`
        : '売却: 未償却残高を事業主貸へ振替えました。'
    return `${prefix}譲渡所得（売却損益）は事業所得と別計算で本システム対象外のため、売却代金・取得費から別途手計算してください（legalRisk:high・税理士確認）。`
  }
  // ↓ 除却（retirement）の注記。
  if (args.postCurrent) {
    // 年度末除却（12ヶ月＝満額）は注記不要。期中は月割を計上した旨を明示。
    return args.monthsUsed < 12 ? `期中除却: 当年度の月割償却（${args.monthsUsed}ヶ月）を計上のうえ除却損を算定しました。` : null
  }
  // 一括償却資産（lump_sum）は disposeFixedAsset 冒頭で早期 return するためここには到達しない
  // （除却損を計上せず3年継続。spec §5）。
  if (args.method === 'minor_special') {
    return null // 少額特例は取得年に全額償却済（簿価0＝除却損なし）
  }
  if (args.fullyDepreciated) {
    return '当年度は償却対象がありません（既に備忘価額1円まで償却済み）。1円を除却損に計上しました。'
  }
  if (args.alreadyPostedThisYear) {
    // 当年度の償却が満額計上済み。期中除却では当年度償却が過大（除却損が過少）の可能性。
    return args.disposedAtYearEnd
      ? null
      : '当年度の償却が満額計上済みのため月割への補正は行っていません。期中除却では当年度の減価償却費が過大（除却損が過少）になる可能性があるため、税理士にご確認ください。'
  }
  if (!args.disposedAtYearEnd) {
    return '期中除却: 当年度の月割償却を計上できませんでした（耐用年数・償却率が未設定）。月割が必要な場合は税理士にご確認ください。'
  }
  return null
}
