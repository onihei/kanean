import { eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { mappingHistory, accounts } from '../db/data/schema.js'
import { lookupEcHistory, DEFAULT_WINDOW_MONTHS, DEFAULT_LIMIT } from './ecClassify.js'
import { OWNER_DRAW_ACCOUNT, SUSPENSE_ACCOUNT, type EcTreatment } from '../import/ec.js'

/**
 * 分類履歴 lookup サービス（[ec-import-api.md §2]）。pure な lookupEcHistory に DB I/O を被せる。
 * mapping_history（source_type=source の EC 行）を読み、今回品名に関連する確定履歴を
 * recency×hitCount 上位で返す。科目は名前へ解決し treatment を導出（スキルが proposed_account にそのまま使える）。
 * 注入 payload を絞る本体ロジックは ecClassify.ts（§7.3）。
 */

export interface EcClassificationCandidate {
  pattern: string
  proposedAccount: string
  treatment: EcTreatment
  subAccountId: number | null
  hitCount: number
  lastUsedAt: string | null
  score: number
}

export interface EcClassificationResult {
  policy: { windowMonths: number; limit: number; matchedItems: number }
  candidates: EcClassificationCandidate[]
}

export interface EcClassificationOptions {
  /** 基準時刻（ISO）。既定は実行時刻。 */
  now?: string
  windowMonths?: number
  limit?: number
}

function treatmentOf(accountName: string): EcTreatment {
  if (accountName === OWNER_DRAW_ACCOUNT) return 'owner_draw'
  if (accountName === SUSPENSE_ACCOUNT) return 'unresolved'
  return 'expense'
}

export function lookupEcClassification(
  db: DataDb,
  source: string,
  items: string[],
  opts: EcClassificationOptions = {},
): EcClassificationResult {
  const windowMonths = opts.windowMonths ?? DEFAULT_WINDOW_MONTHS
  const limit = opts.limit ?? DEFAULT_LIMIT
  const now = opts.now ?? new Date().toISOString()

  const rows = db
    .select()
    .from(mappingHistory)
    .where(eq(mappingHistory.sourceType, source))
    .all()
    .map((r) => ({ pattern: r.pattern, accountId: r.accountId, subAccountId: r.subAccountId, hitCount: r.hitCount, lastUsedAt: r.lastUsedAt }))

  const ranked = lookupEcHistory(rows, items, { now, windowMonths, limit })

  // 科目名の解決（id→name）。確定履歴に出る科目数は限られるので個別解決で十分。
  const nameCache = new Map<number, string>()
  const nameOf = (id: number): string => {
    const cached = nameCache.get(id)
    if (cached != null) return cached
    const name = db.select({ name: accounts.name }).from(accounts).where(eq(accounts.id, id)).all()[0]?.name ?? SUSPENSE_ACCOUNT
    nameCache.set(id, name)
    return name
  }

  const candidates: EcClassificationCandidate[] = ranked.map((c) => {
    const name = nameOf(c.accountId)
    return { pattern: c.pattern, proposedAccount: name, treatment: treatmentOf(name), subAccountId: c.subAccountId, hitCount: c.hitCount, lastUsedAt: c.lastUsedAt, score: c.score }
  })

  return { policy: { windowMonths, limit, matchedItems: candidates.length }, candidates }
}
