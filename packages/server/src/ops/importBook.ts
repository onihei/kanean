import type { ImportBookResult, ImportMode } from '@kanean/shared'
export type { ImportBookResult }
import fs from 'node:fs'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import { dataDir, tmpDir, bookDbPath, attachmentDir } from '../config.js'
import { migrateBookDb, type DbRouter } from '../db/router.js'
import { books } from '../db/control/schema.js'
import { findBook } from '../books/resolve.js'
import { checkSqliteIntegrity, stamp } from './backup.js'
import { moveDbWithWal, sha256File } from './fsops.js'
import { ULID_RE } from '../db/ids.js'
import { openZip, ZipFormatError, type ZipReader, type ZipReadEntry } from './zip.js'

/**
 * エクスポート zip の取り込み（restorable-export）。exportBook.ts の対であり、
 * **「エクスポートが復元可能である」を成立させる側**。
 *
 * エクスポート zip は帳簿1冊ぶん（DB＋証憑＋manifest）で、**control plane を含まない**
 * （design.md §1: control はその環境の帳簿レジストリであり、持ち出し対象ではない）。
 * したがって data plane を置くだけでは帳簿レジストリに載らず、画面から不可視のままになる。
 * ここが行うのは「置く」ではなく「**登録して**置く」である。
 *
 * ops/restore.ts との違い（design.md §3）:
 *   restore … バックアップ世代（control ＋ 全帳簿）を**同一環境**へ巻き戻す。サーバ停止中の運用作業。
 *   import  … エクスポート zip（帳簿1冊）を**別環境**へ持ち込む。アプリを開いたまま実行できる。
 *
 * 手順は「全部 tmp に組み立てて検証し、通ったものだけを置く」。検証で落ちた時点では
 * $DATA_DIR/books/ に一切触れていないので、既存の帳簿は常に無傷である。
 */

const SHA256_RE = /^[0-9a-f]{64}$/
/** manifest.json をメモリに読む上限（実物は 1KB 未満。桁違いの入力を読む前に弾く）。 */
const MAX_MANIFEST_BYTES = 1024 * 1024
/** 取り込む zip の展開後合計サイズの上限。ディスクを埋め尽くす入力を配置前に止める。 */
const MAX_TOTAL_BYTES = 8 * 1024 * 1024 * 1024

/** 取り込みの扱い。`auto`=衝突したら中止して利用者に選ばせる（既定）。design.md §5。 */
export type { ImportMode }

export interface ImportManifest {
  format: string
  formatVersion: number
  bookId: string
  bookName: string | null
  database: { path: string; sha256: string; byteSize: number }
}

/** 取り込めない入力（壊れた zip・manifest 不備・sha256 不一致）。既存データには触れていない。 */
export class ImportValidationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'ImportValidationError'
  }
}

/**
 * 取り込もうとした bookId が既に登録済み。**黙って置換も採番もしない**ための中断で、
 * 利用者が `new`（別IDで取り込む）か `replace`（明示的に置換）を選ぶまで何もしない。
 */
export class ImportConflictError extends Error {
  constructor(
    readonly bookId: string,
    /** zip 側の帳簿名。 */
    readonly incomingName: string,
    /** 既にこの環境にある帳簿の名前。 */
    readonly existingName: string,
  ) {
    super(`帳簿ID ${bookId} は既に登録されています`)
    this.name = 'ImportConflictError'
  }
}

