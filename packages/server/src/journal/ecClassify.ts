/**
 * EC品目分類の履歴ルックアップ（acquisition-skill-spec §7.3）。純関数・I/Oなし。
 *
 * スキルが叩く「分類履歴 API」の中核。意味マッチ（プロンプト投入）の payload が
 * 履歴の蓄積で膨らまないよう、注入する分だけを絞る:
 *   ① 集約済みペア（hitCount。呼び出し側が mapping_history を渡す時点で集約済み）
 *   ② 関連プレフィルタ … 今回バッチの品名トークンと語が重なる行のみ
 *   ③ 忘却窓（recency） … last_used_at が直近 windowMonths 以内のみ（既定12か月）
 *   ④ 上限K（バックストップ） … recency × hitCount で上位 limit 件（既定200）
 *
 * 行は削除しない（忘却＝注入ポリシーであり DB からは消さない。data-model §2.9.2）。
 * 基準時刻 now は純粋性のため引数で受ける。
 */

export interface EcHistoryRow {
  /** 正規化前でもよい item_name キー（mapping_history.pattern）。本関数内でトークン化する。 */
  pattern: string
  accountId: number
  subAccountId: number | null
  hitCount: number
  /** ISO 文字列。null=recency 不明 → 窓外扱い。 */
  lastUsedAt: string | null
}

export interface EcLookupOptions {
  /** 基準時刻（ISO）。純関数のため引数で受ける。 */
  now: string
  /** 忘却窓（月）。既定 12。 */
  windowMonths?: number
  /** 上限K。既定 200。 */
  limit?: number
}

export interface EcLookupCandidate {
  pattern: string
  accountId: number
  subAccountId: number | null
  hitCount: number
  lastUsedAt: string | null
  /** recency × hitCount（降順ソートキー）。 */
  score: number
}

export const DEFAULT_WINDOW_MONTHS = 12
export const DEFAULT_LIMIT = 200
const MIN_TOKEN_LEN = 2
const AVG_MONTH_MS = 1000 * 60 * 60 * 24 * 30.4375 // 平均月長（グレゴリオ暦）

/**
 * NFKC 正規化＋小文字化し、英数/かな/漢字の連なりをトークン化（短すぎるノイズは捨てる）。
 * 半角カナや全角英数の揺れを正規化し、ブランド名・型番・作品名で関連を取れるようにする。
 */
export function tokenizeItemName(name: string): string[] {
  // 中黒(・)・記号は語の区切り（複合ブランド/作品名を割る）。NFKC で半角カナ・全角英数も正規化。
  const norm = name.normalize('NFKC').toLowerCase().replace(/[・･゠]/gu, ' ')
  // 保持クラス: 英数 / 反復記号々 / ひらがな(ぁ-ゖ) / カタカナ字母(ァ-ヺ)＋長音ー / CJK統合漢字。
  // ・(30fb) は保持クラスから外す＝区切りになる（上の replace と二重で担保）。
  const tokens = norm
    .split(/[^0-9a-z々ぁ-ゖァ-ヺー㐀-鿿]+/u)
    // 短すぎる ASCII ノイズ（1文字）は捨てるが、単一のカナ字母/漢字は意味を持つ品名（米・卵 等）なので残す。
    .filter((t) => t.length >= MIN_TOKEN_LEN || /^[ァ-ヺ㐀-鿿]$/u.test(t))
  return [...new Set(tokens)]
}

function monthsBetween(lastUsedAt: string | null, now: string): number | null {
  if (!lastUsedAt) return null
  const t = Date.parse(lastUsedAt)
  const n = Date.parse(now)
  if (Number.isNaN(t) || Number.isNaN(n)) return null
  return (n - t) / AVG_MONTH_MS
}

/** last_used_at が now から windowMonths 以内か（recency 窓）。未来日（時計ずれ）は最新扱いで残す。 */
function withinWindow(lastUsedAt: string | null, now: string, windowMonths: number): boolean {
  const m = monthsBetween(lastUsedAt, now)
  if (m == null) return false
  if (m < 0) return true
  return m <= windowMonths
}

/** recency 係数 ∈ [0,1]: 直近=1、窓端=ほぼ0 の線形減衰。 */
function recencyFactor(lastUsedAt: string | null, now: string, windowMonths: number): number {
  const m = monthsBetween(lastUsedAt, now)
  if (m == null) return 0
  if (m <= 0) return 1
  const f = 1 - m / (windowMonths + 1)
  return f < 0 ? 0 : f
}

/**
 * 今回品名に関連する確定履歴を、recency × hitCount 降順で上位 limit 件返す。
 * 関連が無い（新規）品目は候補ゼロ＝スキルは md ポリシーで判断する（[acquisition-skill-spec §7.2]）。
 */
export function lookupEcHistory(
  history: EcHistoryRow[],
  items: string[],
  opts: EcLookupOptions,
): EcLookupCandidate[] {
  const windowMonths = opts.windowMonths ?? DEFAULT_WINDOW_MONTHS
  const limit = opts.limit ?? DEFAULT_LIMIT
  const itemTokens = new Set(items.flatMap(tokenizeItemName))
  if (itemTokens.size === 0) return []

  const candidates: EcLookupCandidate[] = []
  for (const h of history) {
    if (!withinWindow(h.lastUsedAt, opts.now, windowMonths)) continue // ③ recency 窓
    const patTokens = tokenizeItemName(h.pattern)
    if (!patTokens.some((t) => itemTokens.has(t))) continue // ② 関連プレフィルタ
    const score = recencyFactor(h.lastUsedAt, opts.now, windowMonths) * h.hitCount
    candidates.push({
      pattern: h.pattern,
      accountId: h.accountId,
      subAccountId: h.subAccountId,
      hitCount: h.hitCount,
      lastUsedAt: h.lastUsedAt,
      score,
    })
  }
  // ④ recency×hitCount 降順。同点は hitCount→pattern で安定化（pattern比較はロケール非依存の符号順）。
  candidates.sort((a, b) => b.score - a.score || b.hitCount - a.hitCount || (a.pattern < b.pattern ? -1 : a.pattern > b.pattern ? 1 : 0))
  return candidates.slice(0, limit)
}
