import crypto from 'node:crypto'
import { and, eq, inArray } from 'drizzle-orm'
import type { DataDb, DataTx } from '../db/router.js'
import { accounts, journalEntries, journalLines, rawTransactions, subAccounts } from '../db/data/schema.js'
import { SUSPENSE_ACCOUNT } from '../import/precondition.js'
import { updateLineAccount } from '../journal/confirm.js'
import { lookupEcClassification } from '../journal/ecClassifyService.js'
import { getPolicy } from './policy.js'

/**
 * 未確定の分類（acquisition spec「未確定の分類」）。
 *
 * 分類は**取込ジョブに属さない**。「未確定勘定のまま残っている draft に科目を当てる」操作であり、
 * 人が画面で当てても外部クライアントが当てても同じものに効く。
 * 巡回だけでなく CSV 取込・手入力で生じた未確定にも同じ操作が効く。
 */

/** 分類対象1件。**金額・取引識別子・残高・証憑参照は含めない。** */
export interface UnclassifiedItem {
  /** `text` から決まるダイジェスト。単体では取引を特定できない（design D5）。 */
  id: string
  /** 分類対象の文字（品名または摘要）。 */
  text: string
  /** 同じ文字の未確定が何件あるか（人へ規模を伝えるため。金額ではない）。 */
  count: number
  /** どの連携サービス由来か（複数サービスが混ざるため）。 */
  sources: string[]
}

export interface ClassificationHint {
  /** どの連携サービスの履歴か。複数サービスが混ざるので、どれ由来かが分からないと当てにできない。 */
  source: string
  pattern: string
  proposedAccount: string
  treatment: string
  hitCount: number
  lastUsedAt: string | null
}

export interface UnclassifiedResult {
  items: UnclassifiedItem[]
  hints: ClassificationHint[]
  /** 分類方針（`classification-policy`）。履歴が無い品名はこれだけが手掛かりになる。 */
  policy: string
  total: number
}

export interface ClassifyAnswer {
  id: string
  proposedAccount: string
  /** そう判断した理由。確定時に人が読む（[[web-app]]「AI の根拠を確認する」）。 */
  reason?: string
  /** 確信度。例外ベースレビュー（high を一括確定）が成り立つ条件。 */
  confidence?: 'high' | 'medium' | 'low'
  /** 依拠した方針の版（`classification-policy` の変更履歴）。 */
  policyRef?: string
}

export interface ClassifyResult {
  /** 科目を置き換えた明細の件数。 */
  applied: number
  /** 対応する未確定が無かった識別子の件数（既に人が片付けた・知らない id）。 */
  unmatched: number
  /** 知らない勘定科目名を指された件数（作らない＝黙って別の科目に寄せない）。 */
  unknownAccounts: string[]
  /** まだ残っている未確定の件数。 */
  remaining: number
}

export class NoSuspenseAccountError extends Error {
  readonly code = 'precondition_failed'
  constructor() {
    super('未確定勘定が見つかりません（シード未投入）')
    this.name = 'NoSuspenseAccountError'
  }
}

/**
 * `text` から識別子を作る。**連番にしない。**
 * 連番は「一覧の何番目か」に依存するので、人が先に何件か片付けただけで番号がずれ、
 * 返ってきた分類が別の取引に当たる（会計データを壊す）。
 */
export function itemId(text: string): string {
  return crypto.createHash('sha256').update(text).digest('hex').slice(0, 12)
}

function suspenseAccountId(db: DataDb): number {
  const row = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, SUSPENSE_ACCOUNT)).all()[0]
  if (!row) throw new NoSuspenseAccountError()
  return row.id
}

