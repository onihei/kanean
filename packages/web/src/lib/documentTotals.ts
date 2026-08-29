/** 請求書の表示用合計（issue #134）。サーバが正・ここは画面プレビューの概算。 */
import type { DocumentLine } from '../api.js'

/**
 * 明細から表示用合計を概算（税率別 floor）。
 *
 * 源泉徴収の式・定数（10.21% / 100万円境界 / 20.42%）は core の `rewardWithholding`
 * （packages/core/src/incomeTax.ts）と**同じ値の独立コピー**。web→core は依存方向違反
 * （docs/architecture.md §2）なので import せず、ゴールデンテスト
 * （documentTotals.test.ts: 1,000,000→102,100 / 1,500,000→204,200 = core と同一の期待値）で
 * 一致を担保する。core 側を変えるときはこちらとテストも揃えること。
 */
export function previewTotals(lines: DocumentLine[]): {
  subtotal: number
  taxTotal: number
  total: number
  withholding: number
} {
  let subtotal = 0
  let whBase = 0
  const netByRate = new Map<number, number>()
  for (const l of lines) {
    const amt = Math.round(l.amount || 0)
    subtotal += amt
    const rate = l.taxRate ?? 0
    netByRate.set(rate, (netByRate.get(rate) ?? 0) + amt)
    if (l.withholding) whBase += amt
  }
  let taxTotal = 0
  for (const [rate, net] of netByRate) if (rate > 0) taxTotal += Math.floor((net * rate) / 100)
  // 源泉の概算（100万以下10.21%）。境界超過はサーバが正。
  const withholding =
    whBase > 0
      ? Math.floor(whBase <= 1_000_000 ? whBase * 0.1021 : 1_000_000 * 0.1021 + (whBase - 1_000_000) * 0.2042)
      : 0
  return { subtotal, taxTotal, total: subtotal + taxTotal, withholding }
}
