import { describe, it, expect } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * d.ts と実装の export 集合一致（issue #170）。
 * 実装は素の ESM で型検査が働かないため、d.ts が実装から黙って乖離できる
 * （実測で 33 export 中 10 個が未宣言だった）。値 export の集合一致を機械で固定する。
 */

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/** d.ts から**値**の宣言名を集める（interface / type は実行時に存在しないので対象外）。 */
function declaredValueNames(dtsFile) {
  const text = fs.readFileSync(path.join(root, 'types', dtsFile), 'utf8')
  const names = new Set()
  for (const m of text.matchAll(/^export declare (?:const|function|class) ([A-Za-z0-9_]+)/gm)) {
    names.add(m[1])
  }
  return names
}

async function runtimeNames(entry) {
  return new Set(Object.keys(await import(entry)))
}

function diff(label, actual, declared) {
  const undeclared = [...actual].filter((n) => !declared.has(n))
  const phantom = [...declared].filter((n) => !actual.has(n))
  expect(undeclared, `${label}: d.ts に未宣言の export`).toEqual([])
  expect(phantom, `${label}: 実装に無い宣言（幽霊 export）`).toEqual([])
}

describe('d.ts と実装の export 集合一致', () => {
  it('index.mjs ↔ types/index.d.ts', async () => {
    diff('index', await runtimeNames('../index.mjs'), declaredValueNames('index.d.ts'))
  })

  it('runtime/electron.mjs ↔ types/electron.d.ts', async () => {
    diff('electron', await runtimeNames('../runtime/electron.mjs'), declaredValueNames('electron.d.ts'))
  })
})