/** 未確定勘定のまま残っている draft の明細行（＋その仕訳の摘要と由来）。 */
/**
 * 分類の根拠（理由・確信度）を取込明細へ書き戻す。
 *
 * 由来は `extractOrigin` が復元する。取込時点では科目が決まっていないので根拠も空で、
 * **後から当てた分をここへ書かないと画面に何も出ない**。根拠が出ないと「確信度 high を
 * 一括確定 → 残りだけ精査」という例外ベースのレビューが成り立たず、197件を1件ずつ見ることになる
 * （[[web-app]]「確信度で絞って一括確定する」）。
 *
 * 置き場は raw_payload から独立した `proposal_json`（issue #144）: UI CSV の raw_payload は
 * 元CSV列の配列で相乗りできず、CSV 由来 draft だけ根拠が失われていた。raw_payload が
 * スキル形式（オブジェクト）の場合は従来どおり相乗りも続ける — ignored→restore の再仕訳が
 * payload の proposedAccount を読むため（[import/ecImport.ts] / [import/bankImport.ts]）。
 */
function recordProposal(db: DataDb | DataTx, entryId: number, answer: ClassifyAnswer): void {
  const raw = db
    .select({ id: rawTransactions.id, rawPayload: rawTransactions.rawPayload })
    .from(rawTransactions)
    .where(eq(rawTransactions.journalEntryId, entryId))
    .all()[0]
  if (!raw) return // 手入力の draft には取込明細が無い（科目だけ変えて終わり）

  const proposal = {
    proposedAccount: answer.proposedAccount,
    reason: answer.reason ?? null,
    confidence: answer.confidence ?? null,
    policyRef: answer.policyRef ?? null,
  }

  // 配列（UI CSV の元列）・壊れた JSON は原本を触らない（proposal_json だけに書く）。
  let mergedPayload: string | undefined
  try {
    const parsed: unknown = JSON.parse(raw.rawPayload ?? '{}')
    if (parsed != null && typeof parsed === 'object' && !Array.isArray(parsed)) {
      mergedPayload = JSON.stringify({ ...(parsed as Record<string, unknown>), ...proposal })
    }
  } catch {
    mergedPayload = undefined
  }

  db.update(rawTransactions)
    .set({
      proposalJson: JSON.stringify(proposal),
      ...(mergedPayload !== undefined ? { rawPayload: mergedPayload } : {}),
    })
    .where(eq(rawTransactions.id, raw.id))
    .run()
}

function unclassifiedLines(
  db: DataDb,
  fiscalYearId: number,
  source?: string,
): { lineId: number; entryId: number; text: string; source: string | null }[] {
  const suspenseId = suspenseAccountId(db)

  const rows = db
    .select({
      lineId: journalLines.id,
      entryId: journalEntries.id,
      text: journalEntries.description,
    })
    .from(journalLines)
    .innerJoin(journalEntries, eq(journalLines.entryId, journalEntries.id))
    .where(
      and(
        eq(journalEntries.fiscalYearId, fiscalYearId),
        eq(journalEntries.status, 'draft'),
        eq(journalLines.accountId, suspenseId),
      ),
    )
    .all()
  if (rows.length === 0) return []

  // 由来（連携サービス）は取込元口座＝line_no=1 の補助科目から引く（journalize の起票規約）。
  const originRows = db
    .select({ entryId: journalLines.entryId, sourceType: subAccounts.importSourceType })
    .from(journalLines)
    .innerJoin(subAccounts, eq(journalLines.subAccountId, subAccounts.id))
    .where(and(eq(journalLines.lineNo, 1), inArray(journalLines.entryId, rows.map((r) => r.entryId))))
    .all()
  const sourceByEntry = new Map(originRows.map((r) => [r.entryId, r.sourceType]))

  return rows
    .map((r) => ({ ...r, text: (r.text ?? '').trim(), source: sourceByEntry.get(r.entryId) ?? null }))
    .filter((r) => r.text !== '')
    .filter((r) => !source || r.source === source)
}

/**
 * 分類対象の一覧。同じ文字はまとめる（同じ品名を何度も分類させる意味がない）。
 * 確定履歴は**アプリ側で引いて添える**（外部クライアントに履歴を取りに行かせない）。
 */
