import { and, eq, gte, lte } from 'drizzle-orm'
import type { DbRouter, DataDb } from '../db/router.js'
import {
  accounts,
  attachments,
  importBatches,
  journalEntries,
  journalLines,
  rawTransactions,
} from '../db/data/schema.js'
import { findAccountIdByName } from '../db/lookups.js'
import { resolveLineTax } from '../journal/lineTax.js'
import { createTwoLineDraftEntry } from '../journal/draftEntry.js'
import { addAttachmentTo } from '../attachments/service.js'
import { PreconditionError, requireOpenFiscalYear, requireSuspenseAccount } from './precondition.js'

/**
 * レシート取込（skill-import spec「現金レシートの draft 投入」「カード払いレシートの突合候補の提示」）。
 *
 * 撮影の瞬間に付けた**支払手段**で経路が割れる:
 *   現金 → レシートが唯一のソース。draft 仕訳（借 相手科目 / 貸 現金）＋証憑添付を1件として作る
 *   カード → [[acquisition]] が明細を取り込むので**起票しない**。候補を返して人が突合する
 *
 * 銀行・EC と違い、冪等の鍵は出現インデックスではなく**画像の SHA-256**（design D7）。
 * レシートは画像そのものが一意なので、同じ写真を送り直しても仕訳も添付も増えない。
 */

/** レシートの取込元（raw_transactions.account_ref）。銀行・EC の linked_account_ref とは別空間。 */
export const RECEIPT_ACCOUNT_REF = 'receipt'
/** 現金の科目名（シード）。 */
const CASH_ACCOUNT = '現金'
/** 突合候補を探す日付の窓（前後日数）。決済日が数日ずれるカードのために片側 3 日ずつ見る。 */
const MATCH_WINDOW_DAYS = 3
/** 返す候補の上限。自動選択しないので、多すぎるときは人が絞れるだけの数に留める。 */
const MATCH_LIMIT = 20

export interface ReceiptImageInput {
  fileName: string
  contentType: string
  bytes: Buffer
  /** 端末が撮影時に計算した SHA-256。実バイトと食い違う場合は実バイト側を正とする。 */
  sha256: string
}

export interface ReceiptMealInput {
  partySize: number
  participants?: string[]
}

export interface ReceiptImportArgs {
  /** 端末 OCR が読めた日付。欠けていれば起票しない（黙って埋めない）。 */
  transactionDate?: string
  /** 端末 OCR が読めた合計。欠けていれば起票しない。 */
  totalAmount?: number
  merchant?: string
  proposedAccount?: string
  usage?: 'business' | 'prorated' | 'private'
  meal?: ReceiptMealInput
  memo?: string
  image: ReceiptImageInput
}

export type ReceiptSkipReason = 'duplicate' | 'unreadable' | 'out_of_period' | 'unmatched_card'

export type ReceiptImportResult =
  | {
      outcome: 'registered'
      entryId: number
      attachmentId: number
      /** 解決した相手科目名。未知だった場合は未確定勘定の名前が入る。 */
      accountName: string
      date: string
      totalAmount: number
      /** 科目が決まらず未確定勘定へ寄せた場合の理由（黙って確定しない）。 */
      unresolved?: string
    }
  | {
      outcome: 'skipped'
      reason: ReceiptSkipReason
      detail: string
      /** 重複のとき、既に証憑が付いている仕訳を指し示す。 */
      entryId?: number
    }

export interface ReceiptMatchArgs {
  transactionDate: string
  totalAmount: number
  merchant?: string
}

export interface ReceiptMatchCandidate {
  entryId: number
  entryDate: string
  description: string | null
  amount: number
  accountName: string
  status: string
  /** 一致した根拠（人が選ぶための材料。自動では選ばない）。 */
  reasons: string[]
}

export interface ReceiptMatchResult {
  candidates: ReceiptMatchCandidate[]
  /** 候補が上限で切れたか（黙って切らない）。 */
  truncated: boolean
  window: { from: string; to: string }
}

function shiftDate(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + days)
  return d.toISOString().slice(0, 10)
}

/** 撮影時の文脈を摘要に畳む（交際費／会議費の判断材料が仕訳から辿れるようにする）。 */
export function buildReceiptDescription(args: ReceiptImportArgs): string {
  const parts: string[] = [args.merchant?.trim() || 'レシート']
  if (args.meal) {
    const who = args.meal.participants?.filter((p) => p.trim()).join('・')
    parts.push(who ? `${args.meal.partySize}名（${who}）` : `${args.meal.partySize}名`)
  }
  if (args.usage === 'prorated') parts.push('按分')
  if (args.usage === 'private') parts.push('私用')
  if (args.memo?.trim()) parts.push(args.memo.trim())
  return parts.join(' / ').slice(0, 500)
}

