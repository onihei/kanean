import type { RecordMethod, DepreciationPostingResult } from '@kanean/shared'
export type { RecordMethod, DepreciationPostingResult }
import { and, eq, inArray, isNull, notInArray, or } from 'drizzle-orm'
import { yen } from '@kanean/shared'
import type { DataDb, DataTx } from '../db/router.js'
import { requireAccountIdByName as accountIdByName } from '../db/lookups.js'
import {
  businessSettings,
  depreciationEntries,
  fiscalYears,
  fixedAssets,
  journalEntries,
  journalLines,
} from '../db/data/schema.js'
import { buildSchedule, type AssetYearView } from './register.js'

/**
 * 減価償却の仕訳起票（accounting-spec §8）。
 * 期末（年度終了日）に資産ごとの償却仕訳を生成し depreciation_entries へ永続化する。
 *   借) 減価償却費   = 必要経費算入額（business_amount）
 *   借) 事業主貸     = 家事分（household_amount、按分ありのとき）
 *   貸) 減価償却累計額（間接法）/ 対象資産（直接法） = 本年分償却費（全額）
 * source='depreciation' で、再実行時は当年度分を洗い替え（§6/§7 と同方針）。confirmed で起票。
 */

const yearOf = (iso: string): number => Number(iso.slice(0, 4))

function recordMethodOf(db: DataDb): RecordMethod {
  const s = db.select({ m: businessSettings.depreciationRecordMethod }).from(businessSettings).all()[0]
  return s?.m === 'direct' ? 'direct' : 'indirect'
}

/**
 * 当年度の「期末一括起票（source='depreciation'）」分を洗い替える。
 * depreciation_entries は、除却処理が起票した月割償却（source='retirement' に紐づく行）を
 * **残しつつ**、それ以外（期末一括起票分・仕訳手動削除で journalEntryId=null になった孤立行）を
 * 当年度分まとめて削除する。journalEntryId IN (...) だけだと deleteEntry が残す孤立行
 * （entries.ts: FK 解除で null 化）を消せず、再起票で二重計上になるため当年度横断で消す。
 */
function clearExisting(db: DataDb | DataTx, fiscalYearId: number): void {
  const existing = db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.fiscalYearId, fiscalYearId), eq(journalEntries.source, 'depreciation')))
    .all()
    .map((e) => e.id)

  // 処分処理（除却 source='retirement' / 売却 source='sale'）が起票した月割償却に紐づく
  // depreciation_entries は保護する。
  const disposalEntryIds = db
    .select({ id: journalEntries.id })
    .from(journalEntries)
    .where(and(eq(journalEntries.fiscalYearId, fiscalYearId), inArray(journalEntries.source, ['retirement', 'sale'])))
    .all()
    .map((e) => e.id)
  // 保護対象を除いた当年度の depreciation_entries（孤立行 journalEntryId=null を含む）を削除。
  db.delete(depreciationEntries)
    .where(
      disposalEntryIds.length > 0
        ? and(
            eq(depreciationEntries.fiscalYearId, fiscalYearId),
            or(isNull(depreciationEntries.journalEntryId), notInArray(depreciationEntries.journalEntryId, disposalEntryIds)),
          )
        : eq(depreciationEntries.fiscalYearId, fiscalYearId),
    )
    .run()

  if (existing.length > 0) {
    db.delete(journalLines).where(inArray(journalLines.entryId, existing)).run()
    db.delete(journalEntries).where(inArray(journalEntries.id, existing)).run()
  }
}