export function listUnclassified(
  db: DataDb,
  fiscalYearId: number,
  opts: { source?: string; limit?: number } = {},
): UnclassifiedResult {
  const lines = unclassifiedLines(db, fiscalYearId, opts.source)

  const byText = new Map<string, { count: number; sources: Set<string> }>()
  for (const l of lines) {
    const slot = byText.get(l.text) ?? { count: 0, sources: new Set<string>() }
    slot.count++
    if (l.source) slot.sources.add(l.source)
    byText.set(l.text, slot)
  }

  const all = [...byText.entries()]
    // 件数の多い順＝片付けたときの効きが大きい順
    .sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]))
    .map(([text, slot]) => ({ id: itemId(text), text, count: slot.count, sources: [...slot.sources] }))

  const items = opts.limit != null ? all.slice(0, opts.limit) : all

  // 履歴の lookup は source 単位。**混在するときは全ての由来について引く。**
  // 「最初に出てきた1つ」で済ませると、銀行の履歴で EC の品名を判断させることになり、
  // しかもそれが黙って起きる（当たらない理由が誰にも見えない）。
  const sources = opts.source ? [opts.source] : [...new Set(items.flatMap((i) => i.sources))]
  const hints = sources.flatMap((source) => {
    // その由来の品名だけを渡す（関連プレフィルタが効くのは、渡した品名に対してだから）
    const texts = items.filter((i) => i.sources.includes(source)).map((i) => i.text)
    if (texts.length === 0) return []
    return lookupEcClassification(db, source, texts).candidates.map((c) => ({
      source,
      pattern: c.pattern,
      proposedAccount: c.proposedAccount,
      treatment: c.treatment,
      hitCount: c.hitCount,
      lastUsedAt: c.lastUsedAt,
    }))
  })

  return { items, hints, policy: getPolicy().text, total: all.length }
}

/**
 * 分類を当てる。**確定はしない**（承認は人が UI で行う）。
 * 対応する未確定が無い識別子は適用せず件数で返す（既に人が片付けていた場合も失敗にしない）。
 */
export function applyClassification(
  db: DataDb,
  fiscalYearId: number,
  answers: ClassifyAnswer[],
  opts: { source?: string } = {},
): ClassifyResult {
  const lines = unclassifiedLines(db, fiscalYearId, opts.source)
  const byId = new Map<string, { lineId: number; entryId: number }[]>()
  for (const l of lines) {
    const id = itemId(l.text)
    byId.set(id, [...(byId.get(id) ?? []), { lineId: l.lineId, entryId: l.entryId }])
  }

  let applied = 0
  let unmatched = 0
  const unknownAccounts = new Set<string>()

  // 最大で明細数×2回（journal_lines UPDATE＋raw_transactions 書き戻し）の書き込みになるため
  // 1トランザクションで包む。途中で失敗（並行確定・明細消失など）したとき「一部だけ科目が
  // 当たった」中途半端な状態を残さない（postDepreciation の原子化＝PR#80 と同じ原則）。
  db.transaction((tx) => {
    for (const answer of answers) {
      const targets = byId.get(answer.id)
      if (!targets || targets.length === 0) {
        unmatched++
        continue
      }
      const account = tx
        .select({ id: accounts.id })
        .from(accounts)
        .where(eq(accounts.name, answer.proposedAccount.trim()))
        .all()[0]
      if (!account) {
        // 知らない科目を勝手に作らない・黙って別の科目へ寄せない
        unknownAccounts.add(answer.proposedAccount)
        continue
      }
      for (const target of targets) {
        // draft 限定・科目変更時の税区分再解決の権威は updateLineAccount にある
        updateLineAccount(tx, target.lineId, { accountId: account.id })
        recordProposal(tx, target.entryId, answer)
        applied++
      }
      byId.delete(answer.id)
    }
  })

  return {
    applied,
    unmatched,
    unknownAccounts: [...unknownAccounts],
    remaining: unclassifiedLines(db, fiscalYearId, opts.source).length,
  }
}
