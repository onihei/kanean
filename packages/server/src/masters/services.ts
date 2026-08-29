import type { LinkedService } from '@kanean/shared'
export type { LinkedService }
import { and, asc, eq, isNotNull, sql } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { accounts, journalEntries, journalLines, subAccounts } from '../db/data/schema.js'
import { getOpenFiscalYear } from '../db/lookups.js'
import { catalogBySourceType, getCatalogEntry } from '../services/catalog.js'
import { customFormatId } from '../import/types.js'
import { listImportFormats } from './importFormats.js'

/**
 * 連携サービス（口座マスタ F-IMP-8 をカタログ駆動に拡張）。
 * 実体は「import_source_type=カタログ key・linked_account_ref=自動採番の account_ref を持つ補助科目」。
 * 登録で補助科目を自動作成し、取込→仕訳化（journalize）・サービス毎の draft 確認（listDrafts subAccountId）に使う。
 * 削除/無効化は補助科目の論理削除に委ねる（D-8。本モジュールは登録・一覧のみ）。
 */

export interface RegisterServiceInput {
  serviceKey: string
  name?: string | null
}

/** account_ref を `{key}-{n}` で自動採番（既存 linked_account_ref と衝突しない最小 n≥1）。 */
function nextAccountRef(db: DataDb, key: string): string {
  const used = new Set(
    db
      .select({ ref: subAccounts.linkedAccountRef })
      .from(subAccounts)
      .where(isNotNull(subAccounts.linkedAccountRef))
      .all()
      .map((r) => r.ref as string),
  )
  let n = 1
  while (used.has(`${key}-${n}`)) n++
  return `${key}-${n}`
}

/**
 * 連携サービスを登録する＝親勘定（カタログ）配下に補助科目を自動作成し、
 * import_source_type と自動採番 account_ref を紐付ける。複数登録可（account_ref のみ一意・表示名は重複可）。
 */
export function registerService(db: DataDb, input: RegisterServiceInput): LinkedService {
  const entry = getCatalogEntry(input.serviceKey)
  if (!entry) throw new Error(`未対応の連携サービス: ${input.serviceKey}`)
  const acc = db.select({ id: accounts.id, name: accounts.name }).from(accounts).where(eq(accounts.name, entry.parentAccountName)).all()[0]
  if (!acc) throw new Error(`勘定科目 "${entry.parentAccountName}" が見つかりません（シード未投入）`)

  const accountRef = nextAccountRef(db, entry.key)
  const name = (input.name ?? '').trim() || entry.label
  const [{ next }] = db
    .select({ next: sql<number>`coalesce(max(${subAccounts.sortOrder}), -1) + 1` })
    .from(subAccounts)
    .where(eq(subAccounts.accountId, acc.id))
    .all()
  const now = new Date().toISOString()
  const sub = db
    .insert(subAccounts)
    .values({
      accountId: acc.id,
      name,
      linkedAccountRef: accountRef,
      importSourceType: entry.key,
      isActive: true,
      sortOrder: next,
      createdAt: now,
      updatedAt: now,
    })
    .returning()
    .all()[0]
  return {
    subAccountId: sub.id,
    serviceKey: entry.key,
    name,
    accountRef,
    accountId: acc.id,
    accountName: acc.name,
    label: entry.label,
    kind: entry.kind,
    csv: entry.csv,
    draftCount: 0,
  }
}

/** open 年度の draft を取込元行(line_no=1)の補助科目で数えた map（サービス毎 draft 件数）。 */
function draftCountsBySubAccount(db: DataDb): Map<number, number> {
  const open = getOpenFiscalYear(db)
  const counts = new Map<number, number>()
  if (!open) return counts
  const lines = db
    .select({ subAccountId: journalLines.subAccountId })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.fiscalYearId, open.id),
        eq(journalEntries.status, 'draft'),
        eq(journalLines.lineNo, 1),
        isNotNull(journalLines.subAccountId),
      ),
    )
    .all()
  for (const l of lines) {
    if (l.subAccountId == null) continue
    counts.set(l.subAccountId, (counts.get(l.subAccountId) ?? 0) + 1)
  }
  return counts
}

/** 登録済み連携サービス一覧（= linked_account_ref を持つ有効な補助科目）＋サービス毎の draft 件数。 */
export function listServices(db: DataDb): LinkedService[] {
  const rows = db
    .select({
      subAccountId: subAccounts.id,
      name: subAccounts.name,
      accountRef: subAccounts.linkedAccountRef,
      accountId: subAccounts.accountId,
      accountName: accounts.name,
      serviceKey: subAccounts.importSourceType,
    })
    .from(subAccounts)
    .innerJoin(accounts, eq(subAccounts.accountId, accounts.id))
    .where(and(isNotNull(subAccounts.linkedAccountRef), eq(subAccounts.isActive, true)))
    .orderBy(asc(subAccounts.accountId), asc(subAccounts.sortOrder), asc(subAccounts.id))
    .all()

  const counts = draftCountsBySubAccount(db)
  // ユーザー定義フォーマット（format:{id}）の口座は本カタログ外だが取込（/import）は今も機能する。
  // カタログ外＝CSV未対応と誤表示して既存データの取込を黙って塞がないよう、名称を解決し csv:true で扱う。
  const formatNames = new Map<number, string>()
  if (rows.some((r) => customFormatId(r.serviceKey ?? '') != null)) {
    for (const f of listImportFormats(db, true)) formatNames.set(f.id, f.name)
  }
  return rows.map((r) => {
    const entry = catalogBySourceType(r.serviceKey)
    const fid = customFormatId(r.serviceKey ?? '')
    const isFormat = fid != null
    return {
      subAccountId: r.subAccountId,
      serviceKey: r.serviceKey ?? '',
      name: r.name,
      accountRef: r.accountRef as string,
      accountId: r.accountId,
      accountName: r.accountName,
      label: entry?.label ?? (isFormat ? (formatNames.get(fid) ?? 'ユーザー定義フォーマット') : null),
      kind: entry?.kind ?? null,
      // 組込カタログ=その csv フラグ / format:{id}=取込可 / 不明(旧 null 等)=false。
      csv: entry?.csv ?? isFormat,
      draftCount: counts.get(r.subAccountId) ?? 0,
    }
  })
}
