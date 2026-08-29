import type { ManualEntryLineInput } from '@kanean/shared'
export type { ManualEntryLineInput }
import { eq } from 'drizzle-orm'
import { yen } from '@kanean/shared'
import { assertBalanced } from '@kanean/core'
import type { DataDb } from '../db/router.js'
import {
  accounts,
  counterparties,
  departments,
  fiscalYears,
  journalEntries,
  journalLines,
  subAccounts,
  taxCategories,
} from '../db/data/schema.js'
import { resolveLineTax, type ResolvedLineTax } from './lineTax.js'
import { assertInFiscalPeriod } from './fiscalPeriod.js'

/**
 * 手入力・複合仕訳の起票（accounting-spec §1 / roadmap Phase1 F-JNL-2）。
 * - 借方N:貸方M の複合仕訳に対応（journalize の2行固定とは別経路）。
 * - 貸借一致（Σ借方=Σ貸方）を core の isBalanced で検証してから永続化。
 * - 金額は円整数・正数のみ。会計期間ゲート（entry_date が当該年度の [start,end] 内）。
 * - source は既定 'manual'（呼出側が 'invoice' 等を渡せる）。status は既定 'confirmed'（手入力＝確定計上）だが 'draft' も可。
 *
 * 明細の検証＋税区分解決は validateAndResolveLines に切り出し、編集（F-JNL-5 updateEntry）と共有する。
 */

export interface CreateManualEntryInput {
  fiscalYearId: number
  entryDate: string
  description?: string | null
  memo?: string | null
  slipNo?: string | null
  status?: 'draft' | 'confirmed'
  /** 仕訳の出所。既定 'manual'。請求起票は 'invoice' 等（仕訳帳の SOURCE ラベルに対応）。 */
  source?: string
  lines: ManualEntryLineInput[]
}

function assertInteger(value: number, label: string): void {
  if (!Number.isSafeInteger(value)) throw new Error(`${label} は安全な整数で指定してください（got ${value}）`)
}

/**
 * 仕訳明細の検証（日付・期間ゲート・金額・科目/補助/取引先/部門/税区分の整合・貸借一致）と
 * 税区分/税額の解決をまとめて行う。起票（createManualEntry）と編集（updateEntry）で共有。
 * 検証 NG は throw、OK なら行ごとの解決済み税区分/税額を返す。
 */
export function validateAndResolveLines(
  db: DataDb,
  fy: { startDate: string; endDate: string },
  entryDate: string,
  lines: ManualEntryLineInput[],
): ResolvedLineTax[] {
  if (!entryDate || !/^\d{4}-\d{2}-\d{2}$/.test(entryDate)) {
    throw new Error('entryDate は YYYY-MM-DD 形式で指定してください')
  }
  // 実在日付チェック（正規表現は桁形だけ。2026-02-30 等の存在しない日を弾く）。
  const dt = new Date(`${entryDate}T00:00:00Z`)
  if (Number.isNaN(dt.getTime()) || dt.toISOString().slice(0, 10) !== entryDate) {
    throw new Error(`entryDate ${entryDate} は存在しない日付です`)
  }
  // 会計期間ゲート（判定は fiscalPeriod に一本化。仕訳化・取込と同じ式を使う）。
  assertInFiscalPeriod(fy, entryDate)

  const ls = lines ?? []
  if (ls.length < 2) throw new Error('仕訳は借方・貸方あわせて2明細以上が必要です')

  // 明細の妥当性（金額・科目・補助・取引先・部門・税区分の存在と整合）。
  for (const [i, l] of ls.entries()) {
    const at = `明細${i + 1}`
    if (l.side !== 'debit' && l.side !== 'credit') throw new Error(`${at}: side は debit/credit`)
    assertInteger(l.amount, `${at} の金額`)
    if (l.amount <= 0) throw new Error(`${at}: 金額は正の整数（0や負数は不可）`)

    const acc = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, l.accountId)).all()[0]
    if (!acc) throw new Error(`${at}: 勘定科目 ${l.accountId} が見つかりません`)

    if (l.subAccountId != null) {
      const sub = db.select().from(subAccounts).where(eq(subAccounts.id, l.subAccountId)).all()[0]
      if (!sub) throw new Error(`${at}: 補助科目 ${l.subAccountId} が見つかりません`)
      if (sub.accountId !== l.accountId) throw new Error(`${at}: 補助科目 ${l.subAccountId} は勘定科目 ${l.accountId} に属しません`)
    }
    if (l.counterpartyId != null) {
      const cp = db.select({ id: counterparties.id }).from(counterparties).where(eq(counterparties.id, l.counterpartyId)).all()[0]
      if (!cp) throw new Error(`${at}: 取引先 ${l.counterpartyId} が見つかりません`)
    }
    if (l.departmentId != null) {
      const dep = db.select({ id: departments.id }).from(departments).where(eq(departments.id, l.departmentId)).all()[0]
      if (!dep) throw new Error(`${at}: 部門 ${l.departmentId} が見つかりません`)
    }
    if (l.taxCategoryId != null) {
      const tc = db.select({ id: taxCategories.id }).from(taxCategories).where(eq(taxCategories.id, l.taxCategoryId)).all()[0]
      if (!tc) throw new Error(`${at}: 税区分 ${l.taxCategoryId} が見つかりません`)
    }
    if (l.taxAmount != null) {
      assertInteger(l.taxAmount, `${at} の税額`)
      if (l.taxAmount < 0) throw new Error(`${at}: 税額は0以上で指定してください`)
      if (l.taxAmount > l.amount) throw new Error(`${at}: 税額が金額を超えています`)
    }
  }

  // 貸借一致（core の assertBalanced で検証。不一致なら 借方X≠貸方Y を投げる）。
  assertBalanced(ls.map((l) => ({ side: l.side, amount: yen(l.amount) })))

  // 各行の税区分・税額を解決（明示 > 補助/科目の既定、税込なら内税逆算）。明示 taxAmount は尊重。
  return ls.map((l) =>
    resolveLineTax(db, { accountId: l.accountId, subAccountId: l.subAccountId ?? null, taxCategoryId: l.taxCategoryId ?? null, amount: l.amount }),
  )
}

