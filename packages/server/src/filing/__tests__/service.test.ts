import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { DbRouter, type DataDb } from '../../db/router.js'
import { seedDataPlane } from '../../db/data/seed.js'
import { fiscalYears, journalEntries } from '../../db/data/schema.js'
import type { BookVariables } from '../../books/middleware.js'
import { apiErrorHandler } from '../../http/errors.js'
import { filingRoutes } from '../../http/routes/filing.js'
import { filingPrecheck, buildFilingSheet, createFilingRecord, listFilingRecords, deleteFilingRecord, addFilingAttachment } from '../service.js'
import { attachmentDir } from '../../config.js'

/**
 * filing spec のサービス/ルート検証。
 * precheck は「提出可能」を語彙に持たない・入力指示書は空帳簿でも組める・
 * 完了記録は複数持てて添付ごと削除できる、を固定する。
 */

// attachments のパスガード（assertValidBookId）を通る ULID 形式。
const BOOK = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-filing-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function setup(withYear = true): { app: Hono<{ Variables: BookVariables }>; db: DataDb } {
  const router = new DbRouter()
  const db = router.bookDb(BOOK)
  seedDataPlane(db)
  if (withYear) {
    db.insert(fiscalYears).values({ startDate: '2026-01-01', endDate: '2026-12-31', status: 'open', createdAt: '2026-01-01T00:00:00Z' }).run()
  }
  const app = new Hono<{ Variables: BookVariables }>()
  app.onError(apiErrorHandler)
  app.use('*', (c, next) => {
    c.set('bookId', BOOK)
    return next()
  })
  app.route('/api', filingRoutes(router))
  return { app, db }
}

const fyIdOf = (db: DataDb): number => db.select().from(fiscalYears).all()[0].id

describe('filingPrecheck', () => {
  it('空帳簿では blocking が無く、所得控除未入力の warning を返す', () => {
    const { db } = setup()
    const pre = filingPrecheck(db, fyIdOf(db))
    expect(pre.year).toBe(2026)
    expect(pre.issues.filter((i) => i.level === 'blocking')).toEqual([])
    expect(pre.issues.map((i) => i.code)).toContain('deduction_inputs_missing')
    expect(pre.draftCount).toBe(0)
  })

  it('提出可能の宣言を持たない（判定はメッセージにも真偽値にも現れない）', () => {
    const { db } = setup()
    const pre = filingPrecheck(db, fyIdOf(db))
    // 判定フィールドは issues / draftCount のみ（ready / submittable のような宣言を持たない）
    expect(Object.keys(pre).sort()).toEqual(['disclaimer', 'draftCount', 'fiscalYearId', 'issues', 'year'])
    expect(JSON.stringify(pre.issues)).not.toContain('提出可能')
    expect(pre.disclaimer).toContain('「提出可能」を意味しません')
    expect(pre.disclaimer).toContain('税理士')
  })

  it('draft 仕訳があれば件数付き warning になる', () => {
    const { db } = setup()
    const fyId = fyIdOf(db)
    db.insert(journalEntries)
      .values({ fiscalYearId: fyId, entryDate: '2026-02-01', description: 'd', source: 'import', status: 'draft', createdAt: 'x', updatedAt: 'x' })
      .run()
    const pre = filingPrecheck(db, fyId)
    expect(pre.draftCount).toBe(1)
    const issue = pre.issues.find((i) => i.code === 'drafts_pending')
    expect(issue?.level).toBe('warning')
    expect(issue?.message).toContain('1 件')
    expect(issue?.screen).toBe('raw')
  })
})

describe('buildFilingSheet', () => {
  it('空帳簿でも画面グループ順（A→B→C）で組め、checksum は 0 になる', () => {
    const { db } = setup()
    const sheet = buildFilingSheet(db, fyIdOf(db))
    expect(sheet.year).toBe(2026)
    const ids = sheet.groups.map((g) => g.id)
    expect(ids.slice(0, 6)).toEqual(['A1', 'A2', 'A3', 'A4', 'A5', 'A6'])
    expect(ids).toContain('B4')
    // 既定は簡易課税 → C 群を含む
    expect(sheet.consumptionApplicable).toBe(true)
    expect(ids).toContain('C4')
    expect(sheet.checksum.incomeTaxPayable).toBe(0)
    expect(sheet.checksum.consumptionTotal).toBe(0)
  })
})

