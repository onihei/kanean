import type { AttachmentMeta } from '@kanean/shared'
export type { AttachmentMeta }
import { and, eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { attachments, journalEntries } from '../db/data/schema.js'
import { writeAttachmentFile, readAttachmentFile, deleteAttachmentFile } from './storage.js'

/**
 * 証憑（添付）サービス（Phase5 Exit#1・電帳法）。仕訳（journal_entry）に領収書等を添付する。
 * ストレージ層（storage.ts）でファイルを per-user ディレクトリへ保存し、メタを attachments へ記録。
 *
 * 対象は journal_entry のみ（document への添付はスコープ外）。
 * ⚠️ legalRisk:high — 電帳法の保存要件（検索要件・訂正削除履歴・タイムスタンプ相当・見読性）の
 *    充足判断は申告者/税理士の責任。本実装は真実性確保の基盤（SHA-256・サイズ・検索インデックス）を
 *    用意するのみで「電帳法準拠」をシステムが宣言しない。
 */

/** 添付先（attachments.target_type）。存在検証は各ドメインの呼び出し側が行う。 */
export type AttachmentTargetType = 'journal_entry' | 'filing_record'
const TARGET = 'journal_entry'
/** 受理する MIME（領収書・請求書の一般形式）。クライアント申告値ゆえ厳密判定ではない。 */
const ALLOWED_CONTENT_TYPES = new Set(['application/pdf', 'image/jpeg', 'image/png', 'image/heic', 'image/heif'])
/** 1ファイルの上限（20MB）。 */
const MAX_FILE_SIZE = 20 * 1024 * 1024

type AttachmentRow = typeof attachments.$inferSelect

function toMeta(row: AttachmentRow): AttachmentMeta {
  return { id: row.id, fileName: row.fileName, contentType: row.contentType, fileSize: row.fileSize, sha256: row.sha256, uploadedAt: row.uploadedAt }
}

export interface AttachmentFileInput {
  fileName: string
  contentType: string
  bytes: Buffer
}

/**
 * 任意の対象へ証憑を添付する（形式・サイズ制約＋ファイル保存＋メタ記録の共通実体）。
 * 対象行の存在検証は呼び出し側の責務（仕訳= addAttachment / 完了記録= filing サービス）。
 */
export function addAttachmentTo(
  db: DataDb,
  bookId: string,
  target: { type: AttachmentTargetType; id: number },
  input: AttachmentFileInput,
): AttachmentMeta {
  const fileName = input.fileName?.trim()
  if (!fileName) throw new Error('ファイル名が必要です')
  if (!input.contentType || !ALLOWED_CONTENT_TYPES.has(input.contentType)) {
    throw new Error('対応していないファイル形式です（PDF / JPEG / PNG / HEIC のみ）')
  }
  if (input.bytes.length === 0) throw new Error('空のファイルです')
  if (input.bytes.length > MAX_FILE_SIZE) throw new Error('ファイルサイズが上限（20MB）を超えています')

  const stored = writeAttachmentFile(bookId, input.bytes)
  let row: AttachmentRow
  try {
    row = db
      .insert(attachments)
      .values({
        targetType: target.type,
        targetId: target.id,
        fileName,
        storagePath: stored.storedName,
        contentType: input.contentType,
        sha256: stored.sha256,
        fileSize: stored.fileSize,
        uploadedAt: new Date().toISOString(),
      })
      .returning()
      .all()[0]
  } catch (err) {
    // DB 記録に失敗したら書き込んだファイルを残さない（孤児ファイル防止）。
    deleteAttachmentFile(bookId, stored.storedName)
    throw err
  }
  return toMeta(row)
}

export interface AddAttachmentInput extends AttachmentFileInput {
  entryId: number
}

/** 仕訳に証憑を添付する（ファイル保存＋メタ記録）。 */
export function addAttachment(db: DataDb, bookId: string, input: AddAttachmentInput): AttachmentMeta {
  const entry = db.select({ id: journalEntries.id }).from(journalEntries).where(eq(journalEntries.id, input.entryId)).all()[0]
  if (!entry) throw new Error(`仕訳 ${input.entryId} が見つかりません`)
  return addAttachmentTo(db, bookId, { type: TARGET, id: input.entryId }, input)
}

/** 対象に紐づく証憑メタの一覧（storage_path は返さない）。 */
export function listAttachmentsFor(db: DataDb, target: { type: AttachmentTargetType; id: number }): AttachmentMeta[] {
  return db
    .select()
    .from(attachments)
    .where(and(eq(attachments.targetType, target.type), eq(attachments.targetId, target.id)))
    .all()
    .map(toMeta)
}

/** 仕訳に紐づく証憑メタの一覧（storage_path は返さない）。 */
export function listAttachments(db: DataDb, entryId: number): AttachmentMeta[] {
  return listAttachmentsFor(db, { type: TARGET, id: entryId })
}

/** ダウンロード用に1件の行（storage_path 含む）を取得する。 */
export function getAttachmentRow(db: DataDb, id: number): AttachmentRow | undefined {
  return db.select().from(attachments).where(eq(attachments.id, id)).all()[0]
}

/** ファイル読み出し（パスガードは storage 層）。 */
export function readAttachmentBytes(bookId: string, row: AttachmentRow): Buffer {
  if (!row.storagePath) throw new Error('ファイルの保存先が記録されていません')
  return readAttachmentFile(bookId, row.storagePath)
}

/** 証憑を削除する（ファイル→DB行の順。ファイルは冪等削除）。 */
export function removeAttachment(db: DataDb, bookId: string, id: number): void {
  const row = getAttachmentRow(db, id)
  if (!row) throw new Error(`添付 ${id} が見つかりません`)
  if (row.storagePath) deleteAttachmentFile(bookId, row.storagePath)
  db.delete(attachments).where(eq(attachments.id, id)).run()
}
