/**
 * 連携サービスカタログ — 登録可能なサービスの静的定義（単一の真実源）。
 *
 * 「自動で仕訳」はまず連携サービスを登録し、サービス毎に取込・仕訳確認する。実体は
 * 「import_source_type=カタログ key・linked_account_ref=自動採番の account_ref を持つ補助科目」
 * （口座マスタ F-IMP-8 をカタログ駆動に拡張。[docs/csv-format C-5]）。
 *
 * 設計境界:
 * - CSVパーサ dispatch の対象は組込3形式のみ（[import/types.ts] SOURCE_TYPES / [import/dispatch.ts]）。
 *   amazon/rakuten はパーサを持たない（`csv:false`）。取込は将来 Claude Code スキルが
 *   内部IFで投入する（[docs/acquisition-skill-spec], [docs/csv-format §4]）＝本カタログは登録のみ担う。
 * - key と `sub_accounts.import_source_type` / `import_batches.source_type` は同一文字列空間。
 *   bank/card は組込パーサの source_type と key を一致させる。
 */
import type { ServiceKind, ServiceCatalogEntry } from '@kanean/shared'
export type { ServiceKind, ServiceCatalogEntry }

/** 当初対応する5サービス。 */
export const SERVICE_CATALOG: readonly ServiceCatalogEntry[] = [
  { key: 'bank_ufj', label: '三菱UFJ銀行', kind: 'bank', parentAccountName: '普通預金', csv: true },
  { key: 'bank_shinsei', label: '新生銀行', kind: 'bank', parentAccountName: '普通預金', csv: true },
  { key: 'card_mufg_visa', label: '三菱UFJ-VISA', kind: 'card', parentAccountName: '未払金', csv: true },
  { key: 'amazon', label: 'Amazon', kind: 'ec', parentAccountName: '未払金', csv: false },
  { key: 'rakuten', label: '楽天市場', kind: 'ec', parentAccountName: '未払金', csv: false },
] as const

/** カタログ参照（key 一致）。未知キーは undefined。 */
export function getCatalogEntry(key: string): ServiceCatalogEntry | undefined {
  return SERVICE_CATALOG.find((s) => s.key === key)
}

/** import_source_type からカタログ参照（連携サービス一覧の enrich 用）。 */
export function catalogBySourceType(sourceType: string | null | undefined): ServiceCatalogEntry | undefined {
  if (!sourceType) return undefined
  return SERVICE_CATALOG.find((s) => s.key === sourceType)
}