describe('完了記録', () => {
  it('作成→一覧→控え添付→添付ごと削除が一巡する（同一年分複数可）', () => {
    const { db } = setup()
    const fyId = fyIdOf(db)
    const r1 = createFilingRecord(db, fyId, {
      taxKind: 'income_tax',
      method: 'corner_etax',
      submittedOn: '2027-03-10',
      receiptNumber: '20270310123456789012',
    })
    const r2 = createFilingRecord(db, fyId, { taxKind: 'consumption', method: 'corner_etax', submittedOn: '2027-03-10' })
    expect(listFilingRecords(db)).toHaveLength(2)
    expect(listFilingRecords(db, 2026)).toHaveLength(2)
    expect(listFilingRecords(db, 2025)).toHaveLength(0)

    const meta = addFilingAttachment(db, BOOK, r1.id, {
      fileName: '申告書控え.pdf',
      contentType: 'application/pdf',
      bytes: Buffer.from('%PDF-1.4 test'),
    })
    expect(meta.sha256).toMatch(/^[0-9a-f]{64}$/)
    const listed = listFilingRecords(db).find((r) => r.id === r1.id)
    expect(listed?.attachments).toHaveLength(1)
    expect(fs.readdirSync(attachmentDir(BOOK))).toHaveLength(1)

    deleteFilingRecord(db, BOOK, r1.id)
    expect(listFilingRecords(db).map((r) => r.id)).toEqual([r2.id])
    expect(fs.readdirSync(attachmentDir(BOOK))).toHaveLength(0)
  })

  it('存在しない記録への添付・削除はエラーになる', () => {
    const { db } = setup()
    expect(() => addFilingAttachment(db, BOOK, 999, { fileName: 'a.pdf', contentType: 'application/pdf', bytes: Buffer.from('x') })).toThrow(
      '見つかりません',
    )
    expect(() => deleteFilingRecord(db, BOOK, 999)).toThrow('見つかりません')
  })

  it('添付の形式・サイズ制約は attachments と同一（テキストは拒否）', () => {
    const { db } = setup()
    const r = createFilingRecord(db, fyIdOf(db), { taxKind: 'income_tax', method: 'paper', submittedOn: '2027-03-01' })
    expect(() => addFilingAttachment(db, BOOK, r.id, { fileName: 'a.txt', contentType: 'text/plain', bytes: Buffer.from('x') })).toThrow(
      '対応していないファイル形式',
    )
  })
})

describe('filing ルート', () => {
  it('open 年度なし: 参照系は 200 + null、記録作成は 400', async () => {
    const { app } = setup(false)
    const pre = await app.request('/api/filing/precheck')
    expect(pre.status).toBe(200)
    expect(await pre.json()).toEqual({ precheck: null })
    const sheet = await app.request('/api/filing/instruction-sheet')
    expect(sheet.status).toBe(200)
    expect(await sheet.json()).toEqual({ sheet: null })
    const post = await app.request('/api/filing/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taxKind: 'income_tax', method: 'paper', submittedOn: '2027-03-01' }),
    })
    expect(post.status).toBe(400)
  })

  it('不正な入力を 400 で拒否する（taxKind / method / submittedOn / year）', async () => {
    const { app } = setup()
    const bad = async (body: object) =>
      (
        await app.request('/api/filing/records', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(body),
        })
      ).status
    expect(await bad({ taxKind: 'gift_tax', method: 'paper', submittedOn: '2027-03-01' })).toBe(400)
    expect(await bad({ taxKind: 'income_tax', method: 'fax', submittedOn: '2027-03-01' })).toBe(400)
    expect(await bad({ taxKind: 'income_tax', method: 'paper', submittedOn: '3/1' })).toBe(400)
    expect((await app.request('/api/filing/records?year=abc')).status).toBe(400)
  })

  it('記録の作成と添付が HTTP 経由で一巡する', async () => {
    const { app } = setup()
    const created = await app.request('/api/filing/records', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ taxKind: 'income_tax', method: 'corner_etax', submittedOn: '2027-03-10', receiptNumber: 'R123' }),
    })
    expect(created.status).toBe(200)
    const { record } = (await created.json()) as { record: { id: number } }
    const attached = await app.request(`/api/filing/records/${record.id}/attachments?fileName=${encodeURIComponent('控え.pdf')}`, {
      method: 'POST',
      headers: { 'content-type': 'application/pdf' },
      body: '%PDF-1.4 x',
    })
    expect(attached.status).toBe(200)
    const list = (await (await app.request('/api/filing/records')).json()) as { records: { attachments: unknown[] }[] }
    expect(list.records[0].attachments).toHaveLength(1)
    const del = await app.request(`/api/filing/records/${record.id}`, { method: 'DELETE' })
    expect(del.status).toBe(200)
    expect(((await (await app.request('/api/filing/records')).json()) as { records: unknown[] }).records).toHaveLength(0)
  })
})
