import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { writeAttachmentFile, readAttachmentFile, deleteAttachmentFile } from '../storage.js'
import { attachmentDir } from '../../config.js'

// ULID 形式（[0-9A-Z]{26}）。storage はこれ以外の bookId を拒否する。
const USER = '01ARZ3NDEKTSV4RRFFQ69G5FAV'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-att-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('証憑ストレージ層（パス安全性・ハッシュ）', () => {
  it('write→read 往復・SHA-256・サイズが正しい／保存名はサーバ生成', () => {
    const bytes = Buffer.from('%PDF-1.4 dummy âþ', 'utf8')
    const stored = writeAttachmentFile(USER, bytes)
    expect(stored.fileSize).toBe(bytes.length)
    expect(stored.sha256).toBe(createHash('sha256').update(bytes).digest('hex'))
    expect(stored.storedName).toMatch(/^[0-9a-f-]{36}$/) // randomUUID（入力ファイル名に依存しない）
    const back = readAttachmentFile(USER, stored.storedName)
    expect(back.equals(bytes)).toBe(true)
    expect(fs.existsSync(path.join(attachmentDir(USER), stored.storedName))).toBe(true)
  })

  it('不正な bookId（traversal/小文字/長さ違い）を拒否する', () => {
    const b = Buffer.from('x')
    expect(() => writeAttachmentFile('../../etc', b)).toThrow(/不正な帳簿ID/)
    expect(() => writeAttachmentFile('abcdefghijklmnopqrstuvwxyz', b)).toThrow(/不正な帳簿ID/) // 小文字
    expect(() => writeAttachmentFile('SHORT', b)).toThrow(/不正な帳簿ID/)
    expect(() => readAttachmentFile('a/b', 'x')).toThrow(/不正な帳簿ID/)
  })

  it('attachmentDir の外へ出る storedName を拒否する', () => {
    expect(() => readAttachmentFile(USER, '../../control.sqlite')).toThrow(/不正なファイルパス/)
    expect(() => readAttachmentFile(USER, '..')).toThrow(/不正なファイルパス/)
    expect(() => deleteAttachmentFile(USER, '../evil')).toThrow(/不正なファイルパス/)
  })

  it('attachments 配下のシンボリックリンクを読取/削除で拒否する（symlink 回避対策）', () => {
    const dir = attachmentDir(USER)
    fs.mkdirSync(dir, { recursive: true })
    const outside = path.join(tmp, 'secret.txt')
    fs.writeFileSync(outside, 'SECRET')
    const linkName = '00000000-0000-0000-0000-000000000000' // UUID 形のリンク名
    fs.symlinkSync(outside, path.join(dir, linkName))
    expect(() => readAttachmentFile(USER, linkName)).toThrow(/不正なファイルパス/)
    expect(() => deleteAttachmentFile(USER, linkName)).toThrow(/不正なファイルパス/)
    // リンク先（外部の機密ファイル）は削除されていない。
    expect(fs.existsSync(outside)).toBe(true)
  })

  it('delete はファイルが無くても冪等（例外を投げない）', () => {
    const stored = writeAttachmentFile(USER, Buffer.from('y'))
    deleteAttachmentFile(USER, stored.storedName)
    expect(fs.existsSync(path.join(attachmentDir(USER), stored.storedName))).toBe(false)
    expect(() => deleteAttachmentFile(USER, stored.storedName)).not.toThrow()
  })
})
