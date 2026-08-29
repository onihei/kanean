import type { FormBox, BlueReturnStatementPl } from '@kanean/shared'
export type { FormBox, BlueReturnStatementPl }
import { yen } from '@kanean/shared'
import type { DataDb } from '../db/router.js'
import { accountAggregates, plSignedBalance } from './reports.js'
import { buildBlueReturnSummary } from '../taxreturn/blueReturn.js'

/**
 * 青色申告決算書（損益ページ）の様式ボックス組成（form-mapping §1.1 / §5.1）。
 *
 * 「勘定科目 → 決算書科目(statement_items.statement_line_code) → 様式の欄」の3段集計の最終段。
 * accountAggregates() の line_code 付き残高を AOIRO.PL.* のボックスへ畳み込む（read のみ）。
 * 所得金額の確定（㊸㊹㊺）は buildBlueReturnSummary を再利用し、算出の二重化を避ける。
 *
 * 不変条件（テストで担保）:
 *   (a) incomeBeforeDeduction㊸ == profitAndLoss().netIncome
 *   (b) netBeforeAdjust㉞ + reserveBack − reserveIn − senju == incomeBeforeDeduction㊸
 *   (c) Σ expenses（㉝に含む分）+ senju + reserveIn == 経費 section 合計（line_code 漏れ検知）
 *
 * ⚠️ box（丸数字）は青色決算書(一般用)の慣用番号。官製様式の最終突合は令和6年分で要確認（form-mapping §0注記）。
 */

export interface BlueReturnStatement {
  pl: BlueReturnStatementPl
}

/** 標準経費行（⑧〜㉔・順序固定）。雑費㉜は空欄行の後に置くため別扱い。 */
const STD_EXPENSE_LINES: { code: string; label: string; box: string }[] = [
  { code: 'AOIRO.PL.EXP_TAX', label: '租税公課', box: '⑧' },
  { code: 'AOIRO.PL.EXP_PACK', label: '荷造運賃', box: '⑨' },
  { code: 'AOIRO.PL.EXP_UTIL', label: '水道光熱費', box: '⑩' },
  { code: 'AOIRO.PL.EXP_TRAVEL', label: '旅費交通費', box: '⑪' },
  { code: 'AOIRO.PL.EXP_COMM', label: '通信費', box: '⑫' },
  { code: 'AOIRO.PL.EXP_AD', label: '広告宣伝費', box: '⑬' },
  { code: 'AOIRO.PL.EXP_ENT', label: '接待交際費', box: '⑭' },
  { code: 'AOIRO.PL.EXP_INS', label: '損害保険料', box: '⑮' },
  { code: 'AOIRO.PL.EXP_REPAIR', label: '修繕費', box: '⑯' },
  { code: 'AOIRO.PL.EXP_SUPPLY', label: '消耗品費', box: '⑰' },
  { code: 'AOIRO.PL.EXP_DEP', label: '減価償却費', box: '⑱' },
  { code: 'AOIRO.PL.EXP_WELFARE', label: '福利厚生費', box: '⑲' },
  { code: 'AOIRO.PL.EXP_SALARY', label: '給料賃金', box: '⑳' },
  { code: 'AOIRO.PL.EXP_OUTSRC', label: '外注工賃', box: '㉑' },
  { code: 'AOIRO.PL.EXP_INTEREST', label: '利子割引料', box: '㉒' },
  { code: 'AOIRO.PL.EXP_RENT', label: '地代家賃', box: '㉓' },
  { code: 'AOIRO.PL.EXP_BADDEBT', label: '貸倒金', box: '㉔' },
]

/** 空欄行の慣用番号 ㉕〜㉛（最大7行）。8件目以降は雑費㉜へ overflow。 */
const BLANK_BOXES = ['㉕', '㉖', '㉗', '㉘', '㉙', '㉚', '㉛']

