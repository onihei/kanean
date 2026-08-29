import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { readJsonSafe, writeJsonAtomic, watermarkFile, jobsDir, policyFile } from '../paths.js'

/** acquisition の JSON 永続化ヘルパ（issue #147）。パス規約と「壊れても既定値・書きかけを残さない」を固定する。 */

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-acqpaths-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('パス規約', () => {
  it('$DATA_DIR/acquisition/ 配下に揃う', () => {
    expect(watermarkFile('/d')).toBe(path.join('/d', 'acquisition', 'watermarks.json'))
    expect(jobsDir('/d')).toBe(path.join('/d', 'acquisition', 'jobs'))
    expect(policyFile('/d')).toBe(path.join('/d', 'acquisition', 'classification-policy.md'))
  })
})

describe('readJsonSafe', () => {
  it('無いファイル・壊れた JSON・非オブジェクトは fallback', () => {
    const f = path.join(tmp, 'x.json')
    expect(readJsonSafe(f, { a: 1 })).toEqual({ a: 1 })
    fs.writeFileSync(f, '{broken')
    expect(readJsonSafe(f, { a: 1 })).toEqual({ a: 1 })
    fs.writeFileSync(f, '"str"')
    expect(readJsonSafe(f, { a: 1 })).toEqual({ a: 1 })
  })

  it('正常な JSON はそのまま返す', () => {
    const f = path.join(tmp, 'x.json')
    fs.writeFileSync(f, '{"k":"2026-05-01"}')
    expect(readJsonSafe<Record<string, string>>(f, {})).toEqual({ k: '2026-05-01' })
  })
})

describe('writeJsonAtomic', () => {
  it('ディレクトリごと作成し、改行終端の pretty JSON を書き、temp を残さない', () => {
    const f = path.join(tmp, 'deep', 'nested', 'w.json')
    writeJsonAtomic(f, { k: 'v' })
    expect(fs.readFileSync(f, 'utf8')).toBe('{\n  "k": "v"\n}\n')
    expect(fs.existsSync(`${f}.tmp`)).toBe(false)
  })

  it('上書きしても読み側と常に整合する（temp→rename の置換）', () => {
    const f = path.join(tmp, 'w.json')
    writeJsonAtomic(f, { gen: 1 })
    writeJsonAtomic(f, { gen: 2 })
    expect(readJsonSafe(f, {})).toEqual({ gen: 2 })
    expect(fs.readdirSync(tmp)).toEqual(['w.json']) // 書きかけの残骸なし
  })
})
