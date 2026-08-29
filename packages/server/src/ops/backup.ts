import fs from 'node:fs'
import path from 'node:path'
import Database from 'better-sqlite3'
import { drizzle } from 'drizzle-orm/better-sqlite3'
import { eq } from 'drizzle-orm'
import { dataDir, controlDbPath, attachmentDir, booksDir } from '../config.js'
import { openSqlite, listBookDbFiles, type ControlDb } from '../db/router.js'
import * as controlSchema from '../db/control/schema.js'
import { assertControlDbExists } from './guards.js'
import { SQLITE_RE } from './fsops.js'

const { backupStatus } = controlSchema

/**
 * バックアップ（運用基盤・roadmap Phase5 Exit#4）。control plane と全 data plane を
 * **WAL 整合のオンラインバックアップ**（better-sqlite3 `.backup()`）で `$DATA_DIR/backups/{timestamp}/`
 * へスナップショットする。各スナップショットは integrity_check で検証し（破損DBを「成功」として
 * 保存しない）、帳簿ごとの証憑実ファイル（`books/{id}/attachments/`）も同梱する。
 * 世代保持（既定30）で古いセットを削除し、`backup_status` に帳簿ごとの結果を記録。
 *
 * control は **data plane の後にバックアップ**する（この run の backup_status をスナップショットへ含めるため）。
 * 全 DB が失敗した run はディレクトリごと破棄し、世代保持で正常な旧バックアップを退避させない。
 * 復元は ops/restore.ts（CLI `pnpm --filter @kanean/server restore`）。
 *
 * 自動化は月次 cron ＋ deploy.sh の migrate 前実行（architecture §12）。メール通知は別途（未実装）。
 * 暗号化（保存時）・鍵管理は人間決定でスコープ外（architecture A-3）。
 */

const DEFAULT_RETENTION = 30
/**
 * バックアップディレクトリ名（ISO をFS安全化・辞書順＝時刻順）。restore（ops/restore.ts）と共用。
 * `-deploy` 接尾辞は deploy 前バックアップ（cron 世代と保持プールを分ける。下記 kind 参照）。
 */
export const STAMP_RE = /^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}(-deploy)?$/

/**
 * バックアップの種別。世代保持（prune）は同種のセットだけを数える:
 * deploy が頻発しても cron（長期の復元点）を追い出さない・逆も然り。
 */
export type BackupKind = 'cron' | 'deploy'

export interface BackupOutcome {
  ok: boolean
  error?: string
}
export interface BackupResult {
  backupDir: string
  timestamp: string
  control: BackupOutcome
  books: ({ bookId: string } & BackupOutcome)[]
  /** 世代保持で削除した古いセット（ディレクトリ名）。 */
  prunedSets: string[]
}

/** タイムスタンプ（FS安全・辞書順ソート可能）。例 2026-06-03T08-30-00-000。restore と共用。 */
export function stamp(d: Date): string {
  return d.toISOString().replace(/[:.]/g, '-').replace('Z', '')
}

/**
 * PRAGMA integrity_check の結果を返す（正常なら 'ok'）。開けない・SQLiteでない場合も
 * throw せずエラーメッセージを返す（呼び出し側は 'ok' 比較だけで済む）。restore と共用。
 * readonly で開かない理由: WAL フラグ付き DB の readonly オープンは -wal/-shm を生成した上で
 * close 後も削除しない（検証がスナップショットに残骸を植え付ける）。rw オープンは close 時に
 * チェックポイント＋削除して単一ファイルに戻る。
 */
export function checkSqliteIntegrity(file: string): string {
  let db: Database.Database | undefined
  try {
    db = new Database(file, { fileMustExist: true })
    const rows = db.pragma('integrity_check') as { integrity_check: string }[]
    return rows.map((r) => r.integrity_check).join('; ')
  } catch (e) {
    return (e as Error).message
  } finally {
    db?.close()
  }
}

/**
 * 1つの SQLite をオンラインバックアップ（WAL整合）で dest へコピーし、コピー結果を
 * integrity_check で検証する。失敗時は破損した dest を残さない。
 * `.backup()` はページ単位の生コピーで、元DBが静かに破損していても「成功」してしまうため、
 * 検証なしでは破損スナップショットが世代保持枠を埋めて健全な旧世代を追い出しかねない。
 */
async function backupOne(srcFile: string, destFile: string): Promise<void> {
  let src: Database.Database | undefined
  try {
    src = new Database(srcFile)
    await src.backup(destFile)
    const integrity = checkSqliteIntegrity(destFile)
    if (integrity !== 'ok') throw new Error(`integrity_check: ${integrity}`)
  } catch (e) {
    // 途中失敗・不正DB等で生じた中途半端な出力を残さない（後続の prune が壊れたファイルを温存しない）。
    try {
      fs.rmSync(destFile, { force: true })
    } catch {
      /* ignore */
    }
    throw e
  } finally {
    src?.close()
  }
}

/** backup_status に帳簿ごとの最新結果を記録する（bookId ごとに1行＝洗い替え）。失敗しても本処理は止めない。 */
function recordStatus(control: ControlDb, bookId: string, outcome: BackupOutcome, dir: string, at: string): void {
  try {
    control.delete(backupStatus).where(eq(backupStatus.bookId, bookId)).run()
    control
      .insert(backupStatus)
      .values({ bookId, lastBackupAt: at, lastStatus: outcome.ok ? 'success' : 'failed', destination: dir, detail: outcome.error ?? null })
      .run()
  } catch (e) {
    // 状態記録の失敗（例: control.books に該当行が無い孤立DB）はバックアップ自体の成否に影響させないが、可視化する。
    console.warn(`[backup] backup_status の記録に失敗 (book ${bookId}): ${(e as Error).message}`)
  }
}

