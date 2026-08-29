import { ingestRow } from './ingest.js'
import { requireLinkedSubAccount, requireOpenFiscalYear, requireSuspenseAccount, SAMPLE_LIMIT } from './precondition.js'
import { eq } from 'drizzle-orm'
import type { DbRouter, DataDb } from '../db/router.js'
import { importBatches, rawTransactions } from '../db/data/schema.js'
import { findAccountIdByName as accountIdByName } from '../db/lookups.js'
import { resolveLineTax } from '../journal/lineTax.js'
import { createTwoLineDraftEntry } from '../journal/draftEntry.js'
import { assertInFiscalPeriod } from '../journal/fiscalPeriod.js'
import { catalogBySourceType } from '../services/catalog.js'
import {
  ecLineToParsedRow,
  ecAdjustmentToParsedRow,
  targetAccountName,
  orderTotalMismatch,
  orderAdjustments,
  parseAdjustmentKind,
  isEcSkillPayload,
  OWNER_DRAW_ACCOUNT,
  OWNER_LOAN_ACCOUNT,
  SHIPPING_ACCOUNT,
  MISC_INCOME_ACCOUNT,
  type EcOrder,
  type EcTreatment,
  type EcAdjustmentKind,
} from './ec.js'

/**
 * EC（Amazon/楽天）仕訳候補の取込（[ec-import-api.md §3] POST ec/journal-candidates）。
 *
 * スキルトラック専用。AIの仕訳候補をそのまま draft 化する（auto_journal_rules/institution は通さない・§7.1）:
 *   借) 費用科目（proposed_account / treatment 由来）  ← AIが分類
 *   貸) 未払金（source のチャネル補助＝クリアリング） ← §4.3 で機械適用
 * 借方を line_no=2 に置くことで、確定時の既存 recordMappingFromEntry が item_name→科目 を学習する（§7.2）。
 *
 * 本体が権威を持つ: 会計期間ゲート（order_date）/ 冪等（source+order_id+line_no）/ 科目検証（未知→未確定勘定＋flag）。
 * 「黙って落とさない」: 期間外・重複・未解決は件数＋明細で返す。
 */

// PreconditionError は import/precondition.ts へ移設（B4=#117）。
export {} from './precondition.js'

export type EcRawRow = typeof rawTransactions.$inferSelect

/** 借方科目の解決結果フラグ（要承認の可視化用）。 */
export type EcCounterFlag = 'unknown' | 'suspense' | 'owner' | null

export interface EcImportArgs {
  /** 投入先の account_ref（連携サービスの linked_account_ref。例 `amazon-1`）。未払金チャネル補助を一意に指す。 */
  accountRef: string
  fileName?: string
  orders: EcOrder[]
}

export interface EcExcluded {
  orderId: string
  lineNo: number
  orderDate: string
}
export interface EcUnresolved {
  orderId: string
  lineNo: number
  itemName: string
  reason: string
}
export interface EcDuplicate {
  orderId: string
  lineNo: number
  itemName: string
}
export interface EcWarning {
  orderId: string
  message: string
}
export interface EcDraftEntry {
  entryId: number
  orderId: string
  lineNo: number
}

export interface EcImportSummary {
  batchId: number
  acceptedLines: number
  draftEntries: EcDraftEntry[]
  skippedDup: number
  duplicates: EcDuplicate[]
  /** 期間外で除外した総件数（繰越後に取込まれることを可視化）。 */
  excludedCount: number
  excludedOutOfPeriod: EcExcluded[]
  unresolved: EcUnresolved[]
  warnings: EcWarning[]
  periodStart: string
  periodEnd: string
}

/** 明細サンプルの返却上限（年度まるごと再投入で応答が肥大しないよう先頭のみ）。 */

/** raw_payload からAI仕訳候補（科目名・treatment）を復元（壊れていても安全側で空）。 */
function parseProposal(rawPayload: string | null): { proposedAccount?: string; treatment?: EcTreatment } {
  if (!rawPayload) return {}
  try {
    const p = JSON.parse(rawPayload) as { proposedAccount?: unknown; treatment?: unknown }
    return {
      proposedAccount: typeof p.proposedAccount === 'string' ? p.proposedAccount : undefined,
      treatment: p.treatment === 'expense' || p.treatment === 'owner_draw' || p.treatment === 'unresolved' ? p.treatment : undefined,
    }
  } catch {
    return {}
  }
}

