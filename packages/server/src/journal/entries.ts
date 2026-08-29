import type { AuditLogView } from '@kanean/shared'
export type { AuditLogView }
import { and, asc, desc, eq, gte, inArray, lte } from 'drizzle-orm'
import type { EntryLineView, EntryView, ListEntriesFilter } from '@kanean/shared'

export type { EntryLineView, EntryView, ListEntriesFilter }
import type { DataDb } from '../db/router.js'
import { containsEscaped } from '../db/like.js'
import {
  accounts,
  auditLogs,
  counterparties,
  departments,
  depreciationEntries,
  documents,
  entryTags,
  fiscalYears,
  importBatches,
  journalEntries,
  journalLines,
  mappingHistory,
  rawTransactions,
  subAccounts,
} from '../db/data/schema.js'
import {
  validateAndResolveLines,
  toLineValues,
  type ManualEntryLineInput,
} from './manualEntry.js'

/**
 * 確定済み仕訳の一覧・検索・編集・確定取消・削除（roadmap Phase1 F-JNL-5）。
 * すべての変更（編集 update / 確定取消 unconfirm / 削除 delete）は audit_logs に
 * before/after スナップショット付きで残す（電子帳簿保存法の訂正・削除履歴の土台）。
 *
 * 不変条件:
 * - 確定済み仕訳は直接編集しない。訂正は「確定取消 → 編集 → 確定」の経路を通す
 *   （痕跡なし改変の防止。confirm.updateLineAccount と同方針）。
 * - 編集・確定取消・削除は open 年度に限る（closed 年度は不可）。
 * - 削除は物理削除だが before スナップショットで原状を保持＝削除履歴を残す。
 */

type EntryRow = typeof journalEntries.$inferSelect



/** 1仕訳を明細（科目名・補助科目名つき）込みのビューへ整形。 */
function buildEntryView(db: DataDb, e: EntryRow): EntryView {
  const lines = db
    .select({
      id: journalLines.id,
      lineNo: journalLines.lineNo,
      side: journalLines.side,
      accountId: journalLines.accountId,
      accountName: accounts.name,
      subAccountId: journalLines.subAccountId,
      counterpartyId: journalLines.counterpartyId,
      departmentId: journalLines.departmentId,
      taxCategoryId: journalLines.taxCategoryId,
      taxAmount: journalLines.taxAmount,
      amount: journalLines.amount,
      description: journalLines.description,
    })
    .from(journalLines)
    .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
    .where(eq(journalLines.entryId, e.id))
    .orderBy(asc(journalLines.lineNo))
    .all()

  // 補助科目・取引先・部門の名称を必要分だけ一括解決（N+1 回避）。
  const uniq = (vs: Array<number | null>) => [...new Set(vs.filter((v): v is number => v != null))]
  const subNameById = new Map<number, string>()
  const subIds = uniq(lines.map((l) => l.subAccountId))
  if (subIds.length > 0) {
    for (const s of db.select({ id: subAccounts.id, name: subAccounts.name }).from(subAccounts).where(inArray(subAccounts.id, subIds)).all()) {
      subNameById.set(s.id, s.name)
    }
  }
  const cpNameById = new Map<number, string>()
  const cpIds = uniq(lines.map((l) => l.counterpartyId))
  if (cpIds.length > 0) {
    for (const c of db.select({ id: counterparties.id, name: counterparties.name }).from(counterparties).where(inArray(counterparties.id, cpIds)).all()) {
      cpNameById.set(c.id, c.name)
    }
  }
  const depNameById = new Map<number, string>()
  const depIds = uniq(lines.map((l) => l.departmentId))
  if (depIds.length > 0) {
    for (const d of db.select({ id: departments.id, name: departments.name }).from(departments).where(inArray(departments.id, depIds)).all()) {
      depNameById.set(d.id, d.name)
    }
  }

  const viewLines: EntryLineView[] = lines.map((l) => ({
    ...l,
    side: l.side as 'debit' | 'credit',
    subAccountName: l.subAccountId != null ? (subNameById.get(l.subAccountId) ?? null) : null,
    counterpartyName: l.counterpartyId != null ? (cpNameById.get(l.counterpartyId) ?? null) : null,
    departmentName: l.departmentId != null ? (depNameById.get(l.departmentId) ?? null) : null,
  }))
  const debitTotal = viewLines.filter((l) => l.side === 'debit').reduce((s, l) => s + l.amount, 0)
  const creditTotal = viewLines.filter((l) => l.side === 'credit').reduce((s, l) => s + l.amount, 0)

  return {
    id: e.id,
    fiscalYearId: e.fiscalYearId,
    entryDate: e.entryDate,
    description: e.description,
    memo: e.memo,
    slipNo: e.slipNo,
    source: e.source,
    status: e.status as 'draft' | 'confirmed',
    createdAt: e.createdAt,
    updatedAt: e.updatedAt,
    debitTotal,
    creditTotal,
    lines: viewLines,
  }
}


