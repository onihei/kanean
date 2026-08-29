import { describe, expect, it } from 'vitest'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

/**
 * 型だけを共有し、**実装は持ち込まない**（design D2）ことを固定する。
 *
 * ブリッジに会計ロジックが入り込むと、検証・期間ゲート・冪等・帳簿解決の規則が
 * 本体と2箇所に分かれて必ずずれる。ここは「うっかり実装を import した」を機械で止める。
 */

const srcDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

/** 実行時に読み込むと本体の実装（DB・Hono・会計計算）を引き込んでしまう指定。 */
const FORBIDDEN_RUNTIME_IMPORTS = [
  '@kanean/server/app',
  '@kanean/server/config',
  '@kanean/core',
  'better-sqlite3',
  'drizzle-orm',
]

function sourceFiles(dir: string): string[] {
  return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) return entry.name === '__tests__' ? [] : sourceFiles(full)
    return entry.name.endsWith('.ts') ? [full] : []
  })
}

describe('本体との境界', () => {
  it('実装を引き込む import を持たない', () => {
    for (const file of sourceFiles(srcDir)) {
      const text = fs.readFileSync(file, 'utf8')
      for (const forbidden of FORBIDDEN_RUNTIME_IMPORTS) {
        expect(text.includes(`from '${forbidden}'`), `${path.basename(file)} が ${forbidden} を import している`).toBe(false)
      }
    }
  })

  it('本体の型は値としてではなく型としてのみ取り込む', () => {
    // `export type { … } from` に限る。値の再輸出になると実行時に本体を読み込む。
    const text = fs.readFileSync(path.join(srcDir, 'apiTypes.ts'), 'utf8')
    const serverImports = text.match(/^(export|import)\s+(type\s+)?\{[^}]*\}\s+from\s+'@kanean\/[^']*'/gm) ?? []
    expect(serverImports.length).toBeGreaterThan(0)
    for (const line of serverImports) expect(line.startsWith('export type')).toBe(true)
  })
})

/**
 * apiTypes.ts の不変条件（issue #163）: **ここに並ぶ再輸出はすべて src 内で使われている**。
 * 使われない再輸出を許すと「契約面の一望」が嘘になり、実態とズレた型
 * （かつて LinkedService は実際に叩く GET /api/services と別物の同名型だった）が居座る。
 */
describe('apiTypes.ts の再輸出', () => {
  it('全て src 内（テスト除く）で参照されている（未使用の再輸出を置かない）', () => {
    const text = fs.readFileSync(path.join(srcDir, 'apiTypes.ts'), 'utf8')
    const names: string[] = []
    for (const block of text.matchAll(/export type \{([^}]*)\}/g)) {
      for (const raw of block[1].split(',')) {
        const n = raw.trim()
        if (n) names.push(n)
      }
    }
    expect(names.length).toBeGreaterThan(0)

    const corpus = sourceFiles(srcDir)
      .filter((f) => path.basename(f) !== 'apiTypes.ts')
      .map((f) => fs.readFileSync(f, 'utf8'))
      .join('\n')
    const unused = names.filter((n) => !new RegExp(`\\b${n}\\b`).test(corpus))
    expect(unused).toEqual([])
  })
})
