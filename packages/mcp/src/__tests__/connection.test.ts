import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import os from 'node:os'
import path from 'node:path'
import {
  AppNotRunningError,
  describeTarget,
  isReachable,
  requestApp,
  resolveTarget,
  type Target,
} from '../connection.js'
import { CLIENT_HEADER, CLIENT_NAME, clientVersion } from '../version.js'
import { toProblem } from '../result.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

/** 本体の代わりに応答する最小のサーバをソケットで立てる。 */
async function startFakeApp(handler: http.RequestListener): Promise<Target> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-mcp-'))
  const socketPath = path.join(dir, 'kanean.sock')
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          fs.rmSync(dir, { recursive: true, force: true })
          resolve()
        })
        server.closeAllConnections?.()
      }),
  )
  return { kind: 'socket', socketPath }
}

describe('接続先の解決', () => {
  it('明示が無ければソケットのみを対象にする', () => {
    const target = resolveTarget({})
    expect(target.kind).toBe('socket')
  })

  it('DATA_DIR を明示すればその下のソケットを見る', () => {
    const target = resolveTarget({ DATA_DIR: '/tmp/mw-data' })
    expect(target).toEqual({ kind: 'socket', socketPath: '/tmp/mw-data/kanean.sock' })
  })

  it('KANEAN_SOCKET が最優先される', () => {
    const target = resolveTarget({ DATA_DIR: '/tmp/mw-data', KANEAN_SOCKET: '/tmp/x.sock' })
    expect(target).toEqual({ kind: 'socket', socketPath: '/tmp/x.sock' })
  })

  it('TCP は KANEAN_BASE_URL を明示したときだけ使う', () => {
    expect(resolveTarget({ KANEAN_BASE_URL: 'http://127.0.0.1:10140' })).toEqual({
      kind: 'tcp',
      host: '127.0.0.1',
      port: 10140,
    })
  })

  it('localhost は 127.0.0.1 に倒す（::1 に解決されて届かないため）', () => {
    expect(resolveTarget({ KANEAN_BASE_URL: 'http://localhost:10140' })).toMatchObject({
      host: '127.0.0.1',
    })
  })

  it('接続先を人へ提示できる', () => {
    expect(describeTarget({ kind: 'socket', socketPath: '/tmp/a.sock' })).toContain('/tmp/a.sock')
    expect(describeTarget({ kind: 'tcp', host: '127.0.0.1', port: 10140 })).toContain('10140')
  })
})

describe('未起動の判別', () => {
  it('ソケットが無ければ「起動していない」と判別する', async () => {
    const target: Target = { kind: 'socket', socketPath: '/tmp/mw-does-not-exist.sock' }
    await expect(requestApp(target, '/health')).rejects.toBeInstanceOf(AppNotRunningError)
  })

  it('異常終了で残ったソケットでも「起動していない」と判別する', async () => {
    // 待ち受けを止めてもソケットファイルは残る（アプリが異常終了した状態の再現）。
    const target = await startFakeApp((_req, res) => res.end('{}'))
    if (target.kind !== 'socket') throw new Error('socket 経路で検証する')
    await cleanups.shift()?.()
    fs.mkdirSync(path.dirname(target.socketPath), { recursive: true })
    const stale = net.createServer()
    await new Promise<void>((resolve) => stale.listen(target.socketPath, resolve))
    await new Promise<void>((resolve) => stale.close(() => resolve()))
    cleanups.push(() => fs.rmSync(path.dirname(target.socketPath), { recursive: true, force: true }))

    await expect(requestApp(target, '/health')).rejects.toBeInstanceOf(AppNotRunningError)
  })

  it('ソケットの場所が別種のファイルでも「起動していない」と判別する', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-stale-'))
    const socketPath = path.join(dir, 'kanean.sock')
    fs.writeFileSync(socketPath, '')
    cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))

    await expect(
      requestApp({ kind: 'socket', socketPath }, '/health'),
    ).rejects.toBeInstanceOf(AppNotRunningError)
  })

  it('明示指定が無いときに TCP へ接続を試みない', async () => {
    // ポートを掴んで待ち構え、接続が来たら記録する。既定経路がここへ来てはいけない。
    const probe = net.createServer()
    await new Promise<void>((resolve) => probe.listen(10140, '127.0.0.1', resolve))
    let connected = false
    probe.on('connection', (socket) => {
      connected = true
      socket.destroy()
    })
    cleanups.push(() => new Promise<void>((resolve) => probe.close(() => resolve())))

    const target = resolveTarget({ DATA_DIR: '/tmp/mw-no-such-dir' })
    await expect(requestApp(target, '/health')).rejects.toBeInstanceOf(AppNotRunningError)
    expect(connected).toBe(false)
  })
})

