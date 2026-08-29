import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DbRouter, type DataDb } from '../../db/router.js'
import { fiscalYears, journalEntries, attachments } from '../../db/data/schema.js'
import { addAttachment, listAttachments, getAttachmentRow, readAttachmentBytes, removeAttachment } from '../service.js'
import { attachmentDir } from '../../config.js'

const USER = '01ARZ3NDEKTSV4RRFFQ69G5FAV' // ULID 形式

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-attsvc-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function setup(): { db: DataDb; entryId: number } {
  const db = new DbRouter().bookDb(USER) // open + migrate + seed
  const fy = db.insert(fiscalYears).values({ startDate: '2024-01-01', endDate: '2024-12-31', status: 'open', createdAt: 'x' }).returning().all()[0]
  const entry = db
    .insert(journalEntries)
    .values({ fiscalYearId: fy.id, entryDate: '2024-03-01', description: 'テスト', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
    .returning()
    .all()[0]
  return { db, entryId: entry.id }
}

describe('証憑サービス（添付の追加・一覧・ダウンロード・削除）', () => {
  it('仕訳に添付を追加し sha256/サイズを記録、メタは storage_path を返さない', () => {
    const { db, entryId } = setup()
    const bytes = Buffer.from('%PDF-1.4 dummy receipt')
    const meta = addAttachment(db, USER, { entryId, fileName: '領収書.pdf', contentType: 'application/pdf', bytes })
    expect(meta).toMatchObject({ fileName: '領収書.pdf', contentType: 'application/pdf', fileSize: bytes.length })
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/)
    expect(Object.keys(meta)).not.toContain('storagePath')

    const list = listAttachments(db, entryId)
    expect(list).toHaveLength(1)
    expect(Object.keys(list[0])).not.toContain('storagePath')

    // ダウンロード経路でバイト一致。
    const row = getAttachmentRow(db, meta.id)!
    expect(readAttachmentBytes(USER, row).equals(bytes)).toBe(true)
  })

  it('存在しない仕訳・非対応形式・空ファイル・ファイル名なしを弾く', () => {
    const { db, entryId } = setup()
    const ok = Buffer.from('x')
    expect(() => addAttachment(db, USER, { entryId: 999999, fileName: 'a.pdf', contentType: 'application/pdf', bytes: ok })).toThrow(/仕訳 .* が見つかりません/)
    expect(() => addAttachment(db, USER, { entryId, fileName: 'a.exe', contentType: 'application/octet-stream', bytes: ok })).toThrow(/対応していないファイル形式/)
    expect(() => addAttachment(db, USER, { entryId, fileName: 'a.pdf', contentType: 'application/pdf', bytes: Buffer.alloc(0) })).toThrow(/空のファイル/)
    expect(() => addAttachment(db, USER, { entryId, fileName: '  ', contentType: 'application/pdf', bytes: ok })).toThrow(/ファイル名が必要/)
  })

  it('一覧は対象仕訳のものだけを返す', () => {
    const { db, entryId } = setup()
    const other = db
      .insert(journalEntries)
      .values({ fiscalYearId: 1, entryDate: '2024-04-01', description: '別', source: 'manual', status: 'confirmed', createdAt: 'x', updatedAt: 'x' })
      .returning()
      .all()[0]
    addAttachment(db, USER, { entryId, fileName: 'a.pdf', contentType: 'application/pdf', bytes: Buffer.from('a') })
    addAttachment(db, USER, { entryId: other.id, fileName: 'b.pdf', contentType: 'application/pdf', bytes: Buffer.from('b') })
    expect(listAttachments(db, entryId)).toHaveLength(1)
    expect(listAttachments(db, entryId)[0].fileName).toBe('a.pdf')
  })

  it('削除でファイルと行が消え、再削除は例外（冪等なファイル削除）', () => {
    const { db, entryId } = setup()
    const meta = addAttachment(db, USER, { entryId, fileName: 'r.png', contentType: 'image/png', bytes: Buffer.from('PNGDATA') })
    const filePath = path.join(attachmentDir(USER), getAttachmentRow(db, meta.id)!.storagePath!)
    expect(fs.existsSync(filePath)).toBe(true)

    removeAttachment(db, USER, meta.id)
    expect(fs.existsSync(filePath)).toBe(false)
    expect(db.select().from(attachments).all()).toHaveLength(0)
    expect(() => removeAttachment(db, USER, meta.id)).toThrow(/見つかりません/)
  })
})
