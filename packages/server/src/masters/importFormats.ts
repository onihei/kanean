import type { ImportFormat } from '@kanean/shared'
export type { ImportFormat }
import { asc, eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { importFormats } from '../db/data/schema.js'
import { validateColumnMappingConfig } from '../import/columnMapping.js'

/**
 * 取込フォーマット定義（汎用列マッピング）マスタ CRUD。Phase3「対応フォーマット拡充」/ csv-format §8。
 * - config は ColumnMappingConfig を JSON で保存。read 時にパース、write 時に検証して文字列化。
 * - source_type 文字列としては `format:{id}`（types.customSourceType）で口座マスタ・dispatch と接続する。
 * - 削除は論理削除（is_active=false。既存取込バッチの source_type 文字列は保持され、過去取込の追跡を壊さない）。
 */

/** 作成/更新の入力。更新では未指定フィールドは既存値を保持する（部分更新）。 */
export interface ImportFormatInput {
  name?: string
  config?: unknown // 検証して ColumnMappingConfig 化（API からの未検証 JSON を受ける）
}

/**
 * 取込フォーマット一覧。既定は有効のみ。
 * config が壊れた行（手動DB編集・スキーマドリフト等の異常系）は throw で一覧全体を巻き込まず、
 * 行単位で隔離し configError 付きで返す（C-9 / 「黙って落とさない」原則と整合）。
 */
export function listImportFormats(db: DataDb, includeInactive = false): ImportFormat[] {
  const base = db.select().from(importFormats)
  const rows = (includeInactive ? base : base.where(eq(importFormats.isActive, true)))
    .orderBy(asc(importFormats.id))
    .all()
  return rows.map((r) => {
    try {
      return toImportFormat(r)
    } catch (err) {
      return { id: r.id, name: r.name, config: null, configError: (err as Error).message, isActive: r.isActive }
    }
  })
}

/** 1件取得。存在しない・config 破損は throw（取込で不正 config を使わせないため厳格）。 */
export function getImportFormat(db: DataDb, id: number): ImportFormat {
  const row = db.select().from(importFormats).where(eq(importFormats.id, id)).all()[0]
  if (!row) throw new Error(`取込フォーマット ${id} が見つかりません`)
  return toImportFormat(row)
}

export function createImportFormat(db: DataDb, input: ImportFormatInput): number {
  const name = (input.name ?? '').trim()
  if (!name) throw new Error('フォーマット名は必須です')
  const config = validateColumnMappingConfig(input.config) // 未指定/不正は ColumnMappingError
  const now = new Date().toISOString()
  return db
    .insert(importFormats)
    .values({ name, config: JSON.stringify(config), isActive: true, createdAt: now, updatedAt: now })
    .returning()
    .all()[0].id
}

/** 部分更新: name/config とも未指定なら既存値を保持（config 単独・name 単独の更新を許す）。 */
export function updateImportFormat(db: DataDb, id: number, input: ImportFormatInput): void {
  const existing = getImportFormat(db, id) // 存在確認＋既存値（config 破損なら throw）
  const name = (input.name ?? existing.name).trim()
  if (!name) throw new Error('フォーマット名は必須です')
  const config = input.config === undefined ? existing.config : validateColumnMappingConfig(input.config)
  if (!config) throw new Error('既存の設定が壊れています（config を指定して修正してください）')
  db.update(importFormats)
    .set({ name, config: JSON.stringify(config), updatedAt: new Date().toISOString() })
    .where(eq(importFormats.id, id))
    .run()
}

export function setImportFormatActive(db: DataDb, id: number, isActive: boolean): void {
  // 存在確認のみ（config 破損でも有効/無効の切替は許す＝壊れた行をアーカイブできる）。
  const row = db.select({ id: importFormats.id }).from(importFormats).where(eq(importFormats.id, id)).all()[0]
  if (!row) throw new Error(`取込フォーマット ${id} が見つかりません`)
  db.update(importFormats)
    .set({ isActive, updatedAt: new Date().toISOString() })
    .where(eq(importFormats.id, id))
    .run()
}

function toImportFormat(row: typeof importFormats.$inferSelect): ImportFormat {
  return { id: row.id, name: row.name, config: validateColumnMappingConfig(JSON.parse(row.config)), isActive: row.isActive }
}
