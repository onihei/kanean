// サイト較正（SEL）を**プログラムから分離したデータ**として扱う（acquisition spec「サイト較正の外出しと更新」）。
//
//   配布時の較正（sites/*.mjs の DEFAULT_SEL・読み取り専用）
//           ▲ 上書きを消せば必ずここへ戻れる
//   $DATA_DIR/acquisition/selectors/<source>.json  ← あれば優先。更新はここへ書く
//
// 受け付けるのは**データだけ**。銀行のログイン済みセッションを持つブラウザで任意コードが動く形は作らない。
import crypto from 'node:crypto'
import { z } from 'zod'

/** 較正値として許すのは 文字列 / 数値 / 文字列配列 の3つだけ（関数・オブジェクトは許さない）。 */
const SEL_VALUE = z.union([z.string().max(2000), z.number().finite(), z.array(z.string().max(2000)).max(50)])

// ページ遷移に使われる値は `javascript:` や `file:` を通すと較正がコード実行になる。
// **どのキーが `page.goto` へ渡るかはサイトごとに違う**ので、名前から推測せず site モジュールが宣言する
// （`activityUrl` のように「URL を照合するだけ」のキーもあり、推測すると誤って弾く）。
const ALLOWED_SCHEME = /^https?:$/

export class CalibrationRejected extends Error {
  constructor(reasons) {
    super(`較正データを受け付けません: ${reasons.join(' / ')}`)
    this.name = 'CalibrationRejected'
    this.reasons = reasons
  }
}

/**
 * 上書き較正を検証する。**同梱の既定に無いキー・型の違うキー・遷移不能な URL は拒否する。**
 * 新しいキーを許さないのは、「較正」を装ってサイトスクリプトの解釈対象を増やせないようにするため。
 * @param {object} defaults 同梱の較正
 * @param {unknown} candidate 受け取った上書き
 * @param {string[]} [navigableKeys] `page.goto` へ渡るキー（site モジュールの NAVIGABLE_KEYS）
 * @returns {{ ok: true, value: object } | { ok: false, reasons: string[] }}
 */
export function validateSelectors(defaults, candidate, navigableKeys = []) {
  const navigable = new Set(navigableKeys)
  const reasons = []
  if (candidate === null || typeof candidate !== 'object' || Array.isArray(candidate))
    return { ok: false, reasons: ['較正はキーと値のオブジェクトである必要があります'] }

  const value = {}
  for (const [key, raw] of Object.entries(candidate)) {
    if (key === 'version' || key === 'note') continue // メタ情報は素通し（後段で扱う）
    if (!(key in defaults)) {
      reasons.push(`未知の較正キー: ${key}（同梱の較正に無いキーは追加できません）`)
      continue
    }
    const parsed = SEL_VALUE.safeParse(raw)
    if (!parsed.success) {
      reasons.push(`${key}: 値は文字列・数値・文字列配列のいずれかである必要があります`)
      continue
    }
    const expected = kindOf(defaults[key])
    if (kindOf(parsed.data) !== expected) {
      reasons.push(`${key}: 同梱の較正と型が違います（期待: ${expected}）`)
      continue
    }
    if (navigable.has(key) && !isNavigable(parsed.data)) {
      reasons.push(`${key}: http/https 以外の URL は受け付けません`)
      continue
    }
    value[key] = parsed.data
  }
  if (reasons.length) return { ok: false, reasons }
  return { ok: true, value }
}

function kindOf(v) {
  if (Array.isArray(v)) return 'array'
  return typeof v
}

function isNavigable(template) {
  // `{year}` 等のプレースホルダは URL パーサを通らないので、判定前に無害な値へ置き換える
  const probe = String(template).replace(/\{\w+\}/g, '0')
  try {
    return ALLOWED_SCHEME.test(new URL(probe).protocol)
  } catch {
    return false
  }
}

/** 同梱較正の版。内容から決まるので、アプリを更新すれば自動で変わる。 */
export function bundledVersion(defaults) {
  const sha = crypto.createHash('sha256').update(stableJson(defaults)).digest('hex')
  return `bundled:${sha.slice(0, 12)}`
}

export function overrideVersion(value, declared) {
  if (typeof declared === 'string' && declared.trim() !== '') return `override:${declared.trim()}`
  const sha = crypto.createHash('sha256').update(stableJson(value)).digest('hex')
  return `override:${sha.slice(0, 12)}`
}

function stableJson(obj) {
  return JSON.stringify(obj, Object.keys(obj).sort())
}

/**
 * 同梱較正へ上書きを重ねて、実際に使う較正を作る。
 * @returns {{ sel: object, calibration: { source: string, origin: 'bundled'|'override', version: string, overridden: string[] } }}
 */
export function mergeSelectors(source, defaults, override, navigableKeys = []) {
  if (!override) {
    return {
      sel: { ...defaults },
      calibration: { source, origin: 'bundled', version: bundledVersion(defaults), overridden: [] },
    }
  }
  const result = validateSelectors(defaults, override, navigableKeys)
  if (!result.ok) throw new CalibrationRejected(result.reasons)
  const overridden = Object.keys(result.value).sort()
  return {
    sel: { ...defaults, ...result.value },
    calibration: {
      source,
      origin: overridden.length ? 'override' : 'bundled',
      version: overridden.length
        ? overrideVersion(result.value, override.version)
        : bundledVersion(defaults),
      overridden,
    },
  }
}
