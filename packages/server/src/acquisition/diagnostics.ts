import { readDiagnostic, type StoredDiagnostic } from '@kanean/acquisition'
import { dataDir } from '../config.js'

/**
 * 失敗診断の取り出し（acquisition spec「失敗時の診断」）。
 * 認証情報とセッション識別子は保存の時点で伏せてある（`@kanean/acquisition` の redact）。
 */

export interface DiagnosticView extends StoredDiagnostic {
  /** 較正の差し替えで直る見込みがあるか（tasks 9.4）。 */
  calibratable: boolean
  /** そう判断した理由（人にも AI にも「次に何をすべきか」が伝わる形で）。 */
  verdict: string
  /** 見直す候補の較正キー（hint から拾う）。 */
  suggestedKeys: string[]
}

/**
 * 「較正では直らない改変」を判別する。
 *
 * 較正で直るのは**画面上の要素を指し損ねた**類の失敗だけ。
 * 検算が合わない・巡回の流れ自体が変わった、は較正を何度書き換えても直らないので、
 * そこを取り違えて無駄な更新を繰り返させない。
 */
const NOT_CALIBRATABLE = [
  { re: /検算不一致|残高チェーン|突合NG/, verdict: '取得はできているが検算が合わない。較正ではなく明細の中身の問題（投入していない）' },
  { re: /バウンス|再試行/, verdict: '巡回の流れ自体が変わった可能性がある。較正の差し替えでは直らない' },
  { re: /表示順の前提が変わった/, verdict: '一覧の並び順という前提が変わった。巡回手順の修正（アプリの更新）が要る' },
  { re: /ログイン待ちタイムアウト/, verdict: 'ログインが完了しなかっただけ。較正の問題ではない' },
  { re: /人の操作で中断/, verdict: '人が中断した。失敗ではない' },
  { re: /巡回ウィンドウが閉じられました/, verdict: 'ウィンドウが閉じられた。較正の問題ではない' },
]

const CALIBRATABLE = [
  { re: /見つからない|見つかりません|待てませんでした/, verdict: '画面上の要素を指し損ねている。較正の差し替えで直る見込みがある' },
  { re: /カラム同定失敗/, verdict: '表のヘッダ名が変わっている。列を指す較正の差し替えで直る見込みがある' },
]

export function classifyDiagnostic(d: { message: string; hint: string | null }): {
  calibratable: boolean
  verdict: string
  suggestedKeys: string[]
} {
  const text = `${d.message} ${d.hint ?? ''}`
  for (const rule of NOT_CALIBRATABLE) {
    if (rule.re.test(text)) return { calibratable: false, verdict: rule.verdict, suggestedKeys: [] }
  }
  for (const rule of CALIBRATABLE) {
    if (rule.re.test(text)) return { calibratable: true, verdict: rule.verdict, suggestedKeys: suggestKeys(text) }
  }
  return {
    calibratable: false,
    verdict: '較正で直るかどうかを判別できない。画面の状態を人が確認する',
    suggestedKeys: suggestKeys(text),
  }
}

/** hint 文の `SEL.xxx` / `SEL.col*` から見直す候補キーを拾う。 */
function suggestKeys(text: string): string[] {
  const keys = new Set<string>()
  for (const m of text.matchAll(/SEL\.([A-Za-z]\w*)\*?/g)) keys.add(m[1])
  return [...keys]
}

export function getDiagnostic(source: string): DiagnosticView | null {
  const stored = readDiagnostic(dataDir(), source)
  if (!stored) return null
  return { ...stored, ...classifyDiagnostic(stored) }
}