/**
 * この raw が EC（スキル）トラックか。journalize/restore の経路分岐に使う。
 * payload の track マーカーを第一判定（bank と対称・issue #126 = B14）。マーカー導入前の
 * 既存行は batch.sourceType がカタログ kind='ec' かで判定する（フォールバック＝マイグレーション不要）。
 */
export function isEcRaw(db: DataDb, raw: EcRawRow): boolean {
  if (isEcSkillPayload(raw.rawPayload)) return true
  const batch = db.select({ st: importBatches.sourceType }).from(importBatches).where(eq(importBatches.id, raw.batchId)).all()[0]
  return catalogBySourceType(batch?.st ?? undefined)?.kind === 'ec'
}

/**
 * 注文レベル調整（[csv-format §4.3] 方式B）を draft 起票する。line_no=1 を未払金行にして
 * サービス毎 draft 件数（listDrafts/draftCountsBySubAccount＝line_no=1 の補助科目）に乗せる。
 * - shipping     : 借)雑費 / 貸)未払金（未払金を増やす）
 * - pointsUsed   : 借)未払金 / 貸)事業主借（個人ポイントで肩代わり＝未払金を減らす）
 * - pointsEarned : 借)事業主貸 / 貸)雑収入（未払金に無影響）
 * 科目が見つからなければ未確定勘定＋flag（黙って確定しない）。
 */
function journalizeEcAdjustment(
  db: DataDb,
  raw: EcRawRow,
  kind: EcAdjustmentKind,
  fiscalYearId: number,
  payable: { accountId: number; subAccountId: number },
  suspense: number,
): { entryId: number; counterId: number; flag: EcCounterFlag; wantName: string } {
  const amount = raw.amount
  const resolve = (name: string): { id: number; flag: EcCounterFlag } => {
    const id = accountIdByName(db, name)
    return id == null ? { id: suspense, flag: 'unknown' } : { id, flag: null }
  }
  type AdjLine = { side: 'debit' | 'credit'; accountId: number; subAccountId?: number }
  let line1: AdjLine
  let line2: AdjLine
  let wantName: string
  let flag: EcCounterFlag
  let counterId: number
  if (kind === 'shipping') {
    const exp = resolve(SHIPPING_ACCOUNT)
    wantName = SHIPPING_ACCOUNT
    flag = exp.flag
    counterId = exp.id
    line1 = { side: 'credit', accountId: payable.accountId, subAccountId: payable.subAccountId } // 未払金
    line2 = { side: 'debit', accountId: exp.id } // 雑費
  } else if (kind === 'pointsUsed') {
    const loan = resolve(OWNER_LOAN_ACCOUNT)
    wantName = OWNER_LOAN_ACCOUNT
    flag = loan.flag
    counterId = loan.id
    line1 = { side: 'debit', accountId: payable.accountId, subAccountId: payable.subAccountId } // 未払金（減）
    line2 = { side: 'credit', accountId: loan.id } // 事業主借
  } else {
    const draw = resolve(OWNER_DRAW_ACCOUNT)
    const inc = resolve(MISC_INCOME_ACCOUNT)
    wantName = MISC_INCOME_ACCOUNT
    flag = draw.flag ?? inc.flag
    counterId = inc.id
    line1 = { side: 'debit', accountId: draw.id } // 事業主貸
    line2 = { side: 'credit', accountId: inc.id } // 雑収入
  }
  const tax1 = resolveLineTax(db, { accountId: line1.accountId, subAccountId: line1.subAccountId, amount })
  const tax2 = resolveLineTax(db, { accountId: line2.accountId, amount })
  const entryId = createTwoLineDraftEntry(
    db,
    { fiscalYearId, entryDate: raw.txnDate, description: raw.description, source: 'import', sourceRef: String(raw.id) },
    { side: line1.side, accountId: line1.accountId, subAccountId: line1.subAccountId, tax: tax1, amount },
    { side: line2.side, accountId: line2.accountId, subAccountId: line2.subAccountId, tax: tax2, amount },
  )
  db.update(rawTransactions).set({ status: 'journalized', journalEntryId: entryId, suggestedAccountId: counterId }).where(eq(rawTransactions.id, raw.id)).run()
  return { entryId, counterId, flag, wantName }
}