/** 現金の科目 id（シード未投入なら 409 相当）。 */
function requireCashAccount(db: DataDb): number {
  const id = findAccountIdByName(db, CASH_ACCOUNT)
  if (id == null)
    throw new PreconditionError('precondition_failed', '現金の科目が見つかりません（シード未投入）')
  return id
}

/** 同じ画像が既に証憑として入っていないか（冪等の鍵）。 */
function findAttachmentBySha256(db: DataDb, sha256: string) {
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.sha256, sha256), eq(attachments.targetType, 'journal_entry')))
    .all()[0]
}

/**
 * 現金レシート 1 件を draft 仕訳＋証憑として取り込む。
 * 画像の検証を**起票より先に**済ませ、添付に失敗したら仕訳と raw ごと巻き戻す
 * （receipt-inbox spec「仕訳と証憑を離ればなれにしない」）。
 */
export function receiptImport(
  router: DbRouter,
  bookId: string,
  args: ReceiptImportArgs,
): ReceiptImportResult {
  const db = router.bookDb(bookId)
  const open = requireOpenFiscalYear(db, '取込前に会計年度を作成してください')
  const suspense = requireSuspenseAccount(db)
  const cashId = requireCashAccount(db)

  // 読めなかったものを黙って埋めない（skill-import spec）。
  const missing: string[] = []
  if (!args.transactionDate) missing.push('transactionDate')
  if (args.totalAmount == null) missing.push('totalAmount')
  if (missing.length > 0) {
    return {
      outcome: 'skipped',
      reason: 'unreadable',
      detail: `読み取れなかった項目があるため起票しない: ${missing.join(', ')}`,
    }
  }
  const date = args.transactionDate as string
  const amount = args.totalAmount as number

  // 冪等（design D7）。同じ画像なら仕訳も添付も作らず、既存の仕訳を指す。
  const existing = findAttachmentBySha256(db, args.image.sha256)
  if (existing) {
    return {
      outcome: 'skipped',
      reason: 'duplicate',
      detail: `同じ画像が仕訳 #${existing.targetId} に添付済み`,
      entryId: existing.targetId,
    }
  }

  if (date < open.startDate || date > open.endDate) {
    return {
      outcome: 'skipped',
      reason: 'out_of_period',
      detail: `${date} は開いている会計年度（${open.startDate}〜${open.endDate}）の外`,
    }
  }

  // 科目解決の権威は本体側。未知は未確定勘定へ寄せて理由を返す（黙って確定しない）。
  const wantName = args.proposedAccount?.trim()
  let counterId = wantName ? findAccountIdByName(db, wantName) : null
  let unresolved: string | undefined
  if (counterId == null) {
    counterId = suspense
    unresolved = wantName
      ? `科目「${wantName}」が勘定科目マスタに無いため未確定勘定へ`
      : '科目の指定が無いため未確定勘定へ'
  }

  const description = buildReceiptDescription(args)
  const now = new Date().toISOString()
  const batch = db
    .insert(importBatches)
    .values({
      sourceType: RECEIPT_ACCOUNT_REF,
      accountRef: RECEIPT_ACCOUNT_REF,
      fileName: args.image.fileName,
      importedAt: now,
      rowCount: 1,
      status: 'done',
    })
    .returning()
    .all()[0]

  const created = db.transaction(() => {
    const raw = db
      .insert(rawTransactions)
      .values({
        batchId: batch.id,
        txnDate: date,
        amount,
        direction: 'out',
        description,
        // 取込時の原本（端末が付けた文脈）。何を根拠に起票したかを後から辿れるようにする。
        rawPayload: JSON.stringify({ track: 'receipt', ...args, image: { ...args.image, bytes: undefined } }),
        dedupHash: args.image.sha256,
        accountRef: RECEIPT_ACCOUNT_REF,
        status: 'pending',
      })
      .onConflictDoNothing()
      .returning()
      .all()[0]
    if (!raw) return null

    // 借) 相手科目(line_no=2 に置くため後段) / 貸) 現金。確定時の学習が摘要→科目を拾えるよう
    // 相手科目を line_no=2 に置く（bankImport と同じ規律）。
    const cashTax = resolveLineTax(db, { accountId: cashId, subAccountId: null, amount })
    const counterTax = resolveLineTax(db, { accountId: counterId, subAccountId: null, amount })
    const entryId = createTwoLineDraftEntry(
      db,
      {
        fiscalYearId: open.id,
        entryDate: date,
        description,
        source: 'import',
        sourceRef: String(raw.id),
      },
      { side: 'credit', accountId: cashId, subAccountId: null, tax: cashTax, amount },
      { side: 'debit', accountId: counterId, subAccountId: null, tax: counterTax, amount },
    )
    db.update(rawTransactions)
      .set({ status: 'journalized', journalEntryId: entryId, suggestedAccountId: counterId })
      .where(eq(rawTransactions.id, raw.id))
      .run()
    return { rawId: raw.id, entryId }
  })

  if (!created) {
    return {
      outcome: 'skipped',
      reason: 'duplicate',
      detail: '同じ画像が取込済み',
    }
  }

  let attachmentId: number
  try {
    const meta = addAttachmentTo(
      db,
      bookId,
      { type: 'journal_entry', id: created.entryId },
      { fileName: args.image.fileName, contentType: args.image.contentType, bytes: args.image.bytes },
    )
    attachmentId = meta.id
  } catch (e) {
    // 証憑が付かない仕訳を残さない。raw ごと巻き戻して再取込できる状態に戻す。
    db.transaction(() => {
      db.delete(journalLines).where(eq(journalLines.entryId, created.entryId)).run()
      db.delete(rawTransactions).where(eq(rawTransactions.id, created.rawId)).run()
      db.delete(journalEntries).where(eq(journalEntries.id, created.entryId)).run()
    })
    throw e
  }

  const accountName =
    db.select().from(accounts).where(eq(accounts.id, counterId)).all()[0]?.name ?? '未確定勘定'
  return {
    outcome: 'registered',
    entryId: created.entryId,
    attachmentId,
    accountName,
    date,
    totalAmount: amount,
    ...(unresolved ? { unresolved } : {}),
  }
}

