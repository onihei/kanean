// 較正の上書きを置く場所。`$DATA_DIR/acquisition/selectors/<source>.json`。
// **上書きファイルを消す＝同梱較正へ戻る**（壊れた較正からの復帰手段。acquisition spec）。
import fs from 'node:fs'
import path from 'node:path'
import { validateSelectors, CalibrationRejected } from './selectors.mjs'

export function selectorsDir(dataDir) {
  return path.join(dataDir, 'acquisition', 'selectors')
}

export function selectorsPath(dataDir, source) {
  return path.join(selectorsDir(dataDir), `${source}.json`)
}

/** 上書きが無ければ null（＝同梱較正を使う）。壊れた JSON も null 扱いにはせず投げる。 */
export function readOverride(dataDir, source) {
  const file = selectorsPath(dataDir, source)
  if (!fs.existsSync(file)) return null
  const text = fs.readFileSync(file, 'utf8')
  try {
    return JSON.parse(text)
  } catch (e) {
    throw new CalibrationRejected([`${file} が JSON として読めません: ${String(e?.message ?? e)}`])
  }
}

/** 検証を通ったものだけ書く。拒否したときは既存の上書きを壊さない。 */
export function writeOverride(dataDir, source, defaults, candidate, navigableKeys = []) {
  const result = validateSelectors(defaults, candidate, navigableKeys)
  if (!result.ok) throw new CalibrationRejected(result.reasons)
  const file = selectorsPath(dataDir, source)
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const body = { ...result.value }
  if (typeof candidate?.version === 'string') body.version = candidate.version
  if (typeof candidate?.note === 'string') body.note = candidate.note
  fs.writeFileSync(file, JSON.stringify(body, null, 2) + '\n')
  return { file, overridden: Object.keys(result.value).sort() }
}

/** 上書きを消して同梱較正へ戻す。 */
export function clearOverride(dataDir, source) {
  const file = selectorsPath(dataDir, source)
  const existed = fs.existsSync(file)
  if (existed) fs.rmSync(file)
  return { file, existed }
}
