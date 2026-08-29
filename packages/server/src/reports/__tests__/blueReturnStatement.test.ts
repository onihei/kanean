import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { eq } from 'drizzle-orm'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries, journalLines, accounts } from '../../db/data/schema.js'
import { profitAndLoss } from '../reports.js'
import { buildBlueReturnStatement, type FormBox } from '../blueReturnStatement.js'

let tmp: string
const USER = 'u_blue_stmt'

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-bluestmt-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function accId(db: DataDb, name: string): number {
  return db.select().from(accounts).where(eq(accounts.name, name)).all()[0].id
}

interface LineSpec {
  account: string
  side: 'debit' | 'credit'
  amount: number
}

function setup() {
  const db = new DbRouter().bookDb(USER)
  seedDataPlane(db)
  db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  const fy = db.select().from(fiscalYears).all()[0]
  const addEntry = (desc: string, lines: LineSpec[]) => {
    const now = '2026-01-01T00:00:00Z'
    const entry = db
      .insert(journalEntries)
      .values({ fiscalYearId: fy.id, entryDate: '2026-06-01', description: desc, source: 'manual', status: 'confirmed', createdAt: now, updatedAt: now })
      .returning()
      .all()[0]
    lines.forEach((l, i) =>
      db.insert(journalLines).values({ entryId: entry.id, lineNo: i + 1, side: l.side, accountId: accId(db, l.account), amount: l.amount }).run(),
    )
  }
  return { db, fyId: fy.id, addEntry }
}

/** code でボックスを引く（expenses 配列含む）。 */
function box(boxes: FormBox[], code: string): FormBox | undefined {
  return boxes.find((b) => b.code === code)
}