/**
 * 1件の EC raw を draft 仕訳化する（ecImport の取込時と、ignored→restore の再仕訳の双方で共有）。
 * 借方科目は raw_payload のAI仕訳候補（proposed_account/treatment）から決める＝銀行トラックの
 * suggest/institution は通さない（§7.1）。借)費用(line_no=2) / 貸)未払金(line_no=1)。
 * raw_payload に `adjustment` があれば注文レベル調整として journalizeEcAdjustment に委譲。
 */
export function journalizeEcRow(db: DataDb, raw: EcRawRow): { entryId: number; counterId: number; flag: EcCounterFlag; wantName: string } {
  const open = requireOpenFiscalYear(db)
  // 会計期間ゲート（[[journal]]）。取込時は登録前に弾いているが、restore はここが唯一の壁になる。
  assertInFiscalPeriod(open, raw.txnDate, '取込明細の日付')
  const sub = requireLinkedSubAccount(db, raw.accountRef, `account_ref "${raw.accountRef}" に対応する連携サービスが未登録`)
  const suspense = requireSuspenseAccount(db)
  const payable = { accountId: sub.accountId, subAccountId: sub.id }

  // 注文レベル調整（送料/ポイント）は専用構造で起票する（item の 借)費用/貸)未払金 とは別。restore もここを通る）。
  const adjustment = parseAdjustmentKind(raw.rawPayload)
  if (adjustment) return journalizeEcAdjustment(db, raw, adjustment, open.id, payable, suspense)

  const wantName = targetAccountName(parseProposal(raw.rawPayload))
  let counterId = accountIdByName(db, wantName)
  let flag: EcCounterFlag = null
  if (counterId == null) {
    counterId = suspense
    flag = 'unknown'
  } else if (counterId === suspense) {
    flag = 'suspense'
  } else if (wantName === OWNER_DRAW_ACCOUNT) {
    flag = 'owner'
  }

  const amount = raw.amount
  const counterTax = resolveLineTax(db, { accountId: counterId, amount })
  const payableTax = resolveLineTax(db, { accountId: payable.accountId, subAccountId: payable.subAccountId, amount })
  // line_no=1: 貸)未払金(チャネル) / line_no=2: 借)費用（学習対象＝recordMappingFromEntry）。
  const entryId = createTwoLineDraftEntry(
    db,
    { fiscalYearId: open.id, entryDate: raw.txnDate, description: raw.description, source: 'import', sourceRef: String(raw.id) },
    { side: 'credit', accountId: payable.accountId, subAccountId: payable.subAccountId, tax: payableTax, amount },
    { side: 'debit', accountId: counterId, tax: counterTax, amount },
  )
  db.update(rawTransactions).set({ status: 'journalized', journalEntryId: entryId, suggestedAccountId: counterId }).where(eq(rawTransactions.id, raw.id)).run()
  return { entryId, counterId, flag, wantName }
}