/** open（指定）年度の仕訳一覧。日付昇順、検索条件で絞り込み。 */
export function listEntries(db: DataDb, fiscalYearId: number, filter: ListEntriesFilter = {}): EntryView[] {
  const status = filter.status ?? 'confirmed'
  const conds = [eq(journalEntries.fiscalYearId, fiscalYearId)]
  if (status !== 'all') conds.push(eq(journalEntries.status, status))
  if (filter.from) conds.push(gte(journalEntries.entryDate, filter.from))
  if (filter.to) conds.push(lte(journalEntries.entryDate, filter.to))
  // 「素の substring 一致」（メタ文字エスケープ）。listDrafts と共有（db/like.ts・issue #143）。
  if (filter.q) conds.push(containsEscaped(journalEntries.description, filter.q))

  let rows = db
    .select()
    .from(journalEntries)
    .where(and(...conds))
    .orderBy(asc(journalEntries.entryDate), asc(journalEntries.id))
    .all()

  if (filter.accountId != null) {
    const hit = new Set(
      db
        .select({ entryId: journalLines.entryId })
        .from(journalLines)
        .where(eq(journalLines.accountId, filter.accountId))
        .all()
        .map((r) => r.entryId),
    )
    rows = rows.filter((e) => hit.has(e.id))
  }
  if (filter.limit && rows.length > filter.limit) rows = rows.slice(0, filter.limit)

  return rows.map((e) => buildEntryView(db, e))
}

/** 1仕訳の詳細。 */
export function getEntry(db: DataDb, entryId: number): EntryView {
  const e = db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).all()[0]
  if (!e) throw new Error(`仕訳 ${entryId} が見つかりません`)
  return buildEntryView(db, e)
}

// --- 監査ログ --------------------------------------------------------------

/** entry のスナップショット（JSON 文字列）。ヘッダ＋明細を原状保持する。 */
function snapshot(db: DataDb, entryId: number): string | null {
  const e = db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).all()[0]
  if (!e) return null
  const lines = db.select().from(journalLines).where(eq(journalLines.entryId, entryId)).orderBy(asc(journalLines.lineNo)).all()
  return JSON.stringify({ entry: e, lines })
}

function writeAudit(
  db: DataDb,
  log: { targetId: number; action: 'update' | 'unconfirm' | 'delete'; before: string | null; after: string | null; note?: string | null },
): void {
  db.insert(auditLogs)
    .values({
      targetType: 'journal_entry',
      targetId: log.targetId,
      action: log.action,
      before: log.before,
      after: log.after,
      note: log.note ?? null,
      at: new Date().toISOString(),
    })
    .run()
}

/** 監査ログ（新しい順）。targetId 指定でその仕訳の履歴に限定。 */
export function listAuditLogs(db: DataDb, targetId?: number): AuditLogView[] {
  const rows = (
    targetId != null
      ? // targetType の等値条件は audit_logs_target_idx（target_type, target_id）を効かせるため。
        // writeAudit は常に 'journal_entry' を書くので挙動は不変（attachments/service.ts と同パターン）。
        db
          .select()
          .from(auditLogs)
          .where(and(eq(auditLogs.targetType, 'journal_entry'), eq(auditLogs.targetId, targetId)))
      : db.select().from(auditLogs)
  )
    .orderBy(desc(auditLogs.id))
    .all()
  return rows.map((r) => ({
    id: r.id,
    targetId: r.targetId,
    action: r.action,
    note: r.note,
    at: r.at,
    before: r.before ? JSON.parse(r.before) : null,
    after: r.after ? JSON.parse(r.after) : null,
  }))
}

// --- 変更系（編集 / 確定取消 / 削除） --------------------------------------

/** entry の属する年度を取り、open でなければ拒否（変更は open 年度に限る）。 */
function requireOpenYearFor(db: DataDb, entry: EntryRow): { startDate: string; endDate: string } {
  const fy = db.select().from(fiscalYears).where(eq(fiscalYears.id, entry.fiscalYearId)).all()[0]
  if (!fy) throw new Error(`会計年度 ${entry.fiscalYearId} が見つかりません`)
  if (fy.status !== 'open') throw new Error(`会計年度が ${fy.status} のため変更できません（対象年度を開いてください）`)
  return { startDate: fy.startDate, endDate: fy.endDate }
}

/**
 * 確定時に学習した mapping_history を取り消す（hit_count 連動取消）。
 * 取込由来（raw_transactions 紐付き）の仕訳のみ対象。hit_count を1減算、0なら行削除。
 */
function reverseMappingLearning(db: DataDb, entryId: number): void {
  const raw = db.select().from(rawTransactions).where(eq(rawTransactions.journalEntryId, entryId)).all()[0]
  if (!raw || !raw.description) return
  const batch = db.select().from(importBatches).where(eq(importBatches.id, raw.batchId)).all()[0]
  if (!batch) return
  const existing = db
    .select()
    .from(mappingHistory)
    .where(and(eq(mappingHistory.sourceType, batch.sourceType), eq(mappingHistory.pattern, raw.description)))
    .all()[0]
  if (!existing) return
  if (existing.hitCount <= 1) {
    db.delete(mappingHistory).where(eq(mappingHistory.id, existing.id)).run()
  } else {
    db.update(mappingHistory).set({ hitCount: existing.hitCount - 1 }).where(eq(mappingHistory.id, existing.id)).run()
  }
}