/** manifest.json を読んで形を検証する。想定外の形は全てここで弾く。 */
function readManifest(zip: ZipReader): ImportManifest {
  const entry = zip.entry('manifest.json')
  if (!entry) {
    throw new ImportValidationError(
      'manifest.json がありません（Kanean のエクスポート zip ではないようです）',
    )
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(zip.readEntry(entry, MAX_MANIFEST_BYTES).toString('utf8'))
  } catch (e) {
    throw new ImportValidationError(`manifest.json を読めません: ${(e as Error).message}`)
  }
  const m = parsed as Partial<ImportManifest> | null
  if (!m || typeof m !== 'object') throw new ImportValidationError('manifest.json の形式が不正です')
  if (m.format !== 'kanean-export') {
    throw new ImportValidationError('Kanean のエクスポート zip ではありません')
  }
  // 未知の新しい版は読まない（知らないフィールドを黙って捨てて取り込んだことにしない）。
  if (m.formatVersion !== 1) {
    throw new ImportValidationError(
      `対応していないエクスポート形式です（formatVersion=${String(m.formatVersion)}）`,
    )
  }
  if (typeof m.bookId !== 'string' || !ULID_RE.test(m.bookId)) {
    throw new ImportValidationError('manifest.json の bookId が不正です')
  }
  const db = m.database
  if (!db || typeof db !== 'object') throw new ImportValidationError('manifest.json に database がありません')
  if (typeof db.sha256 !== 'string' || !SHA256_RE.test(db.sha256)) {
    throw new ImportValidationError('manifest.json の database.sha256 が不正です')
  }
  if (db.path !== `books/${m.bookId}.sqlite`) {
    throw new ImportValidationError('manifest.json の database.path が bookId と一致しません')
  }
  return {
    format: m.format,
    formatVersion: m.formatVersion,
    bookId: m.bookId,
    bookName: typeof m.bookName === 'string' ? m.bookName : null,
    database: { path: db.path, sha256: db.sha256, byteSize: Number(db.byteSize) || 0 },
  }
}

/** zip 内の取り込み対象（DB エントリ＋証憑エントリ）。 */
interface ImportSource {
  dbEntry: ZipReadEntry
  attachPrefix: string
  attachEntries: ZipReadEntry[]
}

/** staging の置き場所。tmp（検証用）と退避先（置換時の復元元）。 */
interface StagePaths {
  stageDir: string
  stagedDb: string
  stagedAttachments: string
  preImportDir: string
}

/** zip から取り込み対象を特定し、展開後サイズを検証する。 */
function readSource(zip: ZipReader, manifest: ImportManifest): ImportSource {
  const dbEntry = zip.entry(manifest.database.path)
  if (!dbEntry) {
    throw new ImportValidationError(`${manifest.database.path} が zip にありません`)
  }
  // 証憑は zip 内で DB と同じ配置（books/{bookId}/attachments/...）に並ぶ。
  const attachPrefix = `books/${manifest.bookId}/attachments/`
  const attachEntries = zip.under(attachPrefix)
  const totalBytes = [dbEntry, ...attachEntries].reduce((sum, e) => sum + e.size, 0)
  if (totalBytes > MAX_TOTAL_BYTES) {
    throw new ImportValidationError('展開後のサイズが大きすぎます')
  }
  return { dbEntry, attachPrefix, attachEntries }
}

/** 取り込み先の帳簿IDと扱いを決める。ここで throw する経路は $DATA_DIR/books/ に未接触。 */
function resolveTarget(
  router: DbRouter,
  manifest: ImportManifest,
  mode: ImportMode,
): { targetBookId: string; outcome: ImportBookResult['outcome'] } {
  const sourceBookId = manifest.bookId
  const existing = findBook(router, sourceBookId)
  let targetBookId = sourceBookId
  let outcome: ImportBookResult['outcome'] = 'same-id'
  if (mode === 'new') {
    targetBookId = ulid()
    outcome = 'new-id'
  } else if (existing) {
    if (mode !== 'replace') {
      throw new ImportConflictError(sourceBookId, manifest.bookName ?? sourceBookId, existing.name)
    }
    outcome = 'replaced'
  }
  // レジストリに無くても data plane のファイルだけが残っている状態（過去の手動コピー・
  // アーカイブ運用の残骸）はありうる。黙って踏まない。
  if (outcome !== 'replaced' && fs.existsSync(bookDbPath(targetBookId))) {
    throw new ImportValidationError(
      `帳簿ファイルが既に存在します（${path.basename(bookDbPath(targetBookId))}）。`
        + '別の帳簿として取り込むか、置換を選んでください',
    )
  }
  return { targetBookId, outcome }
}

