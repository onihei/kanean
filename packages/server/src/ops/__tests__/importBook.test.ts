import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { DbRouter, migrateControlDb } from '../../db/router.js'
import { books } from '../../db/control/schema.js'
import { fixedAssets } from '../../db/data/schema.js'
import { attachmentDir, bookDbPath } from '../../config.js'
import { listBooks, ensureAtLeastOneBook, archiveBook, createBook } from '../../books/resolve.js'
import { exportBookData } from '../exportBook.js'
import { importBookData, ImportConflictError, ImportValidationError } from '../importBook.js'
import { createZip } from '../zip.js'

/**
 * 取り込み（restorable-export）。この change の起点は「エクスポート zip が復元できない」という
 * 実測欠陥なので、テストの中心は**別 $DATA_DIR への往復**である（electron-desktop-shell §7.5 の経路）。
 */

const BOOK_ID = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

let srcDir: string
let dstDir: string

beforeEach(() => {
  srcDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-import-src-'))
  dstDir = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-import-dst-'))
})
afterEach(() => {
  fs.rmSync(srcDir, { recursive: true, force: true })
  fs.rmSync(dstDir, { recursive: true, force: true })
})

/** 指定 $DATA_DIR に切り替えて control plane を用意し、新しい DbRouter を返す。 */
function openEnv(dir: string): DbRouter {
  process.env.DATA_DIR = dir
  migrateControlDb()
  return new DbRouter()
}

/** 元環境: 帳簿1冊＋固定資産1件＋証憑1件を作り、zip を書き出してそのパスを返す。 */
async function makeExport(opts: { name?: string; attachment?: boolean } = {}): Promise<string> {
  const router = openEnv(srcDir)
  const now = '2026-08-12T00:00:00.000Z'
  router
    .controlDb()
    .insert(books)
    .values({ id: BOOK_ID, name: opts.name ?? 'マツダ商店', createdAt: now, updatedAt: now })
    .run()
  router
    .bookDb(BOOK_ID)
    .insert(fixedAssets)
    .values({
      name: 'マツダ2',
      acquisitionCost: 2_200_000,
      depreciationMethod: 'declining_balance',
      usefulLife: 6,
      createdAt: now,
      updatedAt: now,
    })
    .run()
  if (opts.attachment !== false) {
    const dir = path.join(attachmentDir(BOOK_ID), 'sub')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, '請求書.txt'), 'ネストされた証憑')
  }
  const zipPath = path.join(srcDir, 'export.zip')
  await exportBookData(router, BOOK_ID, zipPath)
  return zipPath
}

