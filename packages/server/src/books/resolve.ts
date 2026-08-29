import type { BookInfo } from '@kanean/shared'
export type { BookInfo }
import { eq } from 'drizzle-orm'
import { ulid } from 'ulid'
import type { DbRouter } from '../db/router.js'
import { books } from '../db/control/schema.js'
import { seedDataPlane } from '../db/data/seed.js'

/**
 * 帳簿（books spec）。1帳簿＝1つの data plane ファイル `$DATA_DIR/books/{id}.sqlite`。
 * 1インスタンスで複数持てる（税理士が顧問先を N 冊持つ想定）。
 */

export const DEFAULT_BOOK_NAME = 'マイ帳簿'

/**
 * 帳簿を一覧する（作成順）。既定はアクティブのみ。
 * アーカイブ済みは「選択候補ではない」ため、暗黙解決・切替・一覧の既定からは外れる（books spec）。
 */
export function listBooks(router: DbRouter, opts: { includeArchived?: boolean } = {}): BookInfo[] {
  return router
    .controlDb()
    .select()
    .from(books)
    .all()
    .filter((b) => opts.includeArchived === true || b.archivedAt == null)
    .map((b) => ({ id: b.id, name: b.name, createdAt: b.createdAt, archivedAt: b.archivedAt }))
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
}

/** 指定 id の帳簿（アーカイブ済みも含む）。存在しなければ null。 */
export function findBook(router: DbRouter, id: string): BookInfo | null {
  const row = router.controlDb().select().from(books).where(eq(books.id, id)).all()[0]
  return row ? { id: row.id, name: row.name, createdAt: row.createdAt, archivedAt: row.archivedAt } : null
}

/** 帳簿を1冊作成し、data plane を初期化（マイグレート＋標準シード）する。 */
export function createBook(router: DbRouter, name: string): BookInfo {
  const now = new Date().toISOString()
  const id = ulid()
  router.controlDb().insert(books).values({ id, name, createdAt: now, updatedAt: now }).run()
  // 初回オープンで最新スキーマへ。seedDataPlane は冪等。
  seedDataPlane(router.bookDb(id))
  return { id, name, createdAt: now, archivedAt: null }
}

/** 帳簿を改名する。data plane のファイル名（= id）は不変。存在しなければ false。 */
export function renameBook(router: DbRouter, id: string, name: string): boolean {
  const control = router.controlDb()
  if (!control.select().from(books).where(eq(books.id, id)).all()[0]) return false
  control.update(books).set({ name, updatedAt: new Date().toISOString() }).where(eq(books.id, id)).run()
  return true
}

/**
 * 起動時に最低1冊を保証する（books spec「起動時に最初の帳簿を用意する」）。
 * **アクティブが0冊**なら `マイ帳簿` を作成。1冊以上ならそのまま（N 冊は正常な状態）。
 * アーカイブ済みしか無い状態も「アクティブ0冊」＝新規作成の対象（開ける帳簿が無いと起動できないため）。
 */
export function ensureAtLeastOneBook(router: DbRouter): void {
  if (listBooks(router).length === 0) createBook(router, DEFAULT_BOOK_NAME)
}

export type ArchiveResult = 'ok' | 'not_found' | 'last_active'

/**
 * 帳簿をアーカイブする（control plane の状態変更のみ。data plane のファイル・証憑には触れない）。
 * アクティブが1冊しかないときは拒否する: アクティブ0冊は ensureAtLeastOneBook を誘発し、
 * 起動のたびに空の「マイ帳簿」が生えるため（books spec「最後のアクティブ帳簿はアーカイブできない」）。
 */
export function archiveBook(router: DbRouter, id: string): ArchiveResult {
  const target = findBook(router, id)
  if (!target) return 'not_found'
  if (target.archivedAt == null && listBooks(router).length <= 1) return 'last_active'
  const now = new Date().toISOString()
  router.controlDb().update(books).set({ archivedAt: now, updatedAt: now }).where(eq(books.id, id)).run()
  return 'ok'
}

/** アーカイブを復帰する。存在しなければ false（既にアクティブなら何もせず true）。 */
export function unarchiveBook(router: DbRouter, id: string): boolean {
  if (!findBook(router, id)) return false
  const now = new Date().toISOString()
  router.controlDb().update(books).set({ archivedAt: null, updatedAt: now }).where(eq(books.id, id)).run()
  return true
}