/** zip の中身を tmp に展開し、sha256・integrity・スキーマ更新まで検証する（既存データに未接触）。 */
async function stageAndVerify(
  zip: ZipReader,
  manifest: ImportManifest,
  source: ImportSource,
  stage: StagePaths,
): Promise<void> {
  fs.mkdirSync(stage.stageDir, { recursive: true })
  await zip.extractTo(source.dbEntry, stage.stagedDb)

  // sha256 は manifest 由来の完全性検証（CRC-32 は zip 層、こちらはエクスポート時点との突合）。
  const actual = sha256File(stage.stagedDb)
  if (actual !== manifest.database.sha256) {
    throw new ImportValidationError(
      'データベースの sha256 が manifest と一致しません（zip が壊れています）',
    )
  }
  const integrity = checkSqliteIntegrity(stage.stagedDb)
  if (integrity !== 'ok') {
    throw new ImportValidationError(`データベースの整合性検査に失敗しました: ${integrity}`)
  }
  // 旧バージョンで書き出した帳簿を、配置**前**に最新スキーマへ上げる。
  // 失敗しても tmp の中で終わり、$DATA_DIR/books/ は無傷のまま中止できる。
  try {
    migrateBookDb(stage.stagedDb)
  } catch (e) {
    throw new ImportValidationError(`スキーマの更新に失敗しました: ${(e as Error).message}`)
  }

  for (const entry of source.attachEntries) {
    // extractTo は書き込み先を組み立てる前に openZip 側で名前検証済み（'..' を含まない）。
    const rel = entry.name.slice(source.attachPrefix.length)
    await zip.extractTo(entry, path.join(stage.stagedAttachments, rel))
  }
}

/** 置換: 既存の帳簿ファイル一式を preImportDir へ退避する（失敗時の復元元になる）。 */
function moveAside(router: DbRouter, targetBookId: string, preImportDir: string): void {
  // 置換対象が開かれていると、その下でファイルを差し替えることになる（WAL 破損）。先に閉じる。
  router.closeBook(targetBookId)
  if (fs.existsSync(preImportDir)) throw new Error(`退避先が既に存在します: ${preImportDir}`)
  fs.mkdirSync(preImportDir, { recursive: true })
  moveDbWithWal(bookDbPath(targetBookId), preImportDir)
  const oldAttachments = attachmentDir(targetBookId)
  if (fs.existsSync(oldAttachments)) {
    fs.mkdirSync(path.join(preImportDir, targetBookId), { recursive: true })
    fs.renameSync(oldAttachments, path.join(preImportDir, targetBookId, 'attachments'))
  }
}

/** 検証済みの staging を $DATA_DIR へ配置する。置いたパスを placed に積む（失敗時の撤去用）。 */
function placeStaged(
  stage: StagePaths,
  targetBookId: string,
  hasAttachments: boolean,
  placed: string[],
): void {
  // $DATA_DIR/tmp と $DATA_DIR/books は同一FS なので rename（原子的・コピー無し）。
  fs.mkdirSync(path.dirname(bookDbPath(targetBookId)), { recursive: true })
  fs.renameSync(stage.stagedDb, bookDbPath(targetBookId))
  placed.push(bookDbPath(targetBookId))
  if (hasAttachments) {
    fs.mkdirSync(path.dirname(attachmentDir(targetBookId)), { recursive: true })
    fs.renameSync(stage.stagedAttachments, attachmentDir(targetBookId))
    placed.push(attachmentDir(targetBookId))
  }
}

/** 帳簿レジストリへ登録する（restorable-export change の眼目。置くだけでは一覧に載らない）。 */
function register(
  router: DbRouter,
  targetBookId: string,
  outcome: ImportBookResult['outcome'],
  name: string,
  now: string,
): void {
  const control = router.controlDb()
  if (outcome === 'replaced') {
    // 置換は中身の差し替えであって、帳簿の作り直しではない（createdAt は保つ）。
    // アーカイブ済みへ取り込んだ場合は参照できる状態に戻す（archivedAt を解除）。
    control
      .update(books)
      .set({ name, updatedAt: now, archivedAt: null })
      .where(eq(books.id, targetBookId))
      .run()
  } else {
    control.insert(books).values({ id: targetBookId, name, createdAt: now, updatedAt: now }).run()
  }
}

/**
 * 配置の巻き戻し。outcome に関わらず**置いたもの（placed）を撤去**し、置換なら退避から復元する。
 * 撤去しないと、レジストリに載らない孤児 DB が残って画面から不可視のまま、次回の取り込みも
 * 「帳簿ファイルが既に存在します」で塞がる（issue #140。旧実装は置換経路しか巻き戻さなかった）。
 */
