import type { JournalizeSummary } from '@kanean/shared'
export type { JournalizeSummary }
import { SUSPENSE_ACCOUNT } from '../import/precondition.js'
import { and, eq, like } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { requireOpenFiscalYear } from '../db/lookups.js'
import { findAccountIdByName as accountIdByName } from '../db/lookups.js'
import {
  importBatches,
  rawTransactions,
  subAccounts,
  accounts,
  autoJournalRules,
  mappingHistory,
} from '../db/data/schema.js'
import { suggest, type RuleLike, type HistoryLike } from './suggest.js'
import { createTwoLineDraftEntry } from './draftEntry.js'
import { classifyInstitutionEntry } from './institutionRules.js'
import { resolveLineTax } from './lineTax.js'
import { isEcRaw, journalizeEcRow } from '../import/ecImport.js'
import { isBankSkillRaw, journalizeBankRow } from '../import/bankImport.js'
import { assertInFiscalPeriod, isInFiscalPeriod, type FiscalPeriod } from './fiscalPeriod.js'

/**
 * 取込明細（raw_transactions）→ draft 仕訳（journal_entries）。data-model §2.8/§2.9。
 * - 取込元口座（account_ref → linked_account_ref の補助科目）を相手の片側に置く。
 * - もう片側はルール/履歴のサジェスト。無ければ「未確定勘定」（後で確認画面で修正）。
 * - direction: 入金=源泉口座を借方 / 出金=貸方（資産口座の増減）。未払金(カード)も out→貸方で整合。
 * 元帳・試算表・決算は confirmed のみ集計（D-10）。ここでは draft を作る。
 */

interface SourceAccount {
  accountId: number
  subAccountId: number | null
}

/** account_ref（取込元口座識別子）→ 補助科目とその親勘定科目。 */
export function resolveSourceAccount(db: DataDb, accountRef: string): SourceAccount {
  const sub = db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, accountRef)).all()[0]
  if (!sub) {
    throw new Error(`account_ref "${accountRef}" に対応する補助科目が未設定（linked_account_ref を設定してください）`)
  }
  return { accountId: sub.accountId, subAccountId: sub.id }
}

function suspenseAccountId(db: DataDb): number {
  const acc = db.select().from(accounts).where(eq(accounts.name, SUSPENSE_ACCOUNT)).all()[0]
  if (!acc) throw new Error('未確定勘定が見つかりません（シード未投入）')
  return acc.id
}

type RawRow = typeof rawTransactions.$inferSelect

/** 1バッチ分の仕訳化に共通な文脈（口座・年度・ルール/履歴・同日利息日）。バッチ単位で1回だけ構築する。 */
interface JournalizeContext {
  sourceType: string
  source: SourceAccount
  suspense: number
  openYearId: number
  /** 開いている会計年度の範囲。会計期間ゲート（entry_date が範囲内か）に使う。 */
  openPeriod: FiscalPeriod
  rules: RuleLike[]
  history: HistoryLike[]
  interestDates: Set<string>
}

function buildContext(db: DataDb, batch: typeof importBatches.$inferSelect): JournalizeContext {
  if (!batch.accountRef) throw new Error(`batch ${batch.id} に account_ref がありません`)
  const openYear = requireOpenFiscalYear(db)
  // 同一口座(account_ref)で「税引前利息」入金がある日付の集合。利息源泉（国税/地方税）の同日判定に使う
  // （同バッチ・既取込の別バッチをまたいで raw_transactions 全体から拾う。csv-format §3.2）。
  const interestDates = new Set(
    db
      .select({ d: rawTransactions.txnDate })
      .from(rawTransactions)
      .where(and(eq(rawTransactions.accountRef, batch.accountRef), eq(rawTransactions.direction, 'in'), like(rawTransactions.description, '%税引前利息%')))
      .all()
      .map((r) => r.d),
  )
  return {
    sourceType: batch.sourceType,
    source: resolveSourceAccount(db, batch.accountRef),
    suspense: suspenseAccountId(db),
    openYearId: openYear.id,
    openPeriod: { startDate: openYear.startDate, endDate: openYear.endDate },
    rules: db.select().from(autoJournalRules).all() as unknown as RuleLike[],
    history: db.select().from(mappingHistory).all() as unknown as HistoryLike[],
    interestDates,
  }
}