export function buildBlueReturnStatement(db: DataDb, fiscalYearId: number): BlueReturnStatement {
  const pl = accountAggregates(db, fiscalYearId).filter((r) => r.reportType === 'PL')

  // line_code ごとの残高合計。控除科目（売上値引・仕入値引）の符号反転は reports.plSignedBalance に集約
  // （plSection と符号規約を共有しドリフトを防ぐ）。
  const sumByCode = new Map<string, number>()
  for (const r of pl) {
    if (!r.lineCode) continue
    sumByCode.set(r.lineCode, (sumByCode.get(r.lineCode) ?? 0) + plSignedBalance(r))
  }
  const amt = (code: string): number => sumByCode.get(code) ?? 0
  const mk = (code: string, label: string, box: string | null, amount: number): FormBox => ({ code, label, box, amount: yen(amount) })

  // 売上・売上原価。期末棚卸高は debit-normal を貸方計上（balance 負）なので符号反転して正値表示。
  const sales = mk('AOIRO.PL.SALES', '売上（収入）金額', '①', amt('AOIRO.PL.SALES'))
  const openStock = mk('AOIRO.PL.OPEN_STOCK', '期首商品（製品）棚卸高', '②', amt('AOIRO.PL.OPEN_STOCK'))
  const purchase = mk('AOIRO.PL.PURCHASE', '仕入金額', '③', amt('AOIRO.PL.PURCHASE'))
  const subtotalCost = mk('AOIRO.PL.SUBTOTAL_COST', '小計', '④', openStock.amount + purchase.amount)
  const closeStock = mk('AOIRO.PL.CLOSE_STOCK', '期末商品（製品）棚卸高', '⑤', -amt('AOIRO.PL.CLOSE_STOCK'))
  const costOfSales = mk('AOIRO.PL.COST', '差引原価', '⑥', subtotalCost.amount - closeStock.amount)
  const grossProfit = mk('AOIRO.PL.GROSS', '差引金額（売上総利益）', '⑦', sales.amount - costOfSales.amount)

  // 標準経費 ⑧〜㉔。
  const expenses: FormBox[] = STD_EXPENSE_LINES.map((l) => mk(l.code, l.label, l.box, amt(l.code)))

  // 空欄行（㉕〜㉛）= 経費 section かつ line_code=NULL の決算書科目を sortOrder 順に。8件目以降は雑費へ。
  const blankByItem = new Map<string, { sum: number; sortOrder: number }>()
  for (const r of pl) {
    if (r.section !== '経費' || r.lineCode) continue
    const e = blankByItem.get(r.itemName)
    if (e) {
      e.sum += plSignedBalance(r)
      e.sortOrder = Math.min(e.sortOrder, r.sortOrder)
    } else {
      blankByItem.set(r.itemName, { sum: plSignedBalance(r), sortOrder: r.sortOrder })
    }
  }
  const blanks = [...blankByItem.entries()].sort((a, b) => a[1].sortOrder - b[1].sortOrder || a[0].localeCompare(b[0]))
  let miscOverflow = 0
  blanks.forEach(([itemName, e], i) => {
    if (i < BLANK_BOXES.length) {
      expenses.push(mk(`AOIRO.PL.EXP_BLANK_${i + 1}`, itemName, BLANK_BOXES[i], e.sum))
    } else {
      miscOverflow += e.sum // 7行を超えた分は雑費㉜へ合算
    }
  })

  // 雑費㉜（空欄行 overflow を含む）。
  expenses.push(mk('AOIRO.PL.EXP_MISC', '雑費', '㉜', amt('AOIRO.PL.EXP_MISC') + miscOverflow))

  const expenseTotal = mk('AOIRO.PL.EXP_TOTAL', '経費計', '㉝', expenses.reduce((s, b) => s + b.amount, 0))
  const netBeforeAdjust = mk('AOIRO.PL.NET_BEFORE_ADJ', '差引金額', '㉞', grossProfit.amount - expenseTotal.amount)

  // 繰戻額（その他 section）・繰入額・専従者給与。
  const reserveBack = mk('AOIRO.PL.RESERVE_BACK', '貸倒引当金等 繰戻額', null, amt('AOIRO.PL.RESERVE_BACK'))
  const reserveIn = mk('AOIRO.PL.RESERVE_IN', '貸倒引当金等 繰入額', null, amt('AOIRO.PL.RESERVE_IN'))
  const senju = mk('AOIRO.PL.SENJU', '専従者給与', null, amt('AOIRO.PL.SENJU'))

  // ㊸㊹㊺は所得確定ロジック（core blueSpecialDeduction）を単一の正として再利用。
  const summary = buildBlueReturnSummary(db, fiscalYearId)
  const incomeBeforeDeduction = mk('AOIRO.PL.INCOME_BEFORE', '青色申告特別控除前の所得金額', '㊸', summary.incomeBeforeDeduction)
  const blueDeduction = mk('AOIRO.PL.BLUE_DEDUCT', '青色申告特別控除額', '㊹', summary.deduction)
  const income = mk('AOIRO.PL.INCOME', '所得金額', '㊺', summary.income)

  return {
    pl: {
      sales,
      openStock,
      purchase,
      subtotalCost,
      closeStock,
      costOfSales,
      grossProfit,
      expenses,
      expenseTotal,
      netBeforeAdjust,
      reserveBack,
      reserveIn,
      senju,
      incomeBeforeDeduction,
      blueDeduction,
      income,
    },
  }
}
