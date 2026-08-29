import iconv from 'iconv-lite'
import { eq } from 'drizzle-orm'
import type { DbRouter, DataDb } from '../db/router.js'
import { fiscalYears } from '../db/data/schema.js'
import { getOpenFiscalYear, requireOpenFiscalYear } from '../db/lookups.js'
import { priorFiscalYearId } from '../reports/reports.js'
import type { ListEntriesFilter } from '../journal/entries.js'

/**
 * /api ルーター群の共有ヘルパ（issue #114 の分割で api.ts から切り出し）。
 * ここに置くのは「どのドメインでも同じでなければならない規約」だけ:
 * id ガード・CSV/PDF レスポンスの形・open 年度の解決。
 */

/**
 * ルートパラメータを整数 id として解釈する（:id / :lineId / :accountId / :subAccountId 共通ガード）。
 * 非整数（NaN・小数・指数表記等）は null。better-sqlite3 は NaN を bind しても changes:0 で
 * 「正常実行」するため、HTTP 境界で遮断しないと {ok:true} のサイレント偽成功になる。
 */
export function intParam(c: { req: { param: (name: string) => string | undefined } }, name = 'id'): number | null {
  const n = Number(c.req.param(name))
  return Number.isInteger(n) ? n : null
}

/** クエリ（status/from/to/q/accountId/limit）→ 仕訳一覧フィルタ。/entries と /reports/journal.csv で共有。 */
export function parseEntriesFilter(q: (key: string) => string | undefined): ListEntriesFilter {
  const statusRaw = q('status')
  const accountId = q('accountId')
  const limit = q('limit')
  return {
    status: statusRaw === 'all' || statusRaw === 'draft' || statusRaw === 'confirmed' ? statusRaw : 'confirmed',
    from: q('from') ?? null,
    to: q('to') ?? null,
    q: q('q') ?? null,
    accountId: accountId ? Number(accountId) : null,
    limit: limit ? Number(limit) : undefined,
  }
}

/** Shift_JIS に変換できない文字（'?' へ落ちる文字）を重複なく抽出（先頭30種で打切）。 */
export function lossyShiftJisChars(text: string): string[] {
  const lost = new Set<string>()
  for (const ch of new Set(text)) {
    if (ch === '?') continue // '?' 自体は正当にマップされる
    if (iconv.decode(iconv.encode(ch, 'Shift_JIS'), 'Shift_JIS') !== ch) {
      lost.add(ch)
      if (lost.size >= 30) break
    }
  }
  return [...lost]
}

/** RFC5987 ext-value: encodeURIComponent が残す ' ( ) * ! も pct-encode する。 */
export function rfc5987(filename: string): string {
  return encodeURIComponent(filename).replace(/['()*!]/g, (ch) => '%' + ch.charCodeAt(0).toString(16).toUpperCase())
}

/** CSV レスポンス（UTF-8 BOM 付き＝Excel の文字化け回避、Content-Disposition 添付）。 */
export function csvResponse(
  c: { header: (k: string, v: string) => void; body: (b: string | ArrayBuffer) => Response },
  filename: string,
  body: string,
  encoding: 'utf8' | 'shift_jis' = 'utf8',
): Response {
  c.header('Content-Disposition', `attachment; filename*=UTF-8''${rfc5987(filename)}`)
  // Shift_JIS: UTF-8 を受け付けない外部ツールへの受け渡し用。BOM は付けない。
  if (encoding === 'shift_jis') {
    c.header('Content-Type', 'text/csv; charset=Shift_JIS')
    // Shift_JIS に無い文字（絵文字・em-dash・異体字等）は '?' へ落ちるため、欠落を検知して
    // ヘッダで通知する（黙って文字化けさせない。クライアントが警告表示する）。
    const lossy = lossyShiftJisChars(body)
    if (lossy.length > 0) c.header('X-Export-Lossy-Chars', encodeURIComponent(lossy.join('')))
    const buf = iconv.encode(body, 'Shift_JIS')
    return c.body(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer)
  }
  // UTF-8 BOM 付き（Excel の文字化け回避）。
  c.header('Content-Type', 'text/csv; charset=utf-8')
  return c.body(String.fromCharCode(0xfeff) + body)
}

/** PDF レスポンス（inline 表示・Content-Disposition。attachments/download と同じバイナリ流儀）。 */
export function pdfResponse(
  c: { header: (k: string, v: string) => void; body: (b: ArrayBuffer) => Response },
  filename: string,
  bytes: Uint8Array,
): Response {
  c.header('Content-Type', 'application/pdf')
  c.header('Content-Disposition', `inline; filename*=UTF-8''${rfc5987(filename)}`)
  return c.body(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer)
}

/** 開いている会計年度（1本だけ open の運用）。実体は db/lookups.ts（B9=#121）。 */
export function openYear(db: DataDb) {
  return getOpenFiscalYear(db)
}

/**
 * 前期比較: 当期＝fiscalYearId（省略時 open 年度）、比較対象＝compareTo（省略時 前期を自動解決）。
 * 当期・比較対象とも実在する年度 id のみ採用（NaN/存在しない id は当期=年度なし／比較=前期なし＝hasPrior:false）。
 */
export function compareYears(
  db: DataDb,
  reqYear?: string,
  compareTo?: string,
): { fyId: number; priorFyId: number | null } | null {
  const yearById = (raw: string): { id: number } | undefined => {
    const n = Number(raw)
    if (!Number.isInteger(n)) return undefined
    return db.select({ id: fiscalYears.id }).from(fiscalYears).where(eq(fiscalYears.id, n)).all()[0]
  }
  const fy = reqYear ? yearById(reqYear) : openYear(db)
  if (!fy) return null
  const priorFyId = compareTo ? (yearById(compareTo)?.id ?? null) : priorFiscalYearId(db, fy.id)
  return { fyId: fy.id, priorFyId }
}

/** c.get('bookId') を受け取るハンドラのコンテキスト最小形。 */
export type BookContext = { get: (k: 'bookId') => string }

/**
 * ルーターに束ねた帳簿ヘルパ。各ドメインルーターが冒頭で1回作る。
 * open 年度なしの契約は2つだけ（issue #119 = B7）:
 * - withOpenYearOrNull: 200＋null（JSON 参照系の意図的契約。web は「会計年度がありません」表示に落とす）
 * - requireOpenYear: throw → onError が 400 {error:'開いている会計年度がありません'}（更新系・ファイル出力系。
 *   文言はこの1本＝db/lookups.requireOpenFiscalYear が正）
 */
export function bookHelpers(router: DbRouter): {
  dbOf: (c: BookContext) => DataDb
  withOpenYearOrNull: <T>(c: BookContext, fn: (db: DataDb, fyId: number) => T) => T | null
  requireOpenYear: (c: BookContext) => { db: DataDb; fyId: number }
} {
  const dbOf = (c: BookContext): DataDb => router.bookDb(c.get('bookId'))
  const withOpenYearOrNull = <T>(c: BookContext, fn: (db: DataDb, fyId: number) => T): T | null => {
    const db = dbOf(c)
    const fy = openYear(db)
    if (!fy) return null
    return fn(db, fy.id)
  }
  const requireOpenYear = (c: BookContext): { db: DataDb; fyId: number } => {
    const db = dbOf(c)
    return { db, fyId: requireOpenFiscalYear(db).id }
  }
  return { dbOf, withOpenYearOrNull, requireOpenYear }
}