describe('buildBlueReturnStatement（青色決算書 損益ページ様式組成）', () => {
  it('売上・売上原価・経費・専従者・繰入戻入を様式ボックスへ畳み込み、不変条件を満たす', () => {
    const { db, fyId, addEntry } = setup()
    // 売上①= 300万 − 値引10万 = 290万
    addEntry('売上', [{ account: '普通預金', side: 'debit', amount: 3_000_000 }, { account: '売上高', side: 'credit', amount: 3_000_000 }])
    addEntry('値引', [{ account: '売上値引・返品', side: 'debit', amount: 100_000 }, { account: '普通預金', side: 'credit', amount: 100_000 }])
    // 期首②20万（借)期首棚卸 / 貸)商品）、仕入③100万、期末⑤30万（借)商品 / 貸)期末棚卸）
    addEntry('期首棚卸', [{ account: '期首商品棚卸高', side: 'debit', amount: 200_000 }, { account: '商品', side: 'credit', amount: 200_000 }])
    addEntry('仕入', [{ account: '仕入高', side: 'debit', amount: 1_000_000 }, { account: '普通預金', side: 'credit', amount: 1_000_000 }])
    addEntry('期末棚卸', [{ account: '商品', side: 'debit', amount: 300_000 }, { account: '期末商品棚卸高', side: 'credit', amount: 300_000 }])
    // 標準経費: 水道光熱費⑩11万 / 減価償却費⑱5万
    addEntry('電気', [{ account: '水道光熱費', side: 'debit', amount: 110_000 }, { account: '普通預金', side: 'credit', amount: 110_000 }])
    addEntry('償却', [{ account: '減価償却費', side: 'debit', amount: 50_000 }, { account: '減価償却累計額', side: 'credit', amount: 50_000 }])
    // 空欄行: 車両費8万 / リース料3万
    addEntry('車両', [{ account: '車両費', side: 'debit', amount: 80_000 }, { account: '普通預金', side: 'credit', amount: 80_000 }])
    addEntry('リース', [{ account: 'リース料', side: 'debit', amount: 30_000 }, { account: '普通預金', side: 'credit', amount: 30_000 }])
    // 雑費㉜2万
    addEntry('雑費', [{ account: '雑費', side: 'debit', amount: 20_000 }, { account: '普通預金', side: 'credit', amount: 20_000 }])
    // 専従者50万 / 繰入5万 / 戻入3万
    addEntry('専従者', [{ account: '専従者給与', side: 'debit', amount: 500_000 }, { account: '普通預金', side: 'credit', amount: 500_000 }])
    addEntry('繰入', [{ account: '貸倒引当金繰入', side: 'debit', amount: 50_000 }, { account: '貸倒引当金', side: 'credit', amount: 50_000 }])
    addEntry('戻入', [{ account: '貸倒引当金', side: 'debit', amount: 30_000 }, { account: '貸倒引当金戻入', side: 'credit', amount: 30_000 }])

    const { pl } = buildBlueReturnStatement(db, fyId)

    // 売上・原価
    expect(pl.sales.amount).toBe(2_900_000) // ① 300万−値引10万
    expect(pl.openStock.amount).toBe(200_000) // ②
    expect(pl.purchase.amount).toBe(1_000_000) // ③
    expect(pl.subtotalCost.amount).toBe(1_200_000) // ④=②+③
    expect(pl.closeStock.amount).toBe(300_000) // ⑤（符号反転で正値）
    expect(pl.costOfSales.amount).toBe(900_000) // ⑥=④−⑤
    expect(pl.grossProfit.amount).toBe(2_000_000) // ⑦=①−⑥

    // 標準経費
    expect(box(pl.expenses, 'AOIRO.PL.EXP_UTIL')!.amount).toBe(110_000) // ⑩
    expect(box(pl.expenses, 'AOIRO.PL.EXP_DEP')!.amount).toBe(50_000) // ⑱
    expect(box(pl.expenses, 'AOIRO.PL.EXP_TAX')!.amount).toBe(0) // 未使用の標準行は0で存在

    // 空欄行（㉕㉖）= 車両費・リース料（sortOrder順）
    const blanks = pl.expenses.filter((b) => b.code.startsWith('AOIRO.PL.EXP_BLANK_'))
    expect(blanks.map((b) => b.label)).toEqual(['車両費', 'リース料'])
    expect(blanks.reduce((s, b) => s + b.amount, 0)).toBe(110_000)

    // 雑費㉜
    expect(box(pl.expenses, 'AOIRO.PL.EXP_MISC')!.amount).toBe(20_000)

    // 経費計㉝ = 標準16万 + 空欄11万 + 雑費2万 = 29万（専従者・繰入は含めない）
    expect(pl.expenseTotal.amount).toBe(290_000)
    expect(pl.netBeforeAdjust.amount).toBe(1_710_000) // ㉞=⑦−㉝
    expect(pl.reserveBack.amount).toBe(30_000)
    expect(pl.reserveIn.amount).toBe(50_000)
    expect(pl.senju.amount).toBe(500_000)

    // ㊸控除前所得 = ㉞ + 戻入 − 繰入 − 専従者 = 171+3−5−50 = 119万
    expect(pl.incomeBeforeDeduction.amount).toBe(1_190_000)
    expect(pl.blueDeduction.amount).toBe(550_000) // 既定55万
    expect(pl.income.amount).toBe(640_000) // ㊺

    // 不変条件
    const net = profitAndLoss(db, fyId).netIncome
    expect(pl.incomeBeforeDeduction.amount).toBe(net) // (a)
    expect(pl.netBeforeAdjust.amount + pl.reserveBack.amount - pl.reserveIn.amount - pl.senju.amount).toBe(pl.incomeBeforeDeduction.amount) // (b)
  })

  it('(c) Σexpenses(㉝) + 専従者 + 繰入 == 経費 section 合計（line_code 漏れ検知）', () => {
    const { db, fyId, addEntry } = setup()
    addEntry('売上', [{ account: '普通預金', side: 'debit', amount: 1_000_000 }, { account: '売上高', side: 'credit', amount: 1_000_000 }])
    addEntry('家賃', [{ account: '地代家賃', side: 'debit', amount: 120_000 }, { account: '普通預金', side: 'credit', amount: 120_000 }])
    addEntry('会議費', [{ account: '会議費', side: 'debit', amount: 30_000 }, { account: '普通預金', side: 'credit', amount: 30_000 }])
    addEntry('専従者', [{ account: '専従者給与', side: 'debit', amount: 400_000 }, { account: '普通預金', side: 'credit', amount: 400_000 }])

    const { pl } = buildBlueReturnStatement(db, fyId)
    const expenseSection = profitAndLoss(db, fyId).expenses.total
    const sumStmt = pl.expenseTotal.amount + pl.senju.amount + pl.reserveIn.amount
    expect(sumStmt).toBe(expenseSection)
  })

  it('空欄行が7行を超えると8件目以降は雑費㉜へ overflow する', () => {
    const { db, fyId, addEntry } = setup()
    addEntry('売上', [{ account: '普通預金', side: 'debit', amount: 5_000_000 }, { account: '売上高', side: 'credit', amount: 5_000_000 }])
    // 空欄候補8件（固定資産除却損・車両費・リース料・支払手数料・研修採用費・新聞図書費・会議費・繰延資産償却）
    const blankAccts = ['固定資産除却損', '車両費', 'リース料', '支払手数料', '研修採用費', '新聞図書費', '会議費', '繰延資産償却']
    blankAccts.forEach((a, i) => addEntry(a, [{ account: a, side: 'debit', amount: (i + 1) * 10_000 }, { account: '普通預金', side: 'credit', amount: (i + 1) * 10_000 }]))

    const { pl } = buildBlueReturnStatement(db, fyId)
    const blanks = pl.expenses.filter((b) => b.code.startsWith('AOIRO.PL.EXP_BLANK_'))
    expect(blanks).toHaveLength(7) // ㉕〜㉛
    // 8件目（sortOrder最後＝繰延資産償却 80,000）は雑費へ overflow（雑費勘定自体は未使用なので雑費=80,000）
    expect(box(pl.expenses, 'AOIRO.PL.EXP_MISC')!.amount).toBe(80_000)
    // 経費計 = 全空欄候補の合計（10k+20k+…+80k = 360k）
    const total = blankAccts.reduce((s, _a, i) => s + (i + 1) * 10_000, 0)
    expect(pl.expenseTotal.amount).toBe(total)
  })

  it('戻入のみ（繰入・専従者なし）でも ㊸ == netIncome（戻入が所得に加算される）', () => {
    const { db, fyId, addEntry } = setup()
    addEntry('売上', [{ account: '普通預金', side: 'debit', amount: 2_000_000 }, { account: '売上高', side: 'credit', amount: 2_000_000 }])
    addEntry('戻入', [{ account: '貸倒引当金', side: 'debit', amount: 80_000 }, { account: '貸倒引当金戻入', side: 'credit', amount: 80_000 }])
    const { pl } = buildBlueReturnStatement(db, fyId)
    const net = profitAndLoss(db, fyId).netIncome
    expect(pl.reserveBack.amount).toBe(80_000)
    expect(pl.incomeBeforeDeduction.amount).toBe(net)
    expect(net).toBe(2_080_000) // 売上200万 + 戻入8万
  })
})
