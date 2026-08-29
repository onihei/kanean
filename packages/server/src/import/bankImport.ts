import { eq } from 'drizzle-orm'
import type { DbRouter, DataDb } from '../db/router.js'
import { importBatches, rawTransactions, subAccounts } from '../db/data/schema.js'
import { findAccountIdByName as accountIdByName } from '../db/lookups.js'
import { resolveLineTax } from '../journal/lineTax.js'
import { createTwoLineDraftEntry } from '../journal/draftEntry.js'
import { assertInFiscalPeriod } from '../journal/fiscalPeriod.js'
import { withDedupHashes } from './types.js'
import { ingestRow } from './ingest.js'
import { requireLinkedSubAccount, requireOpenFiscalYear, requireSuspenseAccount, SAMPLE_LIMIT } from './precondition.js'
import {
  bankRowToParsedRow,
  bankCounterAccountName,
  parseBankProposal,
  isBankSkillPayload,
  OWNER_DRAW_ACCOUNT,
  OWNER_CONTRIBUTION_ACCOUNT,
  type BankTxn,
} from './bank.js'

/**
 * 銀行（普通預金）仕訳候補の取込（[bank-import-api.md] POST /skill/bank/journal-candidates）。
 *
 * スキルトラック専用。AIの仕訳候補をそのまま draft 化する（auto_journal_rules/institution は通さない・[acquisition-skill-spec §7.1]）。
 * 普通預金が一脚で、direction が貸借を決める:
 *   入金(in):  借) 普通預金(口座補助・line_no=1) / 貸) 相手科目(line_no=2)
 *   出金(out): 借) 相手科目(line_no=2)         / 貸) 普通預金(口座補助・line_no=1)
 * 相手科目を line_no=2 に置くことで、確定時の既存 recordMappingFromEntry が 摘要→科目 を学習する（[acquisition-skill-spec §7.2]）。
 *
 * 本体が権威を持つ: 会計期間ゲート（txn_date）/ 冪等（出現インデックス方式＝UIトラックと互換）/ 科目検証（未知→未確定勘定＋flag）。
 * 「黙って落とさない」: 期間外・重複・未解決は件数＋明細で返す。
 */

export type BankRawRow = typeof rawTransactions.$inferSelect

/** 相手科目の解決結果フラグ（要承認の可視化用）。 */
export type BankCounterFlag = 'unknown' | 'suspense' | 'owner' | 'settlement' | null

export interface BankImportArgs {
  /** 投入先の account_ref（連携サービスの linked_account_ref。例 `bank_ufj-1`）。普通預金の口座補助を一意に指す。 */
  accountRef: string
  fileName?: string
  transactions: BankTxn[]
}

export interface BankExcluded {
  index: number
  txnDate: string
  amount: number
  description: string
}
export interface BankUnresolved {
  index: number
  description: string
  reason: string
}
export interface BankDuplicate {
  index: number
  txnDate: string
  amount: number
  description: string
}
export interface BankWarning {
  index: number
  message: string
}
export interface BankDraftEntry {
  entryId: number
  index: number
}

export interface BankImportSummary {
  batchId: number
  acceptedRows: number
  draftEntries: BankDraftEntry[]
  skippedDup: number
  duplicates: BankDuplicate[]
  /** 期間外で除外した総件数（繰越後に取込まれることを可視化）。 */
  excludedCount: number
  excludedOutOfPeriod: BankExcluded[]
  unresolved: BankUnresolved[]
  warnings: BankWarning[]
  periodStart: string
  periodEnd: string
}

function subByRef(db: DataDb, ref: string) {
  return db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, ref)).all()[0]
}

/** この raw が銀行スキルトラックか（raw_payload.track==='bank_skill'）。restore の経路分岐に使う。 */
export function isBankSkillRaw(raw: BankRawRow): boolean {
  return isBankSkillPayload(raw.rawPayload)
}

/**
 * 1件の銀行 raw を draft 仕訳化する（取込時と、ignored→restore の再仕訳の双方で共有）。
 * 相手科目は raw_payload のAI仕訳候補（proposed_account/treatment）から決める＝suggest/institution は通さない（§7.1）。
 * 普通預金が一脚で direction が貸借を決める。
 */
export function journalizeBankRow(db: DataDb, raw: BankRawRow): { entryId: number; counterId: number; flag: BankCounterFlag; wantName: string } {
  const open = requireOpenFiscalYear(db)
  // 会計期間ゲート（[[journal]]）。取込時は登録前に弾いているが、restore はここが唯一の壁になる。
  assertInFiscalPeriod(open, raw.txnDate, '取込明細の日付')
  const deposit = requireLinkedSubAccount(db, raw.accountRef, `account_ref "${raw.accountRef}" に対応する口座が未登録`)
  const suspense = requireSuspenseAccount(db)

  const proposal = parseBankProposal(raw.rawPayload)
  const wantName = bankCounterAccountName(proposal)
  let counterId = accountIdByName(db, wantName)
  let flag: BankCounterFlag = null
  if (counterId == null) {
    counterId = suspense
    flag = 'unknown'
  } else if (counterId === suspense) {
    flag = 'suspense'
  } else if (wantName === OWNER_DRAW_ACCOUNT || wantName === OWNER_CONTRIBUTION_ACCOUNT) {
    flag = 'owner'
  } else if (proposal.treatment === 'settlement') {
    flag = 'settlement'
  }

  // 相手科目の補助科目（settlement の未払金カードチャネル等）。親勘定が一致する場合のみ採用（別勘定の補助混入を防ぐ）。
  let counterSubId: number | null = null
  if (proposal.counterSubAccountRef) {
    const cs = subByRef(db, proposal.counterSubAccountRef)
    if (cs && cs.accountId === counterId) counterSubId = cs.id
  }

  const amount = raw.amount
  // 普通預金(line_no=1)＝口座補助 / 相手科目(line_no=2)。side は direction で決める（in=普通預金が借方）。
  const depositSide: 'debit' | 'credit' = raw.direction === 'in' ? 'debit' : 'credit'
  const counterSide: 'debit' | 'credit' = raw.direction === 'in' ? 'credit' : 'debit'
  const depositTax = resolveLineTax(db, { accountId: deposit.accountId, subAccountId: deposit.id, amount })
  const counterTax = resolveLineTax(db, { accountId: counterId, subAccountId: counterSubId, amount })
  const entryId = createTwoLineDraftEntry(
    db,
    { fiscalYearId: open.id, entryDate: raw.txnDate, description: raw.description, source: 'import', sourceRef: String(raw.id) },
    { side: depositSide, accountId: deposit.accountId, subAccountId: deposit.id, tax: depositTax, amount },
    { side: counterSide, accountId: counterId, subAccountId: counterSubId, tax: counterTax, amount },
  )
  db.update(rawTransactions).set({ status: 'journalized', journalEntryId: entryId, suggestedAccountId: counterId, suggestedSubAccountId: counterSubId }).where(eq(rawTransactions.id, raw.id)).run()
  return { entryId, counterId, flag, wantName }
}