/**
 * 古いバックアップセットを retention 件残して削除する（タイムスタンプ形のディレクトリのみ対象）。
 * **同じ kind のセットだけ**を数える: deploy 連発が月次 cron の長期復元点を追い出さないため。
 */
function pruneOldBackups(root: string, retention: number, kind: BackupKind): string[] {
  if (retention <= 0 || !fs.existsSync(root)) return []
  const isDeploy = kind === 'deploy'
  const dirs = fs
    .readdirSync(root, { withFileTypes: true })
    .filter((d) => d.isDirectory() && STAMP_RE.test(d.name) && d.name.endsWith('-deploy') === isDeploy)
    .map((d) => d.name)
    .sort()
  const toPrune = dirs.slice(0, Math.max(0, dirs.length - retention))
  for (const name of toPrune) fs.rmSync(path.join(root, name), { recursive: true, force: true })
  return toPrune
}

/** control + 全 data plane をスナップショットし、世代保持と状態記録を行う。 */
export async function backupAllDatabases(
  opts: { retention?: number; now?: Date; kind?: BackupKind } = {},
): Promise<BackupResult> {
  const retention = opts.retention ?? DEFAULT_RETENTION
  const now = opts.now ?? new Date()
  const kind = opts.kind ?? 'cron'
  const timestamp = kind === 'deploy' ? `${stamp(now)}-deploy` : stamp(now)
  // D5 偽成功ガード: DATA_DIR 誤設定時、下の openSqlite が空 control を暗黙生成して
  // 「空のバックアップ成功」を報告してしまう。ディレクトリを作る前にここで遮断する。
  assertControlDbExists()
  // 同じ理由で、帳簿が1冊も無いバックアップも成功にしない。起動時に必ず1冊作られるため
  // （books spec）、0冊は DATA_DIR 誤指定か配置ミスであり、中身のないセットを残すと
  // 世代保持枠を食って正常な旧バックアップを追い出す。
  if (listBookDbFiles().length === 0) {
    throw new Error(
      `バックアップ対象の帳簿がありません（${booksDir()}）。DATA_DIR の指定を確認してください。`,
    )
  }
  const backupsRoot = path.join(dataDir(), 'backups')
  const backupDir = path.join(backupsRoot, timestamp)
  fs.mkdirSync(path.join(backupDir, 'books'), { recursive: true })

  // backup_status 記録用の control 接続（明示クローズ可能。DbRouter は close を持たないため直接開く）。
  const controlSqlite = openSqlite(controlDbPath())
  const controlDb = drizzle(controlSqlite, { schema: controlSchema })
  const at = now.toISOString()
  const booksResult: BackupResult['books'] = []
  let control: BackupOutcome = { ok: true }
  try {
    // 1) data plane を順にバックアップし、結果を backup_status に記録。
    for (const file of listBookDbFiles()) {
      const bookId = path.basename(file).replace(SQLITE_RE, '')
      const outcome: BackupOutcome = { ok: true }
      let dbSnapshotOk = false
      try {
        await backupOne(file, path.join(backupDir, 'books', `${bookId}.sqlite`))
        dbSnapshotOk = true
        // 証憑（attachments）は DB スナップショット完了の**後**にコピーする:
        // スナップショットDBの attachments 行（sha256/storage_path）が指す実ファイルは
        // この時点で必ず存在済みなので、並行アップロードによるズレは「DBに行が無い余分な
        // ファイル」側にしか倒れず、復元後に sha256 で突合検証できる。無いユーザーはスキップ。
        const srcAttachments = attachmentDir(bookId)
        if (fs.existsSync(srcAttachments)) {
          fs.cpSync(srcAttachments, path.join(backupDir, 'books', bookId, 'attachments'), {
            recursive: true,
          })
        }
      } catch (e) {
        outcome.ok = false
        outcome.error = dbSnapshotOk ? `証憑コピー失敗: ${(e as Error).message}` : (e as Error).message
        // DB スナップショットは検証済みなら**残す**（証憑コピーの失敗で健全な DB 復元点まで
        // 失わない。この不変条件は証憑同梱以前から維持）。中途半端な証憑ディレクトリだけ破棄する。
        if (!dbSnapshotOk) fs.rmSync(path.join(backupDir, 'books', `${bookId}.sqlite`), { force: true })
        fs.rmSync(path.join(backupDir, 'books', bookId), { recursive: true, force: true })
      }
      recordStatus(controlDb, bookId, outcome, backupDir, at)
      booksResult.push({ bookId, ...outcome })
    }
    // 2) control を**最後に**バックアップ（この run の backup_status を含むスナップショットにする）。
    try {
      await backupOne(controlDbPath(), path.join(backupDir, 'control.sqlite'))
    } catch (e) {
      control = { ok: false, error: (e as Error).message }
    }
  } finally {
    controlSqlite.close()
  }

  // 全 DB 失敗の run は破棄（空/破損セットが世代保持枠を占有して正常な旧バックアップを削除するのを防ぐ）。
  const anySuccess = control.ok || booksResult.some((b) => b.ok)
  if (!anySuccess) {
    fs.rmSync(backupDir, { recursive: true, force: true })
    return { backupDir, timestamp, control, books: booksResult, prunedSets: [] }
  }

  const prunedSets = pruneOldBackups(backupsRoot, retention, kind)
  return { backupDir, timestamp, control, books: booksResult, prunedSets }
}
