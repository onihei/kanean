import type { CapitalTransferPreview } from '@kanean/shared'
export type { CapitalTransferPreview }
import { eq } from 'drizzle-orm'
import { type Yen, yen } from '@kanean/shared'
import { ownerCapitalRollforward } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import { fiscalYears } from '../db/data/schema.js'
import { accountAggregates, profitAndLoss } from '../reports/reports.js'

/**
 * 期末元入金振替のプレビュー（accounting-spec §1.3）。
 *   翌期首元入金 = 前期末元入金 + 当期所得 + 事業主借 − 事業主貸
 *
 * これは **計算のみ**（read-only）で仕訳起票・残高書込みは行わない。年度繰越（closing/rollover.ts）が
 * この計算結果を翌期 opening_balances の元入金として実反映する。
 *
 * 「前期末元入金」は元入金の**期末残高**（accountAggregates の元入金 balance）。事業主貸/事業主借も
 * 期末残高。当期所得は profitAndLoss().netIncome（控除前所得 ㊸）。
 *
 * legalRisk:high — 税理士サインオフを経るまで確定値として扱わない。
 */

const MOTOIRE = '元入金'
const OWNER_DRAW = '事業主貸'
const OWNER_LOAN = '事業主借'

export function previewCapitalTransfer(db: DataDb, fiscalYearId: number): CapitalTransferPreview {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${fiscalYearId} が見つかりません`)

  // 期末残高（period 未指定＝開始残高＋当期 confirmed の累計）を科目名で引く。
  const rows = accountAggregates(db, fiscalYearId)
  const balanceByName = (name: string): Yen => rows.find((r) => r.accountName === name)?.balance ?? yen(0)

  const priorMotoire = balanceByName(MOTOIRE)
  const ownerLoan = balanceByName(OWNER_LOAN)
  const ownerDraw = balanceByName(OWNER_DRAW)
  const incomeBeforeDeduction = profitAndLoss(db, fiscalYearId).netIncome

  const r = ownerCapitalRollforward({ priorMotoire, incomeBeforeDeduction, ownerLoan, ownerDraw })

  return {
    fiscalYearId,
    priorMotoire: r.priorMotoire,
    incomeBeforeDeduction: r.incomeBeforeDeduction,
    ownerLoan: r.ownerLoan,
    ownerDraw: r.ownerDraw,
    netChange: r.netChange,
    nextMotoire: r.nextMotoire,
  }
}
