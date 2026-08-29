import type { BsFormRow, BlueBalanceSheet } from '@kanean/shared'
export type { BsFormRow, BlueBalanceSheet }
import { eq } from 'drizzle-orm'
import { yen } from '@kanean/shared'
import type { DataDb } from '../db/router.js'
import { openingBalances } from '../db/data/schema.js'
import { accountAggregates, profitAndLoss } from './reports.js'

/**
 * 貸借対照表（青色決算書4ページ目）の様式行マッピング。各勘定を様式の固定行へ寄せ、
 * 期首（opening_balances）と期末（accountAggregates の残高）を両方持つ。固定行に無い勘定は
 * 各部の空欄行へ順に割当て（科目名も持たせる）。評価勘定（減価償却累計額・貸倒引当金）は
 * normal_balance に従って符号反転し、資産/負債合計が貸借一致するようにする。
 *
 * 不変条件: assetTotal.closing == liabTotal.closing（balanceSheet().balanced と一致）。
 */

const ASSET_SECTIONS = ['流動資産', '固定資産', '繰延資産']
const LIABILITY_SECTIONS = ['流動負債', '固定負債']

// 様式の固定行（行番号は4ページ目データ行 1..24。罫線抽出＋較正で確定）。
const ASSET_FIXED_ROW: Record<string, number> = {
  現金: 1, 当座預金: 2, 定期預金: 3,
  その他の預金: 4, 普通預金: 4,
  受取手形: 5, 売掛金: 6, 有価証券: 7,
  棚卸資産: 8, 商品: 8, 製品: 8, 材料: 8, 仕掛品: 8, 貯蔵品: 8,
  前払金: 9, 貸付金: 10, 建物: 11,
  建物附属設備: 12, 附属設備: 12,
  機械装置: 13, 車両運搬具: 14, 工具器具備品: 15, 土地: 16,
}
const ASSET_BLANK_ROWS = [17, 18, 19, 20, 21, 22, 23]
const OWNER_DRAW_ROW = 24 // 事業主貸（資産側）

const LIAB_FIXED_ROW: Record<string, number> = {
  支払手形: 1, 買掛金: 2, 借入金: 3, 未払金: 4, 前受金: 5, 預り金: 6,
  貸倒引当金: 14,
}
const LIAB_BLANK_ROWS = [7, 8, 9, 10, 11, 12, 13, 15, 16, 17, 18, 19, 20, 21]
const OWNER_LOAN_ROW = 22 // 事業主借
const CAPITAL_ROW = 23 // 元入金
const INCOME_ROW = 24 // 青色申告特別控除前の所得金額

export function buildBlueBalanceSheet(db: DataDb, fiscalYearId: number): BlueBalanceSheet {
  const closing = accountAggregates(db, fiscalYearId)
  const netIncome = profitAndLoss(db, fiscalYearId).netIncome

  // 期首残高（normal 方向）を accountId ごとに集計。
  const ob = new Map<number, { d: number; c: number }>()
  for (const r of db.select().from(openingBalances).where(eq(openingBalances.fiscalYearId, fiscalYearId)).all()) {
    const a = ob.get(r.accountId) ?? { d: 0, c: 0 }
    if (r.side === 'debit') a.d += r.amount
    else a.c += r.amount
    ob.set(r.accountId, a)
  }
  const openingOf = (accountId: number, normal: string): number => {
    const a = ob.get(accountId)
    if (!a) return 0
    return normal === 'debit' ? a.d - a.c : a.c - a.d
  }

  const assetRows = new Map<number, BsFormRow>()
  const liabRows = new Map<number, BsFormRow>()
  const assetBlanks = [...ASSET_BLANK_ROWS]
  const liabBlanks = [...LIAB_BLANK_ROWS]

  const put = (map: Map<number, BsFormRow>, row: number, label: string | undefined, opening: number, closing: number) => {
    const cur = map.get(row)
    if (cur) {
      cur.opening = yen(cur.opening + opening)
      cur.closing = yen(cur.closing + closing)
    } else {
      map.set(row, { row, label, opening: yen(opening), closing: yen(closing) })
    }
  }

  for (const r of closing) {
    if (r.reportType !== 'BS') continue
    const opening = openingOf(r.accountId, r.normalBalance)
    const closingBal = r.balance
    if (opening === 0 && closingBal === 0) continue

    if (ASSET_SECTIONS.includes(r.section)) {
      // 資産方向 = debit 正（控除性 credit 勘定は負で計上＝間接法控除）。
      const aOpen = r.normalBalance === 'debit' ? opening : -opening
      const aClose = r.normalBalance === 'debit' ? closingBal : -closingBal
      const fixed = ASSET_FIXED_ROW[r.accountName]
      if (fixed) put(assetRows, fixed, undefined, aOpen, aClose)
      else {
        const blank = assetBlanks.shift() ?? ASSET_BLANK_ROWS[ASSET_BLANK_ROWS.length - 1]
        put(assetRows, blank, r.accountName, aOpen, aClose)
      }
    } else if (LIABILITY_SECTIONS.includes(r.section)) {
      const lOpen = r.normalBalance === 'credit' ? opening : -opening
      const lClose = r.normalBalance === 'credit' ? closingBal : -closingBal
      const fixed = LIAB_FIXED_ROW[r.accountName]
      if (fixed) put(liabRows, fixed, undefined, lOpen, lClose)
      else {
        const blank = liabBlanks.shift() ?? LIAB_BLANK_ROWS[LIAB_BLANK_ROWS.length - 1]
        put(liabRows, blank, r.accountName, lOpen, lClose)
      }
    } else {
      // 資本の部: 事業主貸＝資産側 / 事業主借・元入金＝負債資本側 / その他は符号で振分け。
      if (r.accountName === '事業主貸') put(assetRows, OWNER_DRAW_ROW, undefined, opening, closingBal)
      else if (r.accountName === '事業主借') put(liabRows, OWNER_LOAN_ROW, undefined, opening, closingBal)
      else if (r.accountName === '元入金') put(liabRows, CAPITAL_ROW, undefined, opening, closingBal)
      else if (r.normalBalance === 'debit') {
        const blank = assetBlanks.shift() ?? ASSET_BLANK_ROWS[ASSET_BLANK_ROWS.length - 1]
        put(assetRows, blank, r.accountName, opening, closingBal)
      } else {
        const blank = liabBlanks.shift() ?? LIAB_BLANK_ROWS[LIAB_BLANK_ROWS.length - 1]
        put(liabRows, blank, r.accountName, opening, closingBal)
      }
    }
  }

  // 青色申告特別控除前の所得金額（期末のみ）。
  put(liabRows, INCOME_ROW, undefined, 0, netIncome)

  const assets = [...assetRows.values()].sort((a, b) => a.row - b.row)
  const liabilities = [...liabRows.values()].sort((a, b) => a.row - b.row)
  const assetTotal = {
    opening: yen(assets.reduce((s, r) => s + r.opening, 0)),
    closing: yen(assets.reduce((s, r) => s + r.closing, 0)),
  }
  const liabTotal = {
    opening: yen(liabilities.reduce((s, r) => s + r.opening, 0)),
    closing: yen(liabilities.reduce((s, r) => s + r.closing, 0)),
  }
  return {
    assets,
    liabilities,
    incomeBeforeDeduction: netIncome,
    assetTotal,
    liabTotal,
    balanced: assetTotal.closing === liabTotal.closing,
  }
}
