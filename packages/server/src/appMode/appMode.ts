import { APP_MODES, type AppMode } from '@kanean/shared'
export { APP_MODES }
export type { AppMode }
import { eq } from 'drizzle-orm'
import type { DbRouter } from '../db/router.js'
import { appSettings } from '../db/control/schema.js'

/**
 * アプリモード（app-mode spec）。1インスタンスが「自分の帳簿1冊」と「顧問先 N 冊」の
 * どちらとして振る舞うかを表す。**起動導線と UI の露出範囲のみ**を決め、会計データの意味・
 * 計算結果・帳簿解決の可否は変えない。
 *
 * 保存先は control plane（帳簿を跨ぐ設定であり、帳簿ファイルは可搬なのでアプリの都合を持ち込まない）。
 */

export const APP_MODE_KEY = 'app_mode'


const isAppMode = (v: string): v is AppMode => (APP_MODES as readonly string[]).includes(v)

/**
 * 現在のモード。未設定・未知の値・壊れた値はすべて `null`（＝未設定）として返す。
 * 既定へ倒さない: 「まだ選んでいない」と「personal を選んだ」は区別されねばならず、
 * 勝手に倒すと初回選択の機会そのものが消える。
 */
export function getAppMode(router: DbRouter): AppMode | null {
  const row = router.controlDb().select().from(appSettings).where(eq(appSettings.key, APP_MODE_KEY)).all()[0]
  if (!row) return null
  return isAppMode(row.value) ? row.value : null
}

/** モードを保存する（upsert）。 */
export function setAppMode(router: DbRouter, mode: AppMode): void {
  const now = new Date().toISOString()
  router
    .controlDb()
    .insert(appSettings)
    .values({ key: APP_MODE_KEY, value: mode, updatedAt: now })
    .onConflictDoUpdate({ target: appSettings.key, set: { value: mode, updatedAt: now } })
    .run()
}
