// 2つの巡回結果を突き合わせる（tasks 4.3 / 10.4「Playwright 殻と Electron 殻の出力が一致すること」）。
//
// 殻が違えば必ず変わる値が2つあるので、そこだけ均してから比べる。
//   - `scrapedAt` … 実行時刻。2回走らせている以上、必ず違う
//   - `evidenceRef` … 証跡の絶対パス。土台が殻ごとに違う
//       殻A: <repo>/.kanean/evidence/<key>/<rel>
//       殻B: $DATA_DIR/acquisition/evidence/<key>/<rel>
//     `/evidence/` から後ろは両方 `<key>/<rel>` で同じなので、そこを残して比べる。
//     証跡を取っていないときの `evidenceRef` は URL（＝殻によらず同じ）なので触らない。
//
// 均さないものは均さない。とくに **`calibration` と `range` は突き合わせの前提**なので、
// 食い違っていたら「データが一致した／しなかった」以前の話として別枠で返す。

/** 突き合わせの前提として揃っていてほしいキー（食い違うと比較そのものが成立しない）。 */
const CONTEXT_KEYS = ['source', 'kind', 'script', 'range', 'calibration']

/** 殻が違えば必ず違う＝比較から外す最上位キー。 */
const VOLATILE_KEYS = ['scrapedAt']

/** 証跡パスを殻に依らない形へ落とす。`/evidence/` より後ろだけ見る。 */
export function normalizeEvidenceRef(value) {
  if (typeof value !== 'string') return value
  const at = value.lastIndexOf('/evidence/')
  return at === -1 ? value : value.slice(at + '/evidence/'.length)
}

/** 比較用に均した複製を返す（引数は変更しない）。 */
export function normalizeResult(result) {
  const walk = (node, key) => {
    if (Array.isArray(node)) return node.map((v) => walk(v, key))
    if (node && typeof node === 'object') {
      const out = {}
      for (const [k, v] of Object.entries(node)) out[k] = walk(v, k)
      return out
    }
    return key === 'evidenceRef' ? normalizeEvidenceRef(node) : node
  }

  const copy = walk(result ?? {}, null)
  // `exitCode` は CLI の `--out` が落としている。片方だけ持っていても差ではない。
  delete copy.exitCode
  for (const k of VOLATILE_KEYS) delete copy[k]
  return copy
}

function isObject(v) {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
}

/** 値を差分表示用に短く文字列化する。 */
function show(v) {
  if (v === undefined) return '(無し)'
  const s = JSON.stringify(v)
  return s.length > 120 ? s.slice(0, 117) + '...' : s
}

/** 再帰的に差分を集める。`out` へ `{ path, a, b }` を積む。 */
function walkDiff(a, b, path, out) {
  if (Array.isArray(a) || Array.isArray(b)) {
    if (!Array.isArray(a) || !Array.isArray(b)) {
      out.push({ path, a: show(a), b: show(b) })
      return
    }
    if (a.length !== b.length) out.push({ path: `${path}.length`, a: a.length, b: b.length })
    for (let i = 0; i < Math.max(a.length, b.length); i++) walkDiff(a[i], b[i], `${path}[${i}]`, out)
    return
  }
  if (isObject(a) || isObject(b)) {
    if (!isObject(a) || !isObject(b)) {
      out.push({ path, a: show(a), b: show(b) })
      return
    }
    for (const k of new Set([...Object.keys(a), ...Object.keys(b)]))
      walkDiff(a[k], b[k], path ? `${path}.${k}` : k, out)
    return
  }
  if (a !== b) out.push({ path, a: show(a), b: show(b) })
}

/**
 * 2つの巡回結果を突き合わせる。
 * @returns `{ identical, context, differences }`
 *   - `context` … 前提の食い違い（較正・範囲・スクリプト版など）。空でないなら差分の読みに注意が要る
 *   - `differences` … 明細そのものの差
 */
export function diffResults(left, right) {
  const a = normalizeResult(left)
  const b = normalizeResult(right)

  const context = []
  for (const key of CONTEXT_KEYS) {
    const d = []
    walkDiff(a[key], b[key], key, d)
    context.push(...d)
  }

  const differences = []
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (CONTEXT_KEYS.includes(key)) continue
    walkDiff(a[key], b[key], key, differences)
  }

  return { identical: context.length === 0 && differences.length === 0, context, differences }
}
