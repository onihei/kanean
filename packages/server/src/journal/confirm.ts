import type { DraftOriginSource, DraftOrigin, DraftLineView, DraftView, ListDraftsOpts, BatchConfirmResult } from '@kanean/shared'
export type { DraftOriginSource, DraftOrigin, DraftLineView, DraftView, ListDraftsOpts, BatchConfirmResult }
import { SUSPENSE_ACCOUNT } from '../import/precondition.js'
import { and, eq, gte, inArray, lte } from 'drizzle-orm'
import type { DataDb, DataTx } from '../db/router.js'
import {
  journalEntries,
  journalLines,
  rawTransactions,
  importBatches,
  accounts,
  subAccounts,
  taxCategories,
  mappingHistory,
} from '../db/data/schema.js'
import { resolveLineTax } from './lineTax.js'
import { containsEscaped } from '../db/like.js'

/** draft 仕訳の一覧・編集・確定（web 確認画面用）。確定時に mapping_history を学習。 */

const CONFIDENCES = ['high', 'medium', 'low'] as const

/** 空文字は「情報なし」として null に落とす（UI 側の表示分岐を単純にする）。 */
function strOrNull(v: unknown): string | null {
  return typeof v === 'string' && v !== '' ? v : null
}

/** EC 注文レベル調整行（[import/ec.ts] adjustment）には AI reason が無いので機械的な説明を補う。 */
const EC_ADJUSTMENT_REASON: Record<string, string> = {
  shipping: '注文レベル調整（送料・手数料）',
  pointsUsed: '注文レベル調整（ポイント利用）',
  pointsEarned: '注文レベル調整（ポイント付与）',
}

/**
 * raw_transactions（raw_payload / proposal_json）と journal_entries.source から draft の由来
 * （説明可能性）を復元する。トラック毎に格納位置が違う:
 * - 銀行スキル: payload に track='bank_skill' と reason/confidence/evidenceRef（[import/bank.ts]）
 * - EC スキル : payload に track='ec_skill'（旧世代は orderId）と reason/confidence/evidenceRef（[import/ec.ts]）
 * - UI CSV    : payload は元CSV列の配列で根拠を持たない。entry.source（auto_rule/auto_institution/import）で補う
 * 後付け分類（acquisition classify）の根拠は payload と独立の `proposal_json` にあり、あれば
 * reason/confidence を上書きする（issue #144。CSV 由来 draft はこれが唯一の根拠源）。
 * 壊れた JSON・未知形式でも throw しない（best-effort。レビュー一覧を1行の破損で落とさない）。
 */
export function extractOrigin(rawPayload: string | null, source: string, proposalJson: string | null = null): DraftOrigin {
  let payload: Record<string, unknown> | null = null
  if (rawPayload != null) {
    try {
      const p: unknown = JSON.parse(rawPayload)
      // 配列（UI CSV の元列）やプリミティブはスキル payload ではない → CSV/不明として扱う。
      if (p != null && typeof p === 'object' && !Array.isArray(p)) payload = p as Record<string, unknown>
    } catch {
      payload = null
    }
  }

  // 口座間振替（名寄せ）は**payload より先に**判定する: linkTransfer は bank_skill 由来の raw を
  // source='transfer' の統合 entry へ付け替えるため、payload には元提案の reason/confidence（多くは
  // high）が残っている。それを表示すると振替が「high の AI 仕訳」として一括確定に掃き込まれてしまう。
  // proposal_json も重ねない（振替の統合 entry を AI 仕訳に見せない）。
  if (source === 'transfer') {
    return { source: 'transfer', reason: '口座間振替の名寄せ', confidence: null, evidence: null }
  }

  const base = payloadOrigin(payload, source)

  // 後付け分類の根拠（proposal_json）。スキル形式には payload にも相乗りしていて同値なので
  // どちらを採っても変わらないが、CSV（配列 payload）はここが唯一の置き場（issue #144）。
  if (proposalJson != null) {
    try {
      const p = JSON.parse(proposalJson) as Record<string, unknown>
      const confidence = CONFIDENCES.find((c) => c === p.confidence) ?? null
      const reason = strOrNull(p.reason)
      if (reason != null || confidence != null) {
        return { ...base, reason: reason ?? base.reason, confidence: confidence ?? base.confidence }
      }
    } catch {
      // 壊れた proposal は無視（base を返す）
    }
  }
  return base
}