describe('importBookData（エクスポートの取り込み）', () => {
  it('別環境へ持ち出して開ける（帳簿レジストリに載り、会計データが一致する）', async () => {
    const zipPath = await makeExport()

    // 取り込み先: 起動済みで自分の帳簿を1冊持っている、ごく普通の環境。
    const dst = openEnv(dstDir)
    ensureAtLeastOneBook(dst)
    expect(listBooks(dst)).toHaveLength(1)

    const result = await importBookData(dst, zipPath)

    expect(result.outcome).toBe('same-id')
    expect(result.bookId).toBe(BOOK_ID)
    expect(result.bookName).toBe('マツダ商店')
    expect(result.attachmentCount).toBe(1)

    // ① 帳簿一覧に現れる（この change の眼目。置くだけでは載らなかった）。
    const listed = listBooks(dst)
    expect(listed.map((b) => b.id)).toContain(BOOK_ID)
    expect(listed.find((b) => b.id === BOOK_ID)?.name).toBe('マツダ商店')

    // ② 会計データが元と一致する。
    const assets = dst.bookDb(BOOK_ID).select().from(fixedAssets).all()
    expect(assets).toHaveLength(1)
    expect(assets[0].name).toBe('マツダ2')
    expect(assets[0].acquisitionCost).toBe(2_200_000)

    // ③ 証憑が配置され、内容も一致する。
    const attachment = path.join(attachmentDir(BOOK_ID), 'sub', '請求書.txt')
    expect(fs.readFileSync(attachment, 'utf8')).toBe('ネストされた証憑')
  })

  it('取り込んだ帳簿は再起動後も残り、空の帳簿を新規作成しない', async () => {
    const zipPath = await makeExport()

    // 帳簿0冊の**まっさらな**環境へ取り込む（別マシンに移した直後）。
    const dst = openEnv(dstDir)
    await importBookData(dst, zipPath)

    // 起動シーケンス（app.ts）を再演する。以前はここで「0冊」と誤判定され空帳簿が生えていた。
    const restarted = openEnv(dstDir)
    ensureAtLeastOneBook(restarted)

    const listed = listBooks(restarted)
    expect(listed).toHaveLength(1)
    expect(listed[0].id).toBe(BOOK_ID)
    expect(restarted.bookDb(BOOK_ID).select().from(fixedAssets).all()).toHaveLength(1)
  })

  it('既に同じ bookId があれば黙って上書きせず中止する', async () => {
    const zipPath = await makeExport()

    const dst = openEnv(dstDir)
    await importBookData(dst, zipPath)
    // 取り込み済みの帳簿に手を入れてから、同じ zip をもう一度取り込む。
    dst.bookDb(BOOK_ID).insert(fixedAssets).values({
      name: 'あとから足した資産',
      acquisitionCost: 100,
      depreciationMethod: 'straight_line',
      createdAt: 'x',
      updatedAt: 'x',
    }).run()

    await expect(importBookData(dst, zipPath)).rejects.toThrow(ImportConflictError)

    // 既存は無傷（2件のまま = 黙って zip の1件で置換されていない）。
    expect(dst.bookDb(BOOK_ID).select().from(fixedAssets).all()).toHaveLength(2)
    expect(listBooks(dst)).toHaveLength(1)
  })

  it('mode=new は別 ULID の帳簿として取り込む（既存はそのまま）', async () => {
    const zipPath = await makeExport()
    const dst = openEnv(dstDir)
    await importBookData(dst, zipPath)

    const result = await importBookData(dst, zipPath, { mode: 'new' })

    expect(result.outcome).toBe('new-id')
    expect(result.bookId).not.toBe(BOOK_ID)
    expect(result.sourceBookId).toBe(BOOK_ID)
    expect(listBooks(dst).map((b) => b.id).sort()).toEqual([BOOK_ID, result.bookId].sort())
    // 中身は独立した2冊（別ファイル）。
    expect(dst.bookDb(result.bookId).select().from(fixedAssets).all()).toHaveLength(1)
    expect(fs.existsSync(bookDbPath(result.bookId))).toBe(true)
    expect(fs.readFileSync(path.join(attachmentDir(result.bookId), 'sub', '請求書.txt'), 'utf8')).toBe(
      'ネストされた証憑',
    )
  })

  it('mode=replace は既存を退避してから置換する（createdAt は保つ）', async () => {
    const zipPath = await makeExport()
    const dst = openEnv(dstDir)
    await importBookData(dst, zipPath)
    const createdAt = listBooks(dst)[0].createdAt
    dst.bookDb(BOOK_ID).insert(fixedAssets).values({
      name: '置換で消える資産',
      acquisitionCost: 100,
      depreciationMethod: 'straight_line',
      createdAt: 'x',
      updatedAt: 'x',
    }).run()

    const result = await importBookData(dst, zipPath, { mode: 'replace' })

    expect(result.outcome).toBe('replaced')
    expect(result.bookId).toBe(BOOK_ID)
    expect(listBooks(dst)).toHaveLength(1)
    expect(listBooks(dst)[0].createdAt).toBe(createdAt) // 作り直しではなく中身の差し替え
    // zip の内容に戻っている（あとから足した資産は消えている）。
    const assets = dst.bookDb(BOOK_ID).select().from(fixedAssets).all()
    expect(assets.map((a) => a.name)).toEqual(['マツダ2'])
    // 置換前のデータは退避されていて取り戻せる。
    expect(result.preImportDir).not.toBeNull()
    expect(fs.existsSync(path.join(result.preImportDir!, `${BOOK_ID}.sqlite`))).toBe(true)
    expect(
      fs.readFileSync(path.join(result.preImportDir!, BOOK_ID, 'attachments', 'sub', '請求書.txt'), 'utf8'),
    ).toBe('ネストされた証憑')
  })

  it('置換の配置中に失敗したら、置換前の状態へ戻す', async () => {
    const zipPath = await makeExport()
    const dst = openEnv(dstDir)
    await importBookData(dst, zipPath)
    // 巻き戻しで戻ってくることを確かめるための目印。
    dst.bookDb(BOOK_ID).insert(fixedAssets).values({
      name: '巻き戻しで戻る資産',
      acquisitionCost: 777,
      depreciationMethod: 'straight_line',
      createdAt: 'x',
      updatedAt: 'x',
    }).run()

    // 退避の後・レジストリ更新の前に落とす（証憑の配置＝配置フェーズの最後の rename）。
    // 巻き戻し自身も同じ宛先へ rename するので、1回だけ失敗させる。
    const realRename = fs.renameSync
    let thrown = false
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (!thrown && to === attachmentDir(BOOK_ID)) {
        thrown = true
        throw new Error('配置中の想定外エラー')
      }
      return realRename(from, to)
    })

    try {
      await expect(importBookData(dst, zipPath, { mode: 'replace' })).rejects.toThrow(/想定外/)
    } finally {
      spy.mockRestore()
    }

    // 帳簿は「取り込む前」に戻っている: 目印の資産も証憑も健在で、退避先は畳まれている。
    expect(listBooks(dst)).toHaveLength(1)
    const names = dst.bookDb(BOOK_ID).select().from(fixedAssets).all().map((a) => a.name)
    expect(names).toContain('巻き戻しで戻る資産')
    expect(fs.readFileSync(path.join(attachmentDir(BOOK_ID), 'sub', '請求書.txt'), 'utf8')).toBe(
      'ネストされた証憑',
    )
    expect(fs.readdirSync(dstDir).filter((f) => f.startsWith('pre-import-'))).toEqual([])
  })

  it('新規取り込みの配置中に失敗したら、置いた分を撤去する（レジストリに載らない孤児 DB を残さない）', async () => {
    const zipPath = await makeExport()
    const dst = openEnv(dstDir)
    ensureAtLeastOneBook(dst)
    const before = listBooks(dst).map((b) => b.id)

    // DB の配置（rename）成功後・証憑の配置で落とす＝「一部だけ置けた」状態を作る。
    const realRename = fs.renameSync
    const spy = vi.spyOn(fs, 'renameSync').mockImplementation((from, to) => {
      if (to === attachmentDir(BOOK_ID)) throw new Error('配置中の想定外エラー')
      return realRename(from, to)
    })
    try {
      await expect(importBookData(dst, zipPath)).rejects.toThrow(/想定外/)
    } finally {
      spy.mockRestore()
    }

    // 旧実装は置換経路しか巻き戻さず、ここで .sqlite が残った。レジストリに載らないため画面から
    // 不可視のまま、次回の取り込みも「帳簿ファイルが既に存在します」で塞がった（issue #140）。
    expect(fs.existsSync(bookDbPath(BOOK_ID))).toBe(false)
    expect(listBooks(dst).map((b) => b.id)).toEqual(before)

    // 塞がっていない＝同じ zip をそのまま取り込み直せる。
    const retry = await importBookData(dst, zipPath)
    expect(retry.outcome).toBe('same-id')
    expect(listBooks(dst).map((b) => b.id)).toContain(BOOK_ID)
    expect(fs.readFileSync(path.join(attachmentDir(BOOK_ID), 'sub', '請求書.txt'), 'utf8')).toBe(
      'ネストされた証憑',
    )
  })

  it('sha256 が合わない zip は取り込まず、既存の帳簿に触れない', async () => {
    const zipPath = await makeExport()
    // manifest の sha256 だけ差し替えた zip を組み立てる（zip としては整合＝CRC は正しい）。
    const good = openEnv(dstDir)
    ensureAtLeastOneBook(good)
    const before = listBooks(good)

    const original = await importBookData(new DbRouter(), zipPath, { mode: 'new' }).catch(() => null)
    expect(original).not.toBeNull() // 前提: 素の zip は取り込める

    const tampered = path.join(dstDir, 'tampered.zip')
    const manifest = {
      format: 'kanean-export',
      formatVersion: 1,
      bookId: BOOK_ID,
      bookName: 'マツダ商店',
      database: { path: `books/${BOOK_ID}.sqlite`, sha256: 'f'.repeat(64), byteSize: 3 },
      fileCount: 2,
    }
    fs.writeFileSync(
      tampered,
      createZip([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        { name: `books/${BOOK_ID}.sqlite`, data: Buffer.from('not-a-db') },
      ]),
    )

    const dst = new DbRouter()
    await expect(importBookData(dst, tampered)).rejects.toThrow(/sha256/)
    // 既存の帳簿構成は増えても減ってもいない（mode=new で足した1冊ぶんのみ）。
    expect(listBooks(dst)).toHaveLength(before.length + 1)
    expect(fs.existsSync(bookDbPath(BOOK_ID))).toBe(false)
  })

  it('manifest.json が無い zip は取り込まない', async () => {
    const dst = openEnv(dstDir)
    ensureAtLeastOneBook(dst)
    const bogus = path.join(dstDir, 'bogus.zip')
    fs.writeFileSync(bogus, createZip([{ name: 'readme.txt', data: Buffer.from('hello') }]))

    await expect(importBookData(dst, bogus)).rejects.toThrow(ImportValidationError)
    await expect(importBookData(dst, bogus)).rejects.toThrow(/manifest\.json/)
    expect(listBooks(dst)).toHaveLength(1)
  })

  it('zip ですらないファイルは取り込まない', async () => {
    const dst = openEnv(dstDir)
    ensureAtLeastOneBook(dst)
    const notZip = path.join(dstDir, 'notzip.bin')
    fs.writeFileSync(notZip, Buffer.alloc(5000, 0x41))

    await expect(importBookData(dst, notZip)).rejects.toThrow(ImportValidationError)
    expect(listBooks(dst)).toHaveLength(1)
  })

  it('整合性検査に通らない DB は配置しない', async () => {
    const dst = openEnv(dstDir)
    ensureAtLeastOneBook(dst)
    // sha256 は正しいが中身が SQLite ではない zip（＝ integrity_check で落ちる経路）。
    const body = Buffer.from('SQLite format 3\0 but truncated garbage')
    const { createHash } = await import('node:crypto')
    const manifest = {
      format: 'kanean-export',
      formatVersion: 1,
      bookId: BOOK_ID,
      bookName: 'こわれた帳簿',
      database: {
        path: `books/${BOOK_ID}.sqlite`,
        sha256: createHash('sha256').update(body).digest('hex'),
        byteSize: body.length,
      },
      fileCount: 2,
    }
    const broken = path.join(dstDir, 'broken.zip')
    fs.writeFileSync(
      broken,
      createZip([
        { name: 'manifest.json', data: Buffer.from(JSON.stringify(manifest)) },
        { name: `books/${BOOK_ID}.sqlite`, data: body },
      ]),
    )

    await expect(importBookData(dst, broken)).rejects.toThrow(ImportValidationError)
    expect(fs.existsSync(bookDbPath(BOOK_ID))).toBe(false)
    expect(listBooks(dst)).toHaveLength(1)
  })

  it('レジストリに無くても data plane ファイルが在れば黙って踏まない', async () => {
    const zipPath = await makeExport()
    const dst = openEnv(dstDir)
    ensureAtLeastOneBook(dst)
    // 手でコピーしただけの孤児ファイル（この change が「自動登録しない」と決めた対象）。
    fs.mkdirSync(path.dirname(bookDbPath(BOOK_ID)), { recursive: true })
    fs.writeFileSync(bookDbPath(BOOK_ID), 'placeholder')

    await expect(importBookData(dst, zipPath)).rejects.toThrow(/既に存在します/)
    expect(fs.readFileSync(bookDbPath(BOOK_ID), 'utf8')).toBe('placeholder')
  })

  it('アーカイブ済み帳簿へ replace で取り込むと参照できる状態に戻る', async () => {
    const zipPath = await makeExport()
    const dst = openEnv(dstDir)
    createBook(dst, 'もう1冊') // 最後の1冊はアーカイブできないため
    await importBookData(dst, zipPath)
    expect(archiveBook(dst, BOOK_ID)).toBe('ok')
    expect(listBooks(dst).map((b) => b.id)).not.toContain(BOOK_ID)

    await importBookData(dst, zipPath, { mode: 'replace' })

    expect(listBooks(dst).map((b) => b.id)).toContain(BOOK_ID)
  })

  it('取り込み後に $DATA_DIR/tmp の作業ディレクトリを残さない', async () => {
    const zipPath = await makeExport()
    const dst = openEnv(dstDir)
    await importBookData(dst, zipPath)
    const leftovers = fs.readdirSync(path.join(dstDir, 'tmp')).filter((f) => f.startsWith('import-'))
    expect(leftovers).toEqual([])
  })
})
