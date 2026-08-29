import { sql, type AnyColumn, type SQL } from 'drizzle-orm'

/**
 * 「素の substring 一致」の LIKE 条件（issue #143）。メタ文字（% _ \）をエスケープし
 * ESCAPE 指定で literal 一致にする。listDrafts と listEntries が別実装（片方は素通し）だと、
 * `?q=A_B` が draft では literal 一致・仕訳一覧では `_` ワイルドカード、という利用者に
 * 説明できない差になるため、両方をこの1本に寄せる（挙動はエスケープ側＝安全側）。
 */
export function containsEscaped(col: AnyColumn, q: string): SQL {
  const escaped = q.replace(/[\\%_]/g, (ch) => `\\${ch}`)
  return sql`${col} LIKE ${`%${escaped}%`} ESCAPE '\\'`
}