function payloadOrigin(payload: Record<string, unknown> | null, source: string): DraftOrigin {
  if (payload != null) {
    const confidence = CONFIDENCES.find((c) => c === payload.confidence) ?? null
    const reason = strOrNull(payload.reason)
    const evidence = strOrNull(payload.evidenceRef)
    if (payload.track === 'bank_skill') {
      return { source: 'bank_skill', reason, confidence, evidence }
    }
    // EC は track='ec_skill'（issue #126 で bank と対称化）。マーカーを持たない世代の
    // 既存行は識別子 orderId で拾う（フォールバック＝マイグレーション不要）。
    if (payload.track === 'ec_skill' || typeof payload.orderId === 'string') {
      const adjReason = typeof payload.adjustment === 'string' ? (EC_ADJUSTMENT_REASON[payload.adjustment] ?? null) : null
      return { source: 'ec_skill', reason: reason ?? adjReason, confidence, evidence }
    }
  }

  // スキル payload でない場合は entry.source から由来を補足（CSV トラックはここに落ちる）。
  switch (source) {
    case 'manual':
      return { source: 'manual', reason: null, confidence: null, evidence: null }
    case 'auto_rule':
      return { source: 'csv', reason: '自動仕訳ルール/履歴学習に一致', confidence: null, evidence: null }
    case 'auto_institution':
      return { source: 'csv', reason: '金融機関既定の自動仕訳', confidence: null, evidence: null }
    case 'import':
      return { source: 'csv', reason: null, confidence: null, evidence: null }
    default:
      return { source: 'other', reason: null, confidence: null, evidence: null }
  }
}

/** SQLite のバインド変数上限（環境により 999）を踏まないよう IN 句を分割するためのチャンク。 */
function chunked<T>(items: T[], size: number): T[][] {
  const out: T[][] = []
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size))
  return out
}

/**
 * open 年度の draft 一覧（明細＋科目名＋由来 origin）。
 * opts.subAccountId 指定時は、取込元行(line_no=1)の補助科目が一致する仕訳のみ（連携サービス毎の確認）。
 * journalize は取込元口座を line_no=1・サービスの補助科目で起票する（[journal/journalize.ts]）。
 * 明細・取込明細は entry id で一括取得してメモリ結合する（entry 毎の再クエリ＝N+1 を避ける）。
 */