function rollbackPlacement(
  placed: string[],
  movedAside: boolean,
  preImportDir: string,
  targetBookId: string,
): void {
  try {
    for (const p of placed) {
      fs.rmSync(p, { recursive: true, force: true })
      // DB 本体なら WAL/SHM の残骸も一緒に消す（次回取り込みの rename を塞がない）。
      if (p.endsWith('.sqlite')) for (const s of ['-wal', '-shm']) fs.rmSync(p + s, { force: true })
    }
    if (movedAside) {
      // 退避まで進んで配置・登録で落ちた場合、元のファイルを戻して「取り込む前」に復帰させる。
      moveDbWithWal(path.join(preImportDir, `${targetBookId}.sqlite`), path.dirname(bookDbPath(targetBookId)))
      const savedAttachments = path.join(preImportDir, targetBookId, 'attachments')
      if (fs.existsSync(savedAttachments)) fs.renameSync(savedAttachments, attachmentDir(targetBookId))
      fs.rmSync(preImportDir, { recursive: true, force: true })
    }
  } catch (e) {
    // 巻き戻しに失敗しても退避物は preImportDir に残っている。場所を必ず伝える。
    const hint = movedAside
      ? `退避データは ${preImportDir} にあります`
      : `取り込み先: ${bookDbPath(targetBookId)}`
    console.error(`[import] 巻き戻しに失敗しました。${hint}`, e)
  }
}

/**
 * エクスポート zip を取り込み、帳簿として開ける状態にする。
 *
 * 手順: 検証（zip/manifest/対象）→ ① tmp で組み立てて検証 → ② 配置 → ③ レジストリ登録。
 * ①までの失敗は既存データに未接触。②③で失敗したら placed の撤去＋（置換なら）退避からの
 * 復元で「取り込む前」へ戻す。
 *
 * @param mode `auto`（既定）は bookId 衝突で ImportConflictError。`new` は別 ULID を採番、
 *             `replace` は既存を `$DATA_DIR/pre-import-{stamp}/` へ退避してから置換する。
 */
export async function importBookData(
  router: DbRouter,
  zipPath: string,
  opts: { mode?: ImportMode; now?: Date } = {},
): Promise<ImportBookResult> {
  const mode = opts.mode ?? 'auto'

  let zip: ZipReader
  try {
    zip = openZip(zipPath)
  } catch (e) {
    if (e instanceof ZipFormatError) throw new ImportValidationError(`zip を読めません: ${e.message}`)
    throw e
  }

  const manifest = readManifest(zip)
  const source = readSource(zip, manifest)
  const { targetBookId, outcome } = resolveTarget(router, manifest, mode)

  const stageDir = path.join(tmpDir(), `import-${randomUUID()}`)
  const stage: StagePaths = {
    stageDir,
    stagedDb: path.join(stageDir, 'book.sqlite'),
    stagedAttachments: path.join(stageDir, 'attachments'),
    preImportDir: path.join(dataDir(), `pre-import-${stamp(opts.now ?? new Date())}`),
  }
  const placed: string[] = []
  let committed = false
  let movedAside = false
  try {
    // ① tmp に組み立てて検証する（ここまでは既存データに一切触れない）
    await stageAndVerify(zip, manifest, source, stage)

    // ② 配置（ここから既存に触れる。失敗したら finally で巻き戻す）
    if (outcome === 'replaced') {
      moveAside(router, targetBookId, stage.preImportDir)
      movedAside = true
    }
    placeStaged(stage, targetBookId, source.attachEntries.length > 0, placed)

    // ③ 帳簿レジストリへ登録
    const now = (opts.now ?? new Date()).toISOString()
    const name = manifest.bookName?.trim() || '取り込んだ帳簿'
    register(router, targetBookId, outcome, name, now)

    committed = true
    return {
      bookId: targetBookId,
      bookName: name,
      sourceBookId: manifest.bookId,
      outcome,
      attachmentCount: source.attachEntries.length,
      preImportDir: outcome === 'replaced' ? stage.preImportDir : null,
    }
  } finally {
    if (!committed) rollbackPlacement(placed, movedAside, stage.preImportDir, targetBookId)
    fs.rmSync(stage.stageDir, { recursive: true, force: true })
  }
}
