import { eq } from 'drizzle-orm'
import type { DataDb } from '../db/router.js'
import { fiscalYears, subAccounts } from '../db/data/schema.js'
import { findAccountIdByName, getOpenFiscalYear } from '../db/lookups.js'

/**
 * 取込パイプラインの共有前提（B4=#117 ①）。
 * EC/銀行の2経路（さらに journalize 内の再検証）が同じ前提検証を二重実装し、
 * bankImport が PreconditionError のためだけに ecImport へ依存する歪みがあった。
 * エラー型・定数・検証ヘルパをここへ一本化する。文言は経路ごとに違うため引数で受ける。
 */

/** 未確定勘定（シードの科目名）。取込・仕訳レビュー・分類が同じ名前を見る唯一の定義。 */
export const SUSPENSE_ACCOUNT = '未確定勘定'

/**
 * summary に載せるサンプル明細の上限（重複・期間外・警告・未確定）。
 * 年度まるごと再取込で全件返さない＝ペイロード抑制。総件数は別フィールドで必ず返す（黙って切らない）。
 */
export const SAMPLE_LIMIT = 50

/** 取込の前提不足（会計年度なし・連携サービス未登録・シード未投入）。route 層で 409＋安全なコードに対応づける。 */
export class PreconditionError extends Error {
  code: 'no_open_fiscal_year' | 'unknown_source' | 'precondition_failed'
  constructor(code: 'no_open_fiscal_year' | 'unknown_source' | 'precondition_failed', message: string) {
    super(message)
    this.name = 'PreconditionError'
    this.code = code
  }
}

/** 開いている会計年度（無ければ 409 相当）。hint は取込入口だけが付ける案内（行単位の再検証は素の文言）。 */
export function requireOpenFiscalYear(db: DataDb, hint?: string): typeof fiscalYears.$inferSelect {
  const open = getOpenFiscalYear(db)
  if (!open)
    throw new PreconditionError(
      'no_open_fiscal_year',
      hint ? `開いている会計年度がありません（${hint}）` : '開いている会計年度がありません',
    )
  return open
}

/** account_ref に紐づく連携サービス（＝取込口座の補助科目）。未登録の文言は経路ごとに違うため受け取る。 */
export function requireLinkedSubAccount(
  db: DataDb,
  accountRef: string,
  notFoundMessage: string,
): typeof subAccounts.$inferSelect {
  const sub = db.select().from(subAccounts).where(eq(subAccounts.linkedAccountRef, accountRef)).all()[0]
  if (!sub) throw new PreconditionError('unknown_source', notFoundMessage)
  return sub
}

/** 未確定勘定の科目 id（シード未投入なら 409 相当）。 */
export function requireSuspenseAccount(db: DataDb): number {
  const id = findAccountIdByName(db, SUSPENSE_ACCOUNT)
  if (id == null) throw new PreconditionError('precondition_failed', '未確定勘定が見つかりません（シード未投入）')
  return id
}