export function listDrafts(db: DataDb, fiscalYearId: number, opts: ListDraftsOpts = {}): DraftView[] {
  const conds = [eq(journalEntries.fiscalYearId, fiscalYearId), eq(journalEntries.status, 'draft')]
  if (opts.from) conds.push(gte(journalEntries.entryDate, opts.from))
  if (opts.to) conds.push(lte(journalEntries.entryDate, opts.to))
  // 「素の substring 一致」（メタ文字エスケープ）。listEntries と共有（db/like.ts・issue #143）。
  if (opts.q) conds.push(containsEscaped(journalEntries.description, opts.q))

  let entries = db
    .select()
    .from(journalEntries)
    .where(and(...conds))
    .all()

  if (opts.subAccountId != null) {
    const entryIds = new Set(
      db
        .select({ entryId: journalLines.entryId })
        .from(journalLines)
        .where(and(eq(journalLines.lineNo, 1), eq(journalLines.subAccountId, opts.subAccountId)))
        .all()
        .map((r) => r.entryId),
    )
    entries = entries.filter((e) => entryIds.has(e.id))
  }

  // 取込明細（origin の素材）を先に一括取得し、confidence フィルタと limit を**明細取得の前に**
  // 当てる（limit の動機は「全 draft＋全明細＋全 raw を毎回読む」の回避で、明細が最も重い）。
  // 口座間振替（transfer）は out/in の2明細が同一 entry を指す。origin 抽出には先勝ちで1件あれば足りる。
  // journal_entry_id の一括取得には raw_txn_journal_entry_idx が効く。
  const allIds = entries.map((e) => e.id)
  const rawByEntry = new Map<number, { rawPayload: string | null; proposalJson: string | null }>()
  for (const chunk of chunked(allIds, 500)) {
    const raws = db
      .select({ entryId: rawTransactions.journalEntryId, rawPayload: rawTransactions.rawPayload, proposalJson: rawTransactions.proposalJson })
      .from(rawTransactions)
      .where(inArray(rawTransactions.journalEntryId, chunk))
      .all()
    for (const r of raws) if (r.entryId != null && !rawByEntry.has(r.entryId)) rawByEntry.set(r.entryId, { rawPayload: r.rawPayload, proposalJson: r.proposalJson })
  }

  let heads = entries.map((e) => ({
    id: e.id,
    entryDate: e.entryDate,
    description: e.description,
    source: e.source,
    origin: extractOrigin(rawByEntry.get(e.id)?.rawPayload ?? null, e.source, rawByEntry.get(e.id)?.proposalJson ?? null),
  }))
  // confidence は raw_payload/proposal_json 由来なので SQL では絞れない（メモリフィルタ）。
  if (opts.confidence) heads = heads.filter((h) => h.origin.confidence === opts.confidence)
  if (opts.limit != null) heads = heads.slice(0, opts.limit)

  // 明細（＋科目名）は絞り込み後の entry だけ一括取得して結合。
  const ids = heads.map((h) => h.id)
  const linesByEntry = new Map<number, DraftLineView[]>()
  for (const chunk of chunked(ids, 500)) {
    const rows = db
      .select({
        entryId: journalLines.entryId,
        id: journalLines.id,
        lineNo: journalLines.lineNo,
        side: journalLines.side,
        accountId: journalLines.accountId,
        accountName: accounts.name,
        subAccountId: journalLines.subAccountId,
        taxCategoryId: journalLines.taxCategoryId,
        taxAmount: journalLines.taxAmount,
        amount: journalLines.amount,
      })
      .from(journalLines)
      .innerJoin(accounts, eq(journalLines.accountId, accounts.id))
      .where(inArray(journalLines.entryId, chunk))
      .all()
    for (const { entryId, ...l } of rows) {
      const list = linesByEntry.get(entryId) ?? []
      list.push({ ...l, side: l.side as 'debit' | 'credit' })
      linesByEntry.set(entryId, list)
    }
  }

  // 一括取得は entry を跨いで返るため、従来の per-entry クエリと同じ並び（line_no 昇順）に揃える。
  return heads.map((h) => ({ ...h, lines: (linesByEntry.get(h.id) ?? []).sort((a, b) => a.lineNo - b.lineNo) }))
}

/**
 * 1明細の科目/補助/税区分を変更（確認画面での修正）。確定済み明細は変更不可（痕跡なし改変の防止）。
 * **部分更新**: patch に含まれるキーのみ反映する（省略キーは現状維持＝補助科目等を黙って消さない）。
 * - 科目変更時は補助科目を引き継がず（補助は科目固有）、税区分は新科目の既定に追随。
 * - 税区分: 指定あり→明示（null は自動再解決）、指定なし→科目変更なら新既定・変更なしなら現状維持。
 */
