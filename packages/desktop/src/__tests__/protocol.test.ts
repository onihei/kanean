import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createProtocolHandler, isApiPath, serveWebAsset, type FileFetch } from '../protocol.js'

/**
 * カスタムプロトコル配信（desktop-app spec「UI へのアプリ内配信」）。
 *
 * ここは **UI と業務 API の境界そのもの**。isApiPath の振り分けと、
 * serveWebAsset のパストラバーサル遮断が壊れても他に気付く仕組みが無いので、テストで固定する。
 * electron には依存しない（ファイル取得は fetchImpl で注入する）。
 */

const dirs: string[] = []
afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true, force: true })
})

/** webDist（index.html＋資材）と、その**外**に秘密ファイルを持つ木を作る。 */
function makeTree() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-protocol-'))
  dirs.push(root)
  const webDist = path.join(root, 'dist')
  fs.mkdirSync(path.join(webDist, 'assets'), { recursive: true })
  fs.writeFileSync(path.join(webDist, 'index.html'), '<html>INDEX</html>')
  fs.writeFileSync(path.join(webDist, 'assets', 'app.js'), 'console.log("app")')
  fs.writeFileSync(path.join(webDist, 'font.pfb'), 'FONT')
  // webDist の外＝配信してはならないファイル
  fs.writeFileSync(path.join(root, 'secret.txt'), 'SECRET')
  return { root, webDist }
}

/** electron の net.fetch の代わり。file:// URL を素朴に読む。 */
const fileFetch: FileFetch = async (url) => new Response(fs.readFileSync(fileURLToPath(url)))

describe('isApiPath — UI と業務 API の境界', () => {
  it('api・skill・health は API 側', () => {
    expect(isApiPath('/api')).toBe(true)
    expect(isApiPath('/api/')).toBe(true)
    expect(isApiPath('/api/entries')).toBe(true)
    expect(isApiPath('/skill/import')).toBe(true)
    expect(isApiPath('/health')).toBe(true)
  })

  it('それ以外は静的資材側（前方一致で誤って API に流さない）', () => {
    expect(isApiPath('/')).toBe(false)
    expect(isApiPath('/index.html')).toBe(false)
    expect(isApiPath('/apifoo')).toBe(false)
    expect(isApiPath('/healthz')).toBe(false)
    expect(isApiPath('/assets/api/x.js')).toBe(false)
  })
})

describe('serveWebAsset — 静的配信と遮断', () => {
  it('実在する資材を MIME 付きで返す', async () => {
    const { webDist } = makeTree()
    const res = await serveWebAsset('/assets/app.js', webDist, fileFetch)
    expect(res.status).toBe(200)
    expect(res.headers.get('Content-Type')).toBe('text/javascript; charset=utf-8')
    expect(await res.text()).toContain('console.log')
  })

  it('未知の拡張子は octet-stream にする', async () => {
    const { webDist } = makeTree()
    const res = await serveWebAsset('/font.pfb', webDist, fileFetch)
    expect(res.headers.get('Content-Type')).toBe('application/octet-stream')
  })

  it('未知のパスは index.html へフォールバックする（SPA）', async () => {
    const { webDist } = makeTree()
    const res = await serveWebAsset('/journal', webDist, fileFetch)
    expect(res.headers.get('Content-Type')).toBe('text/html; charset=utf-8')
    expect(await res.text()).toBe('<html>INDEX</html>')
  })

  it('パストラバーサルは webDist の外へ出ず index.html へ倒す', async () => {
    const { webDist } = makeTree()
    const res = await serveWebAsset('/../secret.txt', webDist, fileFetch)
    expect(await res.text()).toBe('<html>INDEX</html>')
  })

  it('URL エンコードされたトラバーサル（%2e%2e）も同様に遮断する', async () => {
    const { webDist } = makeTree()
    const res = await serveWebAsset('/%2e%2e/secret.txt', webDist, fileFetch)
    expect(await res.text()).toBe('<html>INDEX</html>')
  })

  it('webDist と同名の接頭辞を持つ隣のディレクトリを内側と誤判定しない', async () => {
    // 例: dist と dist-evil。startsWith(webDist) だけだと通ってしまう境界。
    const { root, webDist } = makeTree()
    fs.mkdirSync(path.join(root, 'dist-evil'))
    fs.writeFileSync(path.join(root, 'dist-evil', 'a.txt'), 'EVIL')
    const res = await serveWebAsset('/../dist-evil/a.txt', webDist, fileFetch)
    expect(await res.text()).toBe('<html>INDEX</html>')
  })

  it('ビルド成果物が無ければ 500 と案内を返す', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-protocol-empty-'))
    dirs.push(root)
    const res = await serveWebAsset('/', path.join(root, 'no-dist'), fileFetch)
    expect(res.status).toBe(500)
    expect(await res.text()).toContain('pnpm build')
  })
})

describe('createProtocolHandler — 振り分け', () => {
  it('API パスは Hono へ、その他は静的資材へ流す', async () => {
    const { webDist } = makeTree()
    const seen: string[] = []
    const hono = {
      fetch: (req: Request) => {
        seen.push(new URL(req.url).pathname)
        return new Response('{"ok":true}', { headers: { 'Content-Type': 'application/json' } })
      },
    }
    const handler = createProtocolHandler(hono, webDist, fileFetch)

    const api = await handler(new Request('kanean://local/api/health'))
    expect(await api.text()).toBe('{"ok":true}')
    expect(seen).toEqual(['/api/health'])

    const ui = await handler(new Request('kanean://local/'))
    expect(await ui.text()).toBe('<html>INDEX</html>')
    expect(seen).toEqual(['/api/health']) // UI 要求は Hono に流れない
  })
})
