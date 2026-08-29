/**
 * 帳簿ID（ULID）の形式検査（issue #145）。exportBook / importBook / attachments に
 * 3重定義されていたものを一本化し、エラー文言も「不正な帳簿IDです」に統一
 * （attachments は旧「不正なユーザーIDです」。実体は帳簿ID＝命名ドリフトは issue #146）。
 */

/** ULID 形式（Crockford base32・大文字26桁）。これ以外を拒否し、パス組み立ての traversal を構造的に排除する（多層防御）。 */
export const ULID_RE = /^[0-9A-Z]{26}$/

/** 帳簿IDが ULID 形式であることを保証する（不正なら throw）。 */
export function assertValidBookId(id: string): void {
  if (!ULID_RE.test(id)) throw new Error('不正な帳簿IDです')
}