export function updateLineAccount(
  db: DataDb | DataTx,
  lineId: number,
  patch: { accountId?: number; subAccountId?: number | null; taxCategoryId?: number | null },
): void {
  const line = db
    .select({
      entryId: journalLines.entryId,
      amount: journalLines.amount,
      accountId: journalLines.accountId,
      subAccountId: journalLines.subAccountId,
      taxCategoryId: journalLines.taxCategoryId,
    })
    .from(journalLines)
    .where(eq(journalLines.id, lineId))
    .all()[0]
  if (!line) throw new Error(`明細 ${lineId} が見つかりません`)
  const entry = db.select({ status: journalEntries.status }).from(journalEntries).where(eq(journalEntries.id, line.entryId)).all()[0]
  if (entry && entry.status !== 'draft') {
    throw new Error('確定済み仕訳の明細は変更できません（確定取消が必要）')
  }

  const accountId = 'accountId' in patch && patch.accountId != null ? patch.accountId : line.accountId
  const accountChanged = accountId !== line.accountId
  // 補助科目: 明示指定があれば従う。無指定なら科目変更時はクリア（補助は科目固有）、不変なら維持。
  const subAccountId = 'subAccountId' in patch ? (patch.subAccountId ?? null) : accountChanged ? null : line.subAccountId
  // 税区分の明示入力: patch指定 > （科目変更なら自動再解決=null）> 現状維持。
  let explicitTax: number | null
  if ('taxCategoryId' in patch) explicitTax = patch.taxCategoryId ?? null
  else explicitTax = accountChanged ? null : line.taxCategoryId

  if (accountChanged) {
    const acc = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.id, accountId)).all()[0]
    if (!acc) throw new Error(`勘定科目 ${accountId} が見つかりません`)
  }
  if (subAccountId != null) {
    const sub = db.select().from(subAccounts).where(eq(subAccounts.id, subAccountId)).all()[0]
    if (!sub) throw new Error(`補助科目 ${subAccountId} が見つかりません`)
    if (sub.accountId !== accountId) throw new Error(`補助科目 ${subAccountId} は勘定科目 ${accountId} に属しません`)
  }
  if (explicitTax != null) {
    const tc = db.select({ id: taxCategories.id }).from(taxCategories).where(eq(taxCategories.id, explicitTax)).all()[0]
    if (!tc) throw new Error(`税区分 ${explicitTax} が見つかりません`)
  }

  const tax = resolveLineTax(db, { accountId, subAccountId, taxCategoryId: explicitTax, amount: line.amount })
  db.update(journalLines)
    .set({ accountId, subAccountId, taxCategoryId: tax.taxCategoryId, taxAmount: tax.taxAmount })
    .where(eq(journalLines.id, lineId))
    .run()
}

function assertBalanced(db: DataDb | DataTx, entryId: number): void {
  const lines = db.select().from(journalLines).where(eq(journalLines.entryId, entryId)).all()
  const debit = lines.filter((l) => l.side === 'debit').reduce((a, l) => a + l.amount, 0)
  const credit = lines.filter((l) => l.side === 'credit').reduce((a, l) => a + l.amount, 0)
  if (debit !== credit) throw new Error(`貸借不一致のため確定不可: 借${debit} ≠ 貸${credit}`)
}

/**
 * draft を確定（confirmed）。取込由来なら mapping_history を学習更新。
 * pattern = 取込明細の摘要、account = 相手科目（取込元口座でない側）。
 * status 更新と履歴学習は1トランザクション: 学習だけ失敗して「確定済みなのに ok:false 報告」
 * という不整合（batch 経由でユーザーが二重起票しかねない）を防ぐ。
 */
export function confirmEntry(db: DataDb, entryId: number): void {
  db.transaction((tx) => {
    const entry = tx.select().from(journalEntries).where(eq(journalEntries.id, entryId)).all()[0]
    if (!entry) throw new Error(`entry ${entryId} が見つかりません`)
    // draft 以外の再確定を弾く: 確定済みへの confirm は updatedAt を無意味に進め、
    // mapping_history の使用回数を重複加算してサジェスト重みを歪める（リトライ・重複IDで顕在化）。
    if (entry.status !== 'draft') throw new Error(`entry ${entryId} は draft ではありません（現在: ${entry.status}）`)
    assertBalanced(tx, entryId)

    const now = new Date().toISOString()
    tx.update(journalEntries).set({ status: 'confirmed', updatedAt: now }).where(eq(journalEntries.id, entryId)).run()

    recordMappingFromEntry(tx, entryId)
  })
}