/**
 * カード払いレシートの突合候補を返す（skill-import spec）。
 * **起票の経路を持たない**。候補が一意に定まっても自動では選ばず、選択は利用者に残す。
 */
export function receiptMatch(
  router: DbRouter,
  bookId: string,
  args: ReceiptMatchArgs,
): ReceiptMatchResult {
  const db = router.bookDb(bookId)
  const from = shiftDate(args.transactionDate, -MATCH_WINDOW_DAYS)
  const to = shiftDate(args.transactionDate, MATCH_WINDOW_DAYS)

  const rows = db
    .select({
      entryId: journalEntries.id,
      entryDate: journalEntries.entryDate,
      description: journalEntries.description,
      status: journalEntries.status,
      amount: journalLines.amount,
      accountName: accounts.name,
      side: journalLines.side,
    })
    .from(journalEntries)
    .innerJoin(journalLines, eq(journalLines.entryId, journalEntries.id))
    .innerJoin(accounts, eq(accounts.id, journalLines.accountId))
    .where(
      and(
        gte(journalEntries.entryDate, from),
        lte(journalEntries.entryDate, to),
        eq(journalLines.amount, args.totalAmount),
      ),
    )
    .all()

  const merchant = args.merchant?.trim()
  const byEntry = new Map<number, ReceiptMatchCandidate>()
  for (const r of rows) {
    // 費用側（借方）の行を代表にする。貸方（未払金カード等）は相手脚なので科目名として見せない。
    if (r.side !== 'debit') continue
    if (byEntry.has(r.entryId)) continue
    const reasons = [`金額一致（${args.totalAmount.toLocaleString('ja-JP')}円）`]
    if (r.entryDate === args.transactionDate) reasons.push('日付一致')
    else reasons.push(`日付が ${MATCH_WINDOW_DAYS} 日以内`)
    if (merchant && r.description && r.description.includes(merchant)) reasons.push('店名一致')
    byEntry.set(r.entryId, {
      entryId: r.entryId,
      entryDate: r.entryDate,
      description: r.description,
      amount: r.amount,
      accountName: r.accountName,
      status: r.status,
      reasons,
    })
  }

  // 店名まで一致したものを先に、次に日付が近い順（人が上から見て選べる並び）。
  const all = [...byEntry.values()].sort((a, b) => {
    const byMerchant = Number(b.reasons.includes('店名一致')) - Number(a.reasons.includes('店名一致'))
    if (byMerchant !== 0) return byMerchant
    const da = Math.abs(Date.parse(a.entryDate) - Date.parse(args.transactionDate))
    const dbb = Math.abs(Date.parse(b.entryDate) - Date.parse(args.transactionDate))
    return da - dbb
  })

  return { candidates: all.slice(0, MATCH_LIMIT), truncated: all.length > MATCH_LIMIT, window: { from, to } }
}