/** open でなくとも明示した年度に対して起票する。 */
export function postDepreciation(db: DataDb, fiscalYearId: number): DepreciationPostingResult {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fiscalYearId} が見つかりません`)
  const targetYear = yearOf(fy.startDate)
  const recordMethod = recordMethodOf(db)

  const depExpenseId = accountIdByName(db, '減価償却費')
  const ownerDrawId = accountIdByName(db, '事業主貸')
  const accumulatedId = recordMethod === 'indirect' ? accountIdByName(db, '減価償却累計額') : 0

  const now = new Date().toISOString()
  const skipped: DepreciationPostingResult['skipped'] = []
  let posted = 0
  let totalDepreciation = 0
  let totalBusinessAmount = 0

  // 少額減価償却資産特例（措法28の2）の年間300万円上限（資産横断・取得価額ベース）。
  const MINOR_SPECIAL_CAP = 3_000_000
  let minorSpecialTotal = 0

  // 少額特例の300万上限は枠を埋める順序で結果が変わるため、一覧表示（listFixedAssets）と
  // 同じ管理No→id順に固定する（DB返却順依存を排除し、利用者の見える順と一致させる）。
  // 通常は status='active' のみだが、一括償却資産（lump_sum）は除却・売却後も3年均等償却を継続する
  // （spec §5・所令§139）ため、処分済み（status='retired'/'sold'）の lump_sum も対象に含める。
  // 3年枠を超えた年は buildSchedule が該当年を返さず（cur 不在で skip）自然に止まる。
  const assets = db
    .select()
    .from(fixedAssets)
    .where(or(eq(fixedAssets.status, 'active'), and(eq(fixedAssets.depreciationMethod, 'lump_sum'), inArray(fixedAssets.status, ['retired', 'sold']))))
    .all()
    .sort((a, b) => (a.managementNo ?? '').localeCompare(b.managementNo ?? '') || a.id - b.id)

  // 洗い替え（削除→再起票）は全体を原子化する。途中失敗で「既存削除済み・新規は一部だけ」の
  // 部分状態を残さない（rollover/retirement と同方針）。
  db.transaction((tx) => {
    clearExisting(tx, fiscalYearId)

    for (const asset of assets) {
      const { supported, years } = buildSchedule(asset)
      if (!supported) continue
      const cur: AssetYearView | undefined = years.find((y) => y.year === targetYear)
      if (!cur || cur.depreciationAmount <= 0) continue

      // 少額特例は取得年に全額即時計上。年間合計300万円を超える分は通常償却が必要なので起票せずスキップ。
      if (asset.depreciationMethod === 'minor_special') {
        if (minorSpecialTotal + asset.acquisitionCost > MINOR_SPECIAL_CAP) {
          skipped.push({ assetId: asset.id, name: asset.name, reason: '少額特例の年間300万円上限を超過（通常償却への変更が必要）' })
          continue
        }
        minorSpecialTotal += asset.acquisitionCost
      }

      // 貸方科目（間接法＝累計額 / 直接法＝対象資産）。
      const creditAccountId = recordMethod === 'indirect' ? accumulatedId : asset.accountId
      if (!creditAccountId) {
        skipped.push({ assetId: asset.id, name: asset.name, reason: '直接法だが対象資産の勘定科目が未設定' })
        continue
      }

      const entry = tx
        .insert(journalEntries)
        .values({
          fiscalYearId,
          entryDate: fy.endDate,
          description: `減価償却 ${asset.name}`,
          source: 'depreciation',
          sourceRef: String(asset.id),
          status: 'confirmed',
          createdAt: now,
          updatedAt: now,
        })
        .returning()
        .all()[0]

      let lineNo = 1
      if (cur.businessAmount > 0) {
        tx.insert(journalLines).values({ entryId: entry.id, lineNo: lineNo++, side: 'debit', accountId: depExpenseId, amount: cur.businessAmount }).run()
      }
      if (cur.householdAmount > 0) {
        tx.insert(journalLines).values({ entryId: entry.id, lineNo: lineNo++, side: 'debit', accountId: ownerDrawId, amount: cur.householdAmount }).run()
      }
      tx.insert(journalLines).values({ entryId: entry.id, lineNo, side: 'credit', accountId: creditAccountId, amount: cur.depreciationAmount }).run()

      tx.insert(depreciationEntries)
        .values({
          fixedAssetId: asset.id,
          fiscalYearId,
          openingBookValue: cur.openingBookValue,
          depreciationAmount: cur.depreciationAmount,
          businessAmount: cur.businessAmount,
          closingBookValue: cur.closingBookValue,
          journalEntryId: entry.id,
        })
        .run()

      posted++
      totalDepreciation += cur.depreciationAmount
      totalBusinessAmount += cur.businessAmount
    }
  })

  return {
    recordMethod,
    posted,
    skipped,
    totalDepreciation: yen(totalDepreciation),
    totalBusinessAmount: yen(totalBusinessAmount),
  }
}