export interface UpdateEntryInput {
  entryDate: string
  description?: string | null
  memo?: string | null
  slipNo?: string | null
  lines: ManualEntryLineInput[]
  /** 訂正理由（監査ログに残す）。 */
  note?: string | null
}

/**
 * draft 仕訳を編集（ヘッダ＋明細を差し替え）。確定済みは確定取消が前提（直接編集不可）。
 * 明細は validateAndResolveLines で再検証（貸借一致・期間ゲート・税区分再解決）。
 */
export function updateEntry(db: DataDb, entryId: number, input: UpdateEntryInput): void {
  const entry = db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).all()[0]
  if (!entry) throw new Error(`仕訳 ${entryId} が見つかりません`)
  if (entry.status !== 'draft') {
    throw new Error('確定済み仕訳は直接編集できません（確定取消してから編集してください）')
  }
  const fy = requireOpenYearFor(db, entry)
  const resolved = validateAndResolveLines(db, fy, input.entryDate, input.lines)

  const before = snapshot(db, entryId)
  const now = new Date().toISOString()
  db.transaction((tx) => {
    tx.update(journalEntries)
      .set({
        entryDate: input.entryDate,
        description: input.description ?? null,
        memo: input.memo ?? null,
        slipNo: input.slipNo ?? null,
        updatedAt: now,
      })
      .where(eq(journalEntries.id, entryId))
      .run()
    tx.delete(journalLines).where(eq(journalLines.entryId, entryId)).run()
    tx.insert(journalLines).values(toLineValues(entryId, input.lines, resolved)).run()
  })
  const after = snapshot(db, entryId)
  writeAudit(db, { targetId: entryId, action: 'update', before, after, note: input.note })
}

/** 確定取消（confirmed → draft）。学習を取り消し、監査ログを残す。 */
export function unconfirmEntry(db: DataDb, entryId: number, note?: string | null): void {
  const entry = db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).all()[0]
  if (!entry) throw new Error(`仕訳 ${entryId} が見つかりません`)
  if (entry.status !== 'confirmed') throw new Error('確定済みの仕訳のみ確定取消できます')
  requireOpenYearFor(db, entry)

  const before = snapshot(db, entryId)
  const now = new Date().toISOString()
  db.update(journalEntries).set({ status: 'draft', updatedAt: now }).where(eq(journalEntries.id, entryId)).run()
  reverseMappingLearning(db, entryId)
  const after = snapshot(db, entryId)
  writeAudit(db, { targetId: entryId, action: 'unconfirm', before, after, note })
}

/**
 * 仕訳を削除（物理削除）。before スナップショットで原状を監査ログに残す。
 * - 取込由来の明細（raw_transactions）は pending に戻し再仕訳可能にする（FK 解除も兼ねる）。
 * - 償却・帳票からの参照（journal_entry_id）も解除してから削除。
 * - 確定済みなら学習を取り消す。
 */
export function deleteEntry(db: DataDb, entryId: number, note?: string | null): void {
  const entry = db.select().from(journalEntries).where(eq(journalEntries.id, entryId)).all()[0]
  if (!entry) throw new Error(`仕訳 ${entryId} が見つかりません`)
  requireOpenYearFor(db, entry)

  const before = snapshot(db, entryId)
  if (entry.status === 'confirmed') reverseMappingLearning(db, entryId)

  db.transaction((tx) => {
    // 取込明細を pending に戻す（FK 解除＋再仕訳可能化）。決済リンク（口座間振替）も解除し、
    // 振替 entry を削除した時に settlement_raw_id が相互に宙吊りで残らないようにする（名寄せ整合の維持）。
    tx.update(rawTransactions).set({ status: 'pending', journalEntryId: null, settlementRawId: null }).where(eq(rawTransactions.journalEntryId, entryId)).run()
    // 他テーブルからの参照を解除（FK 制約回避）。
    tx.update(depreciationEntries).set({ journalEntryId: null }).where(eq(depreciationEntries.journalEntryId, entryId)).run()
    // 請求書等は起票仕訳の削除で未起票(draft)へ戻す（status と journalEntryId の整合を保つ。slice9）。
    tx.update(documents).set({ journalEntryId: null, status: 'draft', updatedAt: new Date().toISOString() }).where(eq(documents.journalEntryId, entryId)).run()
    // 付与済みタグ（entry_tags）は FK で entry を縛るため先に外す。
    tx.delete(entryTags).where(eq(entryTags.entryId, entryId)).run()
    tx.delete(journalLines).where(eq(journalLines.entryId, entryId)).run()
    tx.delete(journalEntries).where(eq(journalEntries.id, entryId)).run()
  })
  writeAudit(db, { targetId: entryId, action: 'delete', before, after: null, note })
}