describe('本体への呼び出し', () => {
  it('ソケット経由で JSON を取得できる', async () => {
    const target = await startFakeApp((_req, res) => {
      res.setHeader('content-type', 'application/json')
      res.end(JSON.stringify({ ok: true }))
    })
    await expect(requestApp(target, '/health')).resolves.toEqual({ ok: true })
  })

  it('対象帳簿をヘッダで渡す', async () => {
    let seen: string | undefined
    const target = await startFakeApp((req, res) => {
      seen = req.headers['x-book-id'] as string | undefined
      res.end('{}')
    })
    await requestApp(target, '/api/books', { bookId: '01J' })
    expect(seen).toBe('01J')
  })

  it('到達確認ができる', async () => {
    const target = await startFakeApp((_req, res) => res.end('{"ok":true}'))
    await expect(isReachable(target)).resolves.toBe(true)
    await expect(isReachable({ kind: 'socket', socketPath: '/tmp/nope.sock' })).resolves.toBe(false)
  })
})

/**
 * 版の名乗り（mcp-server spec「クライアントの版の表明と一致の要求」）。
 *
 * 名乗りは `requestApp` 1箇所に置く。ツールごとに載せる形だと、足し忘れた経路だけが
 * 「版を表明しないクライアント」として拒否され、原因の分かりにくい部分的な不通になる。
 */
describe('クライアントの名乗り', () => {
  it('本体への要求に自分の版を載せる', async () => {
    let seen: string | undefined
    const target = await startFakeApp((req, res) => {
      seen = req.headers[CLIENT_HEADER] as string | undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })

    await requestApp(target, '/api/reports/trial-balance')

    expect(seen).toBe(`${CLIENT_NAME}/${clientVersion()}`)
  })

  it('manifest.json の版を名乗る（版の出所を1つに保つ）', () => {
    const manifest = JSON.parse(
      fs.readFileSync(new URL('../../manifest.json', import.meta.url), 'utf8'),
    ) as { version: string }
    expect(clientVersion()).toBe(manifest.version)
  })

  it('書き込みでも同じように名乗る', async () => {
    let seen: string | undefined
    const target = await startFakeApp((req, res) => {
      seen = req.headers[CLIENT_HEADER] as string | undefined
      res.writeHead(200, { 'content-type': 'application/json' })
      res.end('{}')
    })

    await requestApp(target, '/api/linked-services', { method: 'POST', body: { name: 'x' } })

    expect(seen).toBe(`${CLIENT_NAME}/${clientVersion()}`)
  })
})

/**
 * 拒否の理由が利用者へ届く（mcp-server spec「拒否の理由が利用者へ届く」）。
 *
 * ここが本変更の要。**古いバンドルを更新せずに**入れ直しを案内できるのは、
 * アプリのエラー本文を `fromAppResponse` がそのまま人向けの結果へ通すからである。
 * 成功応答に注記を混ぜてもツールが分配束縛で捨てるので、この経路しか無い。
 */
describe('版の不一致の中継', () => {
  it('アプリの拒否メッセージがそのままツールの結果に出る', async () => {
    const message =
      'この Kanean 拡張（0.1.0）は、いま動いているアプリに同梱された版（0.2.0）と一致しません。' +
      'Kanean の「各種設定 → Claude Desktop と連携」で連携ファイルを書き出し、' +
      'Dock の Claude アイコンへドラッグして入れ直してください。'
    const target = await startFakeApp((_req, res) => {
      res.writeHead(426, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'client_version_mismatch', message } }))
    })

    const result = await requestApp(target, '/api/reports/trial-balance').then(
      () => null,
      (err: unknown) => toProblem(err),
    )

    expect(result?.isError).toBe(true)
    const text = (result?.content as { text: string }[])[0].text
    expect(text).toContain(message)
    expect(text).toContain('client_version_mismatch')
  })

  it('flat な {error: "文字列"}（業務 API の 400）でも理由がそのまま出る', async () => {
    // http/api.ts のエラー応答は `{error: "文字列"}` 形が大半。構造化エンベロープしか
    // 読めないと「Kanean が 400 を返しました」に化けて理由が失われる（issue #161）。
    const target = await startFakeApp((_req, res) => {
      res.writeHead(400, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: '勘定科目が見つかりません: 事業主貸' }))
    })

    const result = await requestApp(target, '/api/reports/trial-balance').then(
      () => null,
      (err: unknown) => toProblem(err),
    )

    expect(result?.isError).toBe(true)
    const text = (result?.content as { text: string }[])[0].text
    expect(text).toContain('勘定科目が見つかりません: 事業主貸')
    expect(text).toContain('http_400')
  })

  it('拒否を「アプリが起動していません」と取り違えない', async () => {
    const target = await startFakeApp((_req, res) => {
      res.writeHead(426, { 'content-type': 'application/json' })
      res.end(JSON.stringify({ error: { code: 'client_version_mismatch', message: '入れ直してください' } }))
    })

    const result = await requestApp(target, '/api/reports/trial-balance').then(
      () => null,
      (err: unknown) => toProblem(err),
    )

    const text = (result?.content as { text: string }[])[0].text
    expect(text).not.toContain('起動していません')
    expect(text).not.toContain('app_not_running')
  })
})
