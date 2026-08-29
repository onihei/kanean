import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { BUNDLE_FILENAME, BundleMissingError, bundleStatus, bundledVersion, exportBundle } from '../mcpBundle.js'
import { desktopRoutes } from '../desktopRoutes.js'

/**
 * MCP バンドルの書き出し（mcp-server spec「1クリックで導入できる配布形態」）。
 *
 * 要点は2つ。**ネットワークから取得しない**（同梱物をコピーするだけ）ことと、
 * **クライアントの設定ファイルを触らない**こと。
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

function tempDir(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-bundle-'))
  dirs.push(dir)
  return dir
}

/** 同梱されたバンドルがある状態を作る。 */
function envWithBundle() {
  const src = tempDir()
  const sourcePath = path.join(src, 'kanean.mcpb')
  fs.writeFileSync(sourcePath, 'PK-fake-bundle')
  return { sourcePath, destinationDir: tempDir(), reveal: vi.fn() }
}

describe('書き出しの可否', () => {
  it('同梱物があれば書き出せる', () => {
    expect(bundleStatus(envWithBundle()).available).toBe(true)
  })

  it('同梱物が無ければ書き出せないと分かる', () => {
    const env = { sourcePath: '/tmp/no-such.mcpb', destinationDir: tempDir(), reveal: vi.fn() }
    expect(bundleStatus(env).available).toBe(false)
  })

  it('導入手順を人へ提示できる', () => {
    const steps = bundleStatus(envWithBundle()).steps.join('\n')
    expect(steps).toContain('Claude Desktop')
    expect(steps).toContain('ドラッグ')
  })

  it('落とす先が Dock のアイコンだと分かる（ウィンドウへ落とすとチャットへの添付になる）', () => {
    const steps = bundleStatus(envWithBundle()).steps.join('\n')
    expect(steps).toContain('Dock')
    expect(steps).toContain('添付')
  })
})

describe('書き出し', () => {
  it('同梱物をコピーして Finder で示す', () => {
    const env = envWithBundle()
    const { path: dest } = exportBundle(env)

    expect(path.basename(dest)).toBe(BUNDLE_FILENAME)
    expect(fs.readFileSync(dest, 'utf8')).toBe('PK-fake-bundle')
    expect(env.reveal).toHaveBeenCalledWith(dest)
  })

  it('同じ場所へ書き出し直せる（上書き）', () => {
    const env = envWithBundle()
    exportBundle(env)
    const { path: dest } = exportBundle(env)
    expect(fs.existsSync(dest)).toBe(true)
  })

  it('同梱物が無ければ何も書かずに失敗する', () => {
    const destinationDir = tempDir()
    const env = { sourcePath: '/tmp/no-such.mcpb', destinationDir, reveal: vi.fn() }

    expect(() => exportBundle(env)).toThrow(BundleMissingError)
    expect(fs.readdirSync(destinationDir)).toEqual([])
    expect(env.reveal).not.toHaveBeenCalled()
  })
})

describe('デスクトップ専用ルート', () => {
  it('状態を返す', async () => {
    const app = desktopRoutes(envWithBundle())
    const res = await app.request('/desktop/mcp-bundle')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ available: true })
  })

  it('書き出して場所を返す', async () => {
    const env = envWithBundle()
    const app = desktopRoutes(env)
    const res = await app.request('/desktop/mcp-bundle/export', { method: 'POST' })

    expect(res.status).toBe(200)
    expect((await res.json()).path).toContain(BUNDLE_FILENAME)
    expect(env.reveal).toHaveBeenCalled()
  })

  it('同梱物が無ければ理由を返す', async () => {
    const app = desktopRoutes({
      sourcePath: '/tmp/no-such.mcpb',
      destinationDir: tempDir(),
      reveal: vi.fn(),
    })
    const res = await app.request('/desktop/mcp-bundle/export', { method: 'POST' })
    expect(res.status).toBe(500)
    expect((await res.json()).error).toContain('見つかりません')
  })
})

/**
 * 同梱版の読み取り（design D5・D7）。
 *
 * この値が「配布物に入っている版」＝クライアントの名乗りと突き合わせる基準になる。
 * **開発時は分からない**ので null になり、呼び出し側は検査そのものを行わない。
 */
describe('bundledVersion', () => {
  it('版ファイルを読む', () => {
    const dir = tempDir()
    const file = path.join(dir, 'kanean.mcpb.version')
    fs.writeFileSync(file, '0.2.0\n', 'utf8')
    expect(bundledVersion(file)).toBe('0.2.0')
  })

  it('同梱物が無ければ null（＝検査しない。拒否ではない）', () => {
    expect(bundledVersion(path.join(tempDir(), 'no-such.version'))).toBeNull()
  })

  it('空のファイルも null（版として使えない値を通さない）', () => {
    const file = path.join(tempDir(), 'empty.version')
    fs.writeFileSync(file, '  \n', 'utf8')
    expect(bundledVersion(file)).toBeNull()
  })
})
