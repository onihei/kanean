import fs from 'node:fs'
import path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import { attachmentDir } from '../config.js'
import { assertValidBookId } from '../db/ids.js'

/**
 * 証憑（添付ファイル）のストレージ層（Phase5 Exit#1・電帳法）。
 * バイナリは DATA_DIR/books/{bookId}/attachments/ 配下に格納する（DB と同じ per-book 物理隔離）。
 *
 * パス安全性（2層）:
 *  1. bookId は ULID 形式（[0-9A-Z]{26}）のみ許可（パストラバーサルを構造的に排除）。
 *     実際は帳簿レジストリ由来（HTTP 層の X-Book-Id 解決）だが多層防御として検証する。
 *  2. 保存ファイル名は**サーバ生成**（randomUUID）でクライアントのファイル名は使わない
 *     （fileName に "../" や絶対パスがあってもディレクトリ外へ出られない）。
 *  読取/削除時は解決後パスが attachmentDir 内に収まることを再検証する（storage_path 列の改竄対策）。
 *
 * 電帳法（真実性確保）の基盤として SHA-256 とバイト数を返し、呼び出し側が永続化する。
 * ⚠️ タイムスタンプ認定（TSA）・保存時暗号化・鍵管理はスコープ外（人間ゲート）。
 */

/** 保存名は randomUUID（v4 形）のみ。区切り文字・".." を構造的に含み得ない＝storage_path 列経由の traversal を排除。 */
const STORED_NAME_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/

export interface StoredFile {
  /** attachmentDir 配下の相対リーフ名（DB の storage_path に保存する値）。 */
  storedName: string
  /** SHA-256（hex）。 */
  sha256: string
  /** バイト数。 */
  fileSize: number
}

function assertSafeBookId(bookId: string): void {
  assertValidBookId(bookId)
}

/** 解決後の target が dir 内（自身は不可）に収まることを保証する。 */
function assertInside(dir: string, target: string): void {
  const base = path.resolve(dir)
  const resolved = path.resolve(target)
  if (resolved === base || !resolved.startsWith(base + path.sep)) {
    throw new Error('不正なファイルパスです')
  }
}

/** bookId と保存名を検証し、attachmentDir 配下の絶対パスを返す（traversal/区切り文字を排除）。 */
function safeDest(bookId: string, storedName: string): string {
  assertSafeBookId(bookId)
  if (!STORED_NAME_RE.test(storedName)) throw new Error('不正なファイルパスです')
  const dir = attachmentDir(bookId)
  const dest = path.join(dir, storedName)
  assertInside(dir, dest) // storedName は UUID 形なので常に内側だが防御的に再確認。
  return dest
}

/**
 * パスがシンボリックリンクなら拒否する（path.resolve は symlink を辿らないため、storage_path 列の
 * 改竄＋FS書込みで attachments 配下に外部を指すリンクを置かれても fs 操作が外へ出ないようにする）。
 * 存在しない場合は read/delete 側で自然に処理されるため無視する。
 */
function assertNotSymlink(dest: string): void {
  let st
  try {
    st = fs.lstatSync(dest)
  } catch {
    return // 不存在等は呼び出し側（readFileSync の ENOENT / rmSync force）で処理。
  }
  if (st.isSymbolicLink()) throw new Error('不正なファイルパスです')
}

/** バイト列を保存し、保存名・SHA-256・サイズを返す。保存名はサーバ生成（クライアント名は使わない）。 */
export function writeAttachmentFile(bookId: string, bytes: Buffer): StoredFile {
  assertSafeBookId(bookId)
  const dir = attachmentDir(bookId)
  fs.mkdirSync(dir, { recursive: true })
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  const storedName = randomUUID()
  const dest = path.join(dir, storedName)
  assertInside(dir, dest) // storedName は自前生成だが防御的に再確認。
  // flag 'wx': 既存パス（＝事前設置されたシンボリックリンク等）があれば失敗させ、リンク越し書込みを防ぐ。
  fs.writeFileSync(dest, bytes, { flag: 'wx' })
  return { storedName, sha256, fileSize: bytes.length }
}

/** 保存済みファイルを読み出す（パスガード付き）。存在しなければ例外。 */
export function readAttachmentFile(bookId: string, storedName: string): Buffer {
  const dest = safeDest(bookId, storedName)
  assertNotSymlink(dest)
  return fs.readFileSync(dest)
}

/** 保存済みファイルを削除する（パスガード付き・存在しなくても無害＝冪等）。 */
export function deleteAttachmentFile(bookId: string, storedName: string): void {
  const dest = safeDest(bookId, storedName)
  assertNotSymlink(dest)
  fs.rmSync(dest, { force: true }) // ENOENT は無視。
}