/** 1件の pending 明細を draft 仕訳化する（バッチ・復帰の双方で共有）。 */
function journalizeRow(db: DataDb, raw: RawRow, ctx: JournalizeContext): void {
  // 会計期間ゲート。entry_date に raw.txn_date をそのまま置くため、範囲外なら自分の会計年度の
  // 外に立つ仕訳ができてしまう（試算表には載るが推移表からは落ちる）。呼出側ではなくここで弾く。
  assertInFiscalPeriod(ctx.openPeriod, raw.txnDate, '取込明細の日付')

  const direction = raw.direction as 'in' | 'out'
  const s = suggest(
    { description: raw.description ?? '', amount: raw.amount, direction },
    { rules: ctx.rules, history: ctx.history, sourceType: ctx.sourceType },
  )

  // 相手科目の決定: ユーザールール/履歴（suggest）→ 金融機関固有の既定自動仕訳 → 未確定勘定。
  // ルール・履歴を最優先にして、ユーザーの明示指定/学習を既定より常に優先する。
  let counterAccountId: number
  let counterSub: number | null
  let suggestedTaxId: number | null
  let sourceTag: string
  if (s) {
    counterAccountId = s.accountId
    counterSub = s.subAccountId
    suggestedTaxId = s.taxCategoryId
    sourceTag = 'auto_rule'
  } else {
    const inst = classifyInstitutionEntry(
      { description: raw.description ?? '', direction, txnDate: raw.txnDate },
      { sourceType: ctx.sourceType, hasSameDayInterest: (d) => ctx.interestDates.has(d) },
    )
    const instAccId = inst ? accountIdByName(db, inst.accountName) : null
    counterAccountId = instAccId ?? ctx.suspense
    counterSub = null
    suggestedTaxId = null
    sourceTag = instAccId != null ? 'auto_institution' : 'import'
  }

  // 相手行の税区分（サジェスト優先・無ければ科目/補助の既定）と税額（税込内税逆算）。
  // 既定自動仕訳の相手（事業主借/事業主貸/租税公課）はチャート既定が対象外＝損益外/不課税で正しく解決される。
  const counterResolved = resolveLineTax(db, {
    accountId: counterAccountId,
    subAccountId: counterSub,
    taxCategoryId: suggestedTaxId,
    amount: raw.amount,
  })
  const counterTax = counterResolved.taxCategoryId

  // 取込元口座（資産/負債）の税区分も既定で解決（通常は対象外）。手入力経路と表現を揃える。
  const sourceResolved = resolveLineTax(db, { accountId: ctx.source.accountId, subAccountId: ctx.source.subAccountId, amount: raw.amount })

  // 資産口座の増減: 入金→借方 / 出金→貸方。相手は反対側。
  const sourceSide = direction === 'in' ? 'debit' : 'credit'
  const counterSide = direction === 'in' ? 'credit' : 'debit'

  const entryId = createTwoLineDraftEntry(
    db,
    { fiscalYearId: ctx.openYearId, entryDate: raw.txnDate, description: raw.description, source: sourceTag, sourceRef: String(raw.id) },
    { side: sourceSide, accountId: ctx.source.accountId, subAccountId: ctx.source.subAccountId, tax: sourceResolved, amount: raw.amount },
    { side: counterSide, accountId: counterAccountId, subAccountId: counterSub, tax: counterResolved, amount: raw.amount },
  )

  db.update(rawTransactions)
    .set({
      status: 'journalized',
      journalEntryId: entryId,
      // サジェスト（ルール/履歴）または既定自動仕訳で相手科目が決まった場合に記録（未確定勘定のみ null）。
      suggestedAccountId: sourceTag === 'import' ? null : counterAccountId,
      suggestedSubAccountId: counterSub,
      suggestedTaxCategoryId: counterTax,
    })
    .where(eq(rawTransactions.id, raw.id))
    .run()
}

/** 取込バッチの pending 明細を draft 仕訳化する。 */
export function journalizeBatch(db: DataDb, batchId: number): JournalizeSummary {
  const batch = db.select().from(importBatches).where(eq(importBatches.id, batchId)).all()[0]
  if (!batch) throw new Error(`import batch ${batchId} が見つかりません`)
  if (!batch.accountRef) throw new Error(`batch ${batchId} に account_ref がありません`)

  const ctx = buildContext(db, batch)
  const pending = db
    .select()
    .from(rawTransactions)
    .where(and(eq(rawTransactions.batchId, batchId), eq(rawTransactions.status, 'pending')))
    .all()

  // 会計期間ゲートはループの前に当てる。途中で投げると作り終えた draft が残る（ここは
  // トランザクションで包まれていない）。1件の期間外で全体を落とさず、件数で可視化する。
  const inPeriod = pending.filter((raw) => isInFiscalPeriod(ctx.openPeriod, raw.txnDate))
  for (const raw of inPeriod) journalizeRow(db, raw, ctx)
  return { drafted: inPeriod.length, skippedOutOfPeriod: pending.length - inPeriod.length }
}

/** 単一の pending 明細を draft 仕訳化する（ignored からの復帰で draft を作り直す経路。import/rawStatus）。 */
export function journalizeRawById(db: DataDb, rawId: number): void {
  const raw = db.select().from(rawTransactions).where(eq(rawTransactions.id, rawId)).all()[0]
  if (!raw) throw new Error(`取込明細 ${rawId} が見つかりません`)
  if (raw.status !== 'pending') throw new Error('未仕訳(pending)の明細のみ仕訳化できます')
  // EC（スキル）トラックは銀行 suggest/institution を通さず、raw_payload のAI仕訳候補で再仕訳する（§7.1）。
  if (isEcRaw(db, raw)) {
    journalizeEcRow(db, raw)
    return
  }
  // 銀行スキルトラック（普通預金一脚）も同様に suggest/institution を通さず raw_payload のAI仕訳候補で再仕訳する（§7.1）。
  if (isBankSkillRaw(raw)) {
    journalizeBankRow(db, raw)
    return
  }
  const batch = db.select().from(importBatches).where(eq(importBatches.id, raw.batchId)).all()[0]
  if (!batch) throw new Error(`import batch ${raw.batchId} が見つかりません`)
  journalizeRow(db, raw, buildContext(db, batch))
}
