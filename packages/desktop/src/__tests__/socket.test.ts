import { describe, it, expect, afterEach } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Hono } from 'hono'
import { serve } from '@hono/node-server'
import { startLocalSocket, defaultSocketPath, MAX_SOCKET_PATH_BYTES, SocketPathTooLongError, type LocalSocketServer } from '../socket.js'

/**
 * ローカルソケット（local-access spec）の契約テスト。
 * 「TCP 経路と socket 経路で振る舞いが一致する」ことが本丸（tasks §6.5）。
 */

/** unix socket 経由で HTTP を1往復させる。 */
function requestOverSocket(
  socketPath: string,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { socketPath, path: options.path, method: options.method ?? 'GET', headers: options.headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (c: Buffer) => chunks.push(c))
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(chunks).toString('utf8') }))
      },
    )
    req.once('error', reject)
    if (options.body !== undefined) req.write(options.body)
    req.end()
  })
}

/** 同じアプリを TCP に載せて1往復させる（比較対象）。 */
async function requestOverTcp(
  app: Hono,
  options: { method?: string; path: string; headers?: Record<string, string>; body?: string | Buffer },
): Promise<{ status: number; body: string }> {
  // listen 完了はコールバックで通知される。`serve()` 直後に address() を読むと
  // まだ bind されておらずポート 0 になる（それに気づかず 127.0.0.1:0 へ繋ぎに行くと EADDRNOTAVAIL）。
  let server!: ReturnType<typeof serve>
  const port = await new Promise<number>((resolve) => {
    server = serve({ fetch: app.fetch, port: 0, hostname: '127.0.0.1' }, (info) => resolve(info.port))
  })
  try {
    const res = await fetch(`http://127.0.0.1:${port}${options.path}`, {
      method: options.method ?? 'GET',
      headers: options.headers,
      body: options.body as BodyInit | undefined,
    })
    return { status: res.status, body: await res.text() }
  } finally {
    await new Promise<void>((r) => server.close(() => r()))
  }
}

/** `/skill` と同じ形（ボディ上限つき）の最小アプリ。 */
function makeApp(): Hono {
  const app = new Hono()
  app.get('/skill/ping', (c) => c.json({ ok: true, route: 'skill' }))
  app.get('/api/books', (c) => c.json({ books: [{ id: 'b1', name: 'マイ帳簿' }] }))
  app.post('/skill/echo', async (c) => {
    const raw = await c.req.text()
    if (raw.length > 5 * 1024 * 1024) return c.json({ error: { code: 'validation_error', message: 'request body too large' } }, 413)
    return c.json({ bytes: raw.length, bookId: c.req.header('X-Book-Id') ?? null })
  })
  return app
}

let opened: LocalSocketServer | null = null
let tmp: string | null = null

afterEach(async () => {
  await opened?.close()
  opened = null
  if (tmp) fs.rmSync(tmp, { recursive: true, force: true })
  tmp = null
})

function tmpDir(): string {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-sock-'))
  return tmp
}

describe('ローカルソケット', () => {
  it('起動でソケットが現れ、/skill を認証なしで受ける', async () => {
    const dir = tmpDir()
    const app = makeApp()
    opened = await startLocalSocket(app.fetch, defaultSocketPath(dir))

    expect(fs.existsSync(opened.path)).toBe(true)
    const res = await requestOverSocket(opened.path, { path: '/skill/ping' })
    expect(res.status).toBe(200)
    expect(JSON.parse(res.body)).toEqual({ ok: true, route: 'skill' })
  })

  it('終了でソケットファイルが消える', async () => {
    const dir = tmpDir()
    const s = await startLocalSocket(makeApp().fetch, defaultSocketPath(dir))
    expect(fs.existsSync(s.path)).toBe(true)
    await s.close()
    expect(fs.existsSync(s.path)).toBe(false)
  })

  it('起動していなければ接続に失敗し、クライアントが判別できる', async () => {
    const dir = tmpDir()
    await expect(requestOverSocket(defaultSocketPath(dir), { path: '/skill/ping' })).rejects.toMatchObject({
      code: 'ENOENT',
    })
  })

  it('異常終了で残ったソケットファイルがあっても起動できる', async () => {
    const dir = tmpDir()
    const p = defaultSocketPath(dir)
    fs.writeFileSync(p, '') // 前回の残骸を模す
    opened = await startLocalSocket(makeApp().fetch, p)
    const res = await requestOverSocket(opened.path, { path: '/skill/ping' })
    expect(res.status).toBe(200)
  })

  it('パスが長すぎると明示的に失敗する（黙って起動失敗しない）', async () => {
    const dir = tmpDir()
    const deep = path.join(dir, 'x'.repeat(MAX_SOCKET_PATH_BYTES), 'kanean.sock')
    await expect(startLocalSocket(makeApp().fetch, deep)).rejects.toBeInstanceOf(SocketPathTooLongError)
  })

  it('所有者のみ接続できる権限になっている', async () => {
    const dir = tmpDir()
    opened = await startLocalSocket(makeApp().fetch, defaultSocketPath(dir))
    expect(fs.statSync(opened.path).mode & 0o777).toBe(0o600)
  })

  it('TCP 経路と socket 経路で振る舞いが一致する', async () => {
    const dir = tmpDir()
    const app = makeApp()
    opened = await startLocalSocket(app.fetch, defaultSocketPath(dir))

    const cases = [
      { path: '/skill/ping' },
      { path: '/api/books' },
      { path: '/skill/echo', method: 'POST', headers: { 'X-Book-Id': 'b_header', 'Content-Type': 'text/plain' }, body: 'hello' },
      { path: '/nope' },
    ]

    for (const c of cases) {
      const viaSocket = await requestOverSocket(opened.path, c)
      const viaTcp = await requestOverTcp(app, c)
      expect({ case: c.path, ...viaSocket }).toEqual({ case: c.path, ...viaTcp })
    }
  })
})
