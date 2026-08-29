import path from 'node:path'
import type { ScrapeResult } from '@kanean/acquisition'
import { writeJsonAtomic } from './paths.js'

/**
 * 巡回結果をそのままファイルへ落とす**検証専用**の口（tasks 4.3 / 10.4）。
 *
 * 取込は取得結果を貯めない（design D4: 取れたらそのまま importer へ流して捨てる）。
 * そのため「Playwright 殻と Electron 殻の出力 JSON が一致すること」を確かめようにも、
 * Electron 側に突き合わせる相手のファイルが存在しない。ここはその相手を作るためだけにある。
 *
 * `KANEAN_ACQ_DUMP` が立っているときだけ書く＝**既定では何もしない**。
 * 配布物では環境変数が無いので経路ごと死んでいる。
 *
 * 落ちる中身は `bin/scrape.mjs` の `--out` と**同じ形**にする（`exitCode` を落とし、
 * 2 スペース + 末尾改行）。そうしておくと素の `diff` でも突き合わせられる。
 *
 * ⚠ 中身は品名・金額・取引識別子を含む生の巡回結果。検証が済んだら消すこと。
 */

/** 検証用ダンプの出力先。未設定なら null＝ダンプしない。 */
export function dumpDir(): string | null {
  const raw = process.env.KANEAN_ACQ_DUMP?.trim()
  return raw ? path.resolve(raw) : null
}

/**
 * 巡回結果を `<KANEAN_ACQ_DUMP>/<source>.json` へ書く。
 * 検証の補助でしかないので、**失敗しても取込は止めない**（書けなければ黙って諦める）。
 * @returns 書いたパス。ダンプしなかったときは null。
 */
export function dumpIfRequested(source: string, result: ScrapeResult): string | null {
  const dir = dumpDir()
  if (!dir) return null
  try {
    const file = path.join(dir, `${source}.json`)
    const output: Record<string, unknown> = { ...result }
    delete output.exitCode // CLI の --out が落としているので合わせる
    writeJsonAtomic(file, output)
    return file
  } catch {
    return null
  }
}
