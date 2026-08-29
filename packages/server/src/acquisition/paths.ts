import fs from 'node:fs'
import path from 'node:path'

/**
 * `$DATA_DIR/acquisition/` 配下のパス規約と JSON 永続化の小ヘルパ（issue #147）。
 * ここにあるのは運用データ（ジョブ記録・差分終端・分類方針の上書き）で会計データではない
 * ＝data plane（帳簿 DB）には置かない。パス組み立て・「読めなければ既定値」・原子的書き込みが
 * 各ファイルに独立実装されていたのを一本化する。
 * （packages/acquisition 側の selectors/diagnostics/evidence は別パッケージのため対象外。）
 */

export function acquisitionDir(dataDir: string): string {
  return path.join(dataDir, 'acquisition')
}

/** 取込ジョブの記録（store.ts）。 */
export function jobsDir(dataDir: string): string {
  return path.join(acquisitionDir(dataDir), 'jobs')
}

/** 差分の連続終端（watermark.ts）。 */
export function watermarkFile(dataDir: string): string {
  return path.join(acquisitionDir(dataDir), 'watermarks.json')
}

/** 分類方針の上書き（policy.ts。同梱既定へのオーバーレイ）。 */
export function policyFile(dataDir: string): string {
  return path.join(acquisitionDir(dataDir), 'classification-policy.md')
}

/** existsSync → parse → 壊れていたら fallback（3実装あった読みの一本化）。 */
export function readJsonSafe<T>(file: string, fallback: T): T {
  if (!fs.existsSync(file)) return fallback
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed != null && typeof parsed === 'object' ? (parsed as T) : fallback
  } catch {
    return fallback
  }
}

/**
 * JSON を temp→rename で原子的に書く。in-place 書きだとクラッシュのタイミング次第で半端な
 * ファイルが残り、読み側が既定値に倒す＝watermarks.json なら連続終端が全消失して全期間を
 * 取り直すことになる（watermark.ts の JSDoc が回避したい事象そのもの）。同一ディレクトリ内
 * rename なので置換は原子的。単一プロセス・同期 I/O 前提のため temp 名は固定サフィックスで足りる。
 */
export function writeJsonAtomic(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n')
  fs.renameSync(tmp, file)
}
