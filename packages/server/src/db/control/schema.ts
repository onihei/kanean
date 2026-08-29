import { sqliteTable, text, integer } from 'drizzle-orm/sqlite-core'

/**
 * Control plane（control.sqlite）。data-model §1。
 * 認証・課金は持たない（local-access spec）。帳簿のレジストリ（books）と
 * バックアップ結果の記録だけが残る。会計データは置かない。
 */

// 帳簿＝1つの会計データファイル。1インスタンスで複数持てる（税理士が顧問先を N 冊持つ想定。books spec）。
export const books = sqliteTable('books', {
  id: text('id').primaryKey(), // ULID。data plane ファイル名 books/{id}.sqlite に対応
  name: text('name').notNull(), // 表示名（初回自動作成は「マイ帳簿」）。事業者名は data plane の business_settings が正
  createdAt: text('created_at').notNull(),
  updatedAt: text('updated_at').notNull(),
  // アーカイブ日時（ISO8601・NULL=アクティブ）。顧問契約の終了・使わなくなった帳簿を一覧から下げる。
  // control plane だけの状態で、data plane のファイル・証憑には触れない（削除は引き続き提供しない。books spec）。
  archivedAt: text('archived_at'),
})

// アプリ全体の設定（帳簿を跨ぐ）。現状は app_mode（じぶんの帳簿/事務所）のみ。
// 帳簿ファイルは可搬（エクスポート・受け渡し）なので、アプリの都合は data plane に持ち込まない（app-mode spec）。
export const appSettings = sqliteTable('app_settings', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
  updatedAt: text('updated_at').notNull(),
})

export const backupStatus = sqliteTable('backup_status', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  bookId: text('book_id')
    .notNull()
    .references(() => books.id),
  lastBackupAt: text('last_backup_at'),
  lastStatus: text('last_status'), // success / failed
  destination: text('destination'), // バックアップ先（現状はローカルスナップショットの絶対パス。将来 email/cloud）
  detail: text('detail'),
})