export function ecImport(router: DbRouter, bookId: string, args: EcImportArgs): EcImportSummary {
  const db = router.bookDb(bookId)

  const open = requireOpenFiscalYear(db, '取込前に会計年度を作成してください')
  const { startDate, endDate } = open

  // 貸方の未払金チャネル（account_ref=linked_account_ref に紐づく補助科目）。未登録なら明示エラー。
  const sub = requireLinkedSubAccount(db, args.accountRef, `account_ref "${args.accountRef}" に対応する連携サービスが未登録（連携サービスを登録してください）`)
  // 学習・履歴・dedup のキーは import_source_type（= カタログ key 'amazon' 等。同一ECサイトを account_ref 跨ぎで共有）。
  const sourceType = sub.importSourceType ?? args.accountRef
  requireSuspenseAccount(db)

  const now = new Date().toISOString()
  const totalLines = args.orders.reduce((a, o) => a + o.lines.length, 0)
  const batch = db
    .insert(importBatches)
    .values({ sourceType, accountRef: args.accountRef, fileName: args.fileName ?? null, importedAt: now, rowCount: totalLines, status: 'done' })
    .returning()
    .all()[0]

  const summary: EcImportSummary = {
    batchId: batch.id,
    acceptedLines: 0,
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

  // 1行（明細 or 調整）を原子的に取込む（raw 挿入 → draft 仕訳化）。重複/失敗/未解決は summary に積む。
  // 調整行は reportLineNo=0（明細 line_no と衝突しない）で報告する。
  const ingest = (order: EcOrder, row: ReturnType<typeof ecLineToParsedRow>, reportLineNo: number, reportItemName: string): void => {
    let outcome: { kind: 'dup' } | { kind: 'ok'; result: ReturnType<typeof journalizeEcRow> }
    try {
      outcome = ingestRow(
        db,
        { batchId: batch.id, txnDate: row.txnDate, amount: row.amount, direction: row.direction, description: row.description, rawPayload: row.rawPayload, dedupHash: row.dedupHash, accountRef: args.accountRef, status: 'pending' },
        journalizeEcRow,
      )
    } catch (err) {
      if (summary.warnings.length < SAMPLE_LIMIT) summary.warnings.push({ orderId: order.orderId, message: `行 ${reportLineNo}「${reportItemName}」の取込に失敗: ${(err as Error).message}` })
      return
    }
    if (outcome.kind === 'dup') {
      summary.skippedDup++
      if (summary.duplicates.length < SAMPLE_LIMIT) summary.duplicates.push({ orderId: order.orderId, lineNo: reportLineNo, itemName: reportItemName })
      return
    }
    summary.acceptedLines++
    summary.draftEntries.push({ entryId: outcome.result.entryId, orderId: order.orderId, lineNo: reportLineNo })
    if (summary.unresolved.length < SAMPLE_LIMIT) {
      if (outcome.result.flag === 'unknown') summary.unresolved.push({ orderId: order.orderId, lineNo: reportLineNo, itemName: reportItemName, reason: `科目「${outcome.result.wantName}」が見つからず未確定勘定（要承認）` })
      else if (outcome.result.flag === 'suspense') summary.unresolved.push({ orderId: order.orderId, lineNo: reportLineNo, itemName: reportItemName, reason: '未確定（要承認）' })
      else if (outcome.result.flag === 'owner') summary.unresolved.push({ orderId: order.orderId, lineNo: reportLineNo, itemName: reportItemName, reason: 'owner_draw → 事業主貸（要承認）' })
    }
  }

  const ADJ_REPORT: Record<EcAdjustmentKind, string> = { shipping: '送料・手数料', pointsUsed: 'ポイント利用', pointsEarned: 'ポイント付与' }

  for (const order of args.orders) {
    // 突合警告（Σ明細 + 送料 − 割引 − ポイント利用 ≠ 請求額）。0 なら未払金＝カード請求額。
    const mismatch = orderTotalMismatch(order)
    if (mismatch !== 0 && summary.warnings.length < SAMPLE_LIMIT) {
      summary.warnings.push({ orderId: order.orderId, message: `明細合計（調整反映）と請求額が ${mismatch} 円ずれています` })
    }

    // 会計期間ゲート（order_date。ISO辞書順比較）。範囲外（翌期等）は登録しない（繰越後に取込）。
    const inPeriod = order.orderDate >= startDate && order.orderDate <= endDate

    // 明細: lineAmount は値引き反映後の純額（適格請求書PDFの商品別小計）。そのまま起票。
    order.lines.forEach((line) => {
      if (!inPeriod) {
        summary.excludedCount++
        if (summary.excludedOutOfPeriod.length < SAMPLE_LIMIT) summary.excludedOutOfPeriod.push({ orderId: order.orderId, lineNo: line.lineNo, orderDate: order.orderDate })
        return
      }
      ingest(order, ecLineToParsedRow(sourceType, order, line), line.lineNo, line.itemName)
    })

    // 注文レベル調整（送料=借)雑費 / ポイント利用=貸)事業主借 / ポイント付与=借)事業主貸・貸)雑収入）。
    if (inPeriod) {
      for (const a of orderAdjustments(order)) {
        ingest(order, ecAdjustmentToParsedRow(sourceType, order, a.kind, a.amount), 0, ADJ_REPORT[a.kind])
      }
    }
  }

  // 取込0件（全件重複/期間外）なら空バッチを残さない（取込履歴のノイズ防止）。raws は未挿入なので安全に削除できる。
  if (summary.acceptedLines === 0) {
    db.delete(importBatches).where(eq(importBatches.id, batch.id)).run()
  }

  return summary
}
