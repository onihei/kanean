import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'
import { drizzle, type BetterSQLite3Database } from 'drizzle-orm/better-sqlite3'
import { migrate } from 'drizzle-orm/better-sqlite3/migrator'
import { controlDbPath, booksDir, bookDbPath } from '../config.js'
import * as controlSchema from './control/schema.js'
import * as dataSchema from './data/schema.js'
import { seedDataPlane } from './data/seed.js'
import { backfillDedupHashes } from '../import/dedupBackfill.js'

/**
 * DB接続ルーティング（architecture §4）。
 * control plane（共通1DB）と data plane（帳簿ごとDB）を物理分離。
 * クエリに帳簿の条件は不要＝他帳簿への到達が構造的に起きない（M-5）。
 */

export type ControlDb = BetterSQLite3Database<typeof controlSchema>
export type DataDb = BetterSQLite3Database<typeof dataSchema>
/** db.transaction((tx) => ...) のコールバック引数型。トランザクション内外で共用するヘルパの引数に使う。 */
export type DataTx = Parameters<Parameters<DataDb['transaction']>[0]>[0]

// 生成済みマイグレーション = packages/server/migrations。
// src 実行(src/db/router.ts)・dist 実行(dist/db/router.js)とも ../../migrations で一致。
// 本番は deploy.sh が migrations/ を配布する。
const migrationsRoot = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'migrations')
export const CONTROL_MIGRATIONS = path.join(migrationsRoot, 'control')
export const DATA_MIGRATIONS = path.join(migrationsRoot, 'data')

/** ディレクトリを用意し WAL・外部キーを有効化して SQLite を開く。 */
export function openSqlite(file: string): Database.Database {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const sqlite = new Database(file)
  sqlite.pragma('journal_mode = WAL')
  sqlite.pragma('foreign_keys = ON')
  return sqlite
}

/** control plane を最新スキーマへ（起動時／deploy時に1回）。 */
export function migrateControlDb(): void {
  const sqlite = openSqlite(controlDbPath())
  migrate(drizzle(sqlite, { schema: controlSchema }), { migrationsFolder: CONTROL_MIGRATIONS })
  sqlite.close()
}

/**
 * 1つの data plane DB を最新スキーマへ。DDL 後に dedup_hash 移行（出現インデックス方式・冪等。C-6）を実行し、
 * 旧スキームで取込済みの行を新方式へ再ハッシュする（再取込の二重計上を防ぐ）。
 * @returns 再ハッシュした raw_transactions 行数
 */
export function migrateBookDb(file: string): number {
  const sqlite = openSqlite(file)
  const db = drizzle(sqlite, { schema: dataSchema })
  migrate(db, { migrationsFolder: DATA_MIGRATIONS })
  const rehashed = backfillDedupHashes(db)
  sqlite.close()
  return rehashed
}

/** $DATA_DIR/books/*.sqlite を全列挙（N個DBランナー用）。 */
export function listBookDbFiles(): string[] {
  const dir = booksDir()
  if (!fs.existsSync(dir)) return []
  return fs
    .readdirSync(dir)
    .filter((f) => f.endsWith('.sqlite'))
    .map((f) => path.join(dir, f))
}

let singleton: DbRouter | null = null

/** プロセス共有の DbRouter（HTTP層用）。テストは new DbRouter() を直接使う。 */
export function getRouter(): DbRouter {
  if (!singleton) singleton = new DbRouter()
  return singleton
}

export class DbRouter {
  private control: ControlDb
  private cache = new Map<string, DataDb>()
  /** bookDb と同じキーで保持する生の接続。closeBook で閉じるために必要（drizzle 側からは辿らない）。 */
  private handles = new Map<string, Database.Database>()

  constructor() {
    const sqlite = openSqlite(controlDbPath())
    this.control = drizzle(sqlite, { schema: controlSchema })
  }

  controlDb(): ControlDb {
    return this.control
  }

  /** 指定帳簿の data plane を返す。初回オープン時に最新へマイグレート（新規帳簿・保険）。 */
  bookDb(bookId: string): DataDb {
    let db = this.cache.get(bookId)
    if (!db) {
      const file = bookDbPath(bookId)
      const sqlite = openSqlite(file)
      migrate(drizzle(sqlite, { schema: dataSchema }), { migrationsFolder: DATA_MIGRATIONS })
      db = drizzle(sqlite, { schema: dataSchema })
      // 標準シード（税区分・勘定科目チャート）を冪等投入。
      // 既存の帳簿も開くたびに最新シードへ追いつく（self-healing）。
      seedDataPlane(db)
      this.cache.set(bookId, db)
      this.handles.set(bookId, sqlite)
    }
    return db
  }

  /**
   * 指定帳簿の接続を閉じてキャッシュから外す（次の bookDb で開き直す）。
   *
   * **ファイルを差し替える前に必ず呼ぶ**（ops/importBook の replace）。開いたままの接続の下で
   * DB ファイルを入れ替えると、旧接続の WAL・チェックポイントが新しいファイルへ書き戻されて
   * 破損する（ops/restore.ts が「サーバ停止中に」と要求しているのと同じ理由）。
   * close は WAL をチェックポイントして -wal/-shm を畳むので、退避側も単一ファイルに戻る。
   */
  closeBook(bookId: string): void {
    this.handles.get(bookId)?.close()
    this.handles.delete(bookId)
    this.cache.delete(bookId)
  }
}