export function bankImport(router: DbRouter, bookId: string, args: BankImportArgs): BankImportSummary {
  const db = router.bookDb(bookId)

  const open = requireOpenFiscalYear(db, '取込前に会計年度を作成してください')
  const { startDate, endDate } = open

  // 普通預金の口座補助（account_ref=linked_account_ref に紐づく補助科目）。未登録なら明示エラー。
  const deposit = requireLinkedSubAccount(db, args.accountRef, `account_ref "${args.accountRef}" に対応する口座が未登録（連携サービスで銀行口座を登録してください）`)
  // 学習・履歴・dedup のキーは import_source_type（= カタログ key 'bank_ufj' 等）。
  const sourceType = deposit.importSourceType ?? args.accountRef
  requireSuspenseAccount(db)

  const now = new Date().toISOString()
  const batch = db
    .insert(importBatches)
    .values({ sourceType, accountRef: args.accountRef, fileName: args.fileName ?? null, importedAt: now, rowCount: args.transactions.length, status: 'done' })
    .returning()
    .all()[0]

  const summary: BankImportSummary = {
    batchId: batch.id,
    acceptedRows: 0,
    draftEntries: [],
    skippedDup: 0,
    duplicates: [],
    excludedCount: 0,
    excludedOutOfPeriod: [],
    unresolved: [],
    warnings: [],
    periodStart: startDate,
    periodEnd: endDate,
  }

  // 入力全件を順序保持で dedup（出現インデックス方式・[import/types.ts] withDedupHashes）。
  // 期間外も出現インデックスを消費するため UI parser（whole-file dedup→importer 期間ゲート）と byte 互換。
  const rows = withDedupHashes(args.transactions.map((t) => bankRowToParsedRow(t)))

  rows.forEach((row, index) => {
    // 会計期間ゲート（txn_date。ISO辞書順比較）。範囲外（翌期等）は登録しない（繰越後に取込）。
    const inPeriod = row.txnDate >= startDate && row.txnDate <= endDate
    if (!inPeriod) {
      summary.excludedCount++
      if (summary.excludedOutOfPeriod.length < SAMPLE_LIMIT) summary.excludedOutOfPeriod.push({ index, txnDate: row.txnDate, amount: row.amount, description: row.description })
      return
    }

    let outcome: { kind: 'dup' } | { kind: 'ok'; result: ReturnType<typeof journalizeBankRow> }
    try {
      outcome = ingestRow(
        db,
        { batchId: batch.id, txnDate: row.txnDate, amount: row.amount, direction: row.direction, balance: row.balance ?? null, description: row.description, rawPayload: row.rawPayload, dedupHash: row.dedupHash, accountRef: args.accountRef, status: 'pending' },
        journalizeBankRow,
      )
    } catch (err) {
      if (summary.warnings.length < SAMPLE_LIMIT) summary.warnings.push({ index, message: `行 ${index}「${row.description}」の取込に失敗: ${(err as Error).message}` })
      return
    }
    if (outcome.kind === 'dup') {
      summary.skippedDup++
      if (summary.duplicates.length < SAMPLE_LIMIT) summary.duplicates.push({ index, txnDate: row.txnDate, amount: row.amount, description: row.description })
      return
    }
    summary.acceptedRows++
    summary.draftEntries.push({ entryId: outcome.result.entryId, index })
    if (summary.unresolved.length < SAMPLE_LIMIT) {
      if (outcome.result.flag === 'unknown') summary.unresolved.push({ index, description: row.description, reason: `科目「${outcome.result.wantName}」が見つからず未確定勘定（要承認）` })
      else if (outcome.result.flag === 'suspense') summary.unresolved.push({ index, description: row.description, reason: '未確定（要承認）' })
      else if (outcome.result.flag === 'owner') summary.unresolved.push({ index, description: row.description, reason: `${outcome.result.wantName}（事業主勘定・要承認）` })
      else if (outcome.result.flag === 'settlement') summary.unresolved.push({ index, description: row.description, reason: '未払金決済（補助科目の確認・要承認）' })
    }
  })

  // 取込0件（全件重複/期間外）なら空バッチを残さない（取込履歴のノイズ防止）。raws は未挿入なので安全に削除できる。
  if (summary.acceptedRows === 0) {
    db.delete(importBatches).where(eq(importBatches.id, batch.id)).run()
  }

  return summary
}