/**
 * draft の一括確定（例外ベースレビュー）。1件ずつ独立に confirmEntry を呼び、失敗行は
 * エラーメッセージを記録して続行する。
 * あえて全体トランザクションで包まない: 目的は「通るものは確定し、貸借不一致等の例外行だけ
 * レビューに残す」部分成功であり、全体を1トランザクションにすると1件の失敗で健全な数百件まで
 * ロールバックされてしまう。confirmEntry は1件が1トランザクション（status 更新＋履歴学習）
 * なので、行単位の独立実行でも中途半端な状態は生じない。
 * 重複 id は1回だけ処理する（重複分は履歴学習の重複加算を招くため黙って畳む）。
 */
export function confirmEntriesBatch(db: DataDb, entryIds: number[]): BatchConfirmResult[] {
  return [...new Set(entryIds)].map((id) => {
    try {
      confirmEntry(db, id)
      return { id, ok: true }
    } catch (err) {
      return { id, ok: false, error: (err as Error).message }
    }
  })
}

function recordMappingFromEntry(db: DataDb | DataTx, entryId: number): void {
  const raw = db.select().from(rawTransactions).where(eq(rawTransactions.journalEntryId, entryId)).all()[0]
  if (!raw || !raw.description) return
  // 既定自動仕訳（auto_institution）・口座間振替（transfer）は学習しない。いずれも入力（source_type/摘要/口座ペア）から
  // 毎回決定的に再導出されるため履歴は不要で、coarse pattern として焼き付けると誤推測の温床になる:
  // - institution: 「同日利息あり時のみ源泉」の文脈依存マッピングが同日ガードを後続取込で迂回する。
  // - transfer: 振替相手として「自分の出金側口座」を相手科目に焼き付け、振替系摘要を含む明細が自口座へ誤サジェストされる。
  const entry = db.select({ source: journalEntries.source }).from(journalEntries).where(eq(journalEntries.id, entryId)).all()[0]
  if (entry?.source === 'auto_institution' || entry?.source === 'transfer') return
  const batch = db.select().from(importBatches).where(eq(importBatches.id, raw.batchId)).all()[0]
  if (!batch) return

  // 取込元口座（source）= raw.account_ref に紐づく補助科目の親勘定。相手＝それ以外の明細。
  const lines = db.select().from(journalLines).where(eq(journalLines.entryId, entryId)).all()
  // source 側は subAccountId が account_ref 由来。簡便に line_no=2（journalize の相手側）を学習対象とする。
  const counter = lines.find((l) => l.lineNo === 2) ?? lines[lines.length - 1]
  if (!counter) return

  // 未確定勘定は学習しない（item_name/摘要→未確定 を焼き付けると次回の提案が無意味/有害になる）。
  // 事業主貸（私用）はユーザーの明示判断なので学習してよい。
  const suspenseId = db.select({ id: accounts.id }).from(accounts).where(eq(accounts.name, SUSPENSE_ACCOUNT)).all()[0]?.id
  if (counter.accountId === suspenseId) return

  const existing = db
    .select()
    .from(mappingHistory)
    .where(and(eq(mappingHistory.sourceType, batch.sourceType), eq(mappingHistory.pattern, raw.description)))
    .all()[0]

  const now = new Date().toISOString()
  if (existing) {
    db.update(mappingHistory)
      .set({
        accountId: counter.accountId,
        subAccountId: counter.subAccountId,
        taxCategoryId: counter.taxCategoryId,
        hitCount: existing.hitCount + 1,
        lastUsedAt: now,
      })
      .where(eq(mappingHistory.id, existing.id))
      .run()
  } else {
    db.insert(mappingHistory)
      .values({
        sourceType: batch.sourceType,
        pattern: raw.description,
        accountId: counter.accountId,
        subAccountId: counter.subAccountId,
        taxCategoryId: counter.taxCategoryId,
        hitCount: 1,
        lastUsedAt: now,
      })
      .run()
  }
}
