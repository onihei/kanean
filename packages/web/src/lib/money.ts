/**
 * 金額入力の正規化（issue #134）。**円は整数**（CLAUDE.md 規約）— 入力の解釈規則を
 * ここ1箇所に寄せる。従来は7実装（全角対応 / Number 素通し / trunc / floor / round）が
 * 画面ごとにバラバラで、同じ「12.5」がページによって 12 になったり 12.5 のまま
 * 下書きへ入ったりしていた。
 */

/** 金額入力（全角数字・カンマ・円記号・空白は除去）→ 非負の円整数。空は 0、不正は null。 */
export function parseYenInput(raw: string): number | null {
  const s = raw
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[,，、\s¥￥円]/g, '')
  if (s === '') return 0
  if (!/^\d+$/.test(s)) return null
  const n = Number(s)
  return Number.isSafeInteger(n) ? n : null
}

/**
 * onChange 用: 入力途中でも状態を常に非負の円整数に保つ（不正は 0）。
 * 小数・負数を黙って丸めない＝「12.5 を 12 として保存」のような静かな改変をしない。
 * 確定時に入力の不正をユーザーへ伝えたい画面は parseYenInput の null を使う。
 */
export const yenOrZero = (raw: string): number => parseYenInput(raw) ?? 0