/** 検証済み明細を journal_lines の insert 値へ整形する（起票・編集で共有）。 */
export function toLineValues(entryId: number, lines: ManualEntryLineInput[], resolved: ResolvedLineTax[]) {
  return lines.map((l, i) => ({
    entryId,
    lineNo: i + 1,
    side: l.side,
    accountId: l.accountId,
    subAccountId: l.subAccountId ?? null,
    departmentId: l.departmentId ?? null,
    counterpartyId: l.counterpartyId ?? null,
    taxCategoryId: resolved[i].taxCategoryId,
    // 非課税/対象外（resolved.taxAmount=null）の行に明示税額は付けない。
    taxAmount: resolved[i].taxAmount == null ? null : (l.taxAmount ?? resolved[i].taxAmount),
    amount: l.amount,
    description: l.description ?? null,
    prorationApplied: false,
  }))
}

/**
 * 期末起票が source 一致で当年度分を洗い替え（物理削除→再起票）する等、機械管理される source。
 * 手入力経路でこれらを受け付けると、起票した仕訳が次回の期末処理で黙って消える事故になる。
 */
const RESERVED_SOURCES = ['depreciation', 'proration', 'retirement', 'sale', 'rollover'] as const

/** 手入力・複合仕訳を起票し entry id を返す。 */
export function createManualEntry(db: DataDb, input: CreateManualEntryInput): number {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, input.fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${input.fiscalYearId} が見つかりません`)
  if (fy.status !== 'open') throw new Error(`会計年度 ${fy.id} は ${fy.status} のため起票できません`)

  // 型上は enum だが HTTP 境界は無検証キャストのため、実行時にも検証する（不正値が DB へ素通りしない）。
  const status = input.status ?? 'confirmed'
  if (status !== 'draft' && status !== 'confirmed') throw new Error(`status は draft / confirmed（got ${String(status)}）`)
  const source = input.source ?? 'manual'
  if ((RESERVED_SOURCES as readonly string[]).includes(source)) {
    throw new Error(`source "${source}" はシステム予約（期末処理が洗い替え）のため指定できません`)
  }

  const resolved = validateAndResolveLines(db, fy, input.entryDate, input.lines)

  const now = new Date().toISOString()
  // ヘッダ＋明細を1トランザクションで（途中失敗で片落ち確定仕訳を残さない）。
  return db.transaction((tx) => {
    const entry = tx
      .insert(journalEntries)
      .values({
        fiscalYearId: fy.id,
        entryDate: input.entryDate,
        slipNo: input.slipNo ?? null,
        description: input.description ?? null,
        memo: input.memo ?? null,
        source,
        status,
        createdAt: now,
        updatedAt: now,
      })
      .returning()
      .all()[0]

    tx.insert(journalLines)
      .values(toLineValues(entry.id, input.lines, resolved))
      .run()

    return entry.id
  })
}
