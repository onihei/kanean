import { afterEach, describe, expect, it, vi } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import { callApp } from '../callApp.js'
import { AppNotRunningError, type Target } from '../connection.js'
import { AppStartTimeoutError, LaunchDeclinedError, type Launcher } from '../launch.js'

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

/** まだ待ち受けていないソケットのパスを用意する（起動前の状態）。 */
function pendingSocket(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-launch-'))
  cleanups.push(() => fs.rmSync(dir, { recursive: true, force: true }))
  return path.join(dir, 'kanean.sock')
}

/** そのパスで待ち受けを始める（アプリが起動した状態）。 */
async function listen(socketPath: string, onRequest: () => void = () => {}): Promise<void> {
  const server = http.createServer((_req, res) => {
    onRequest()
    res.end('{"ok":true}')
  })
  await new Promise<void>((resolve) => server.listen(socketPath, resolve))
  cleanups.push(
    () =>
      new Promise<void>((resolve) => {
        server.close(() => resolve())
        server.closeAllConnections?.()
      }),
  )
}

/** elicitation に対応したクライアントの模擬。 */
function serverWithElicitation(action: 'accept' | 'decline'): Server {
  return {
    getClientCapabilities: () => ({ elicitation: {} }),
    elicitInput: vi.fn().mockResolvedValue({ action }),
  } as unknown as Server
}

/** elicitation に対応しないクライアントの模擬。 */
function serverWithoutElicitation(): Server {
  return { getClientCapabilities: () => ({}) } as unknown as Server
}

describe('未起動時の確認と起動', () => {
  it('承諾されたら起動し、元の呼び出しを再試行して結果を返す', async () => {
    const socketPath = pendingSocket()
    const target: Target = { kind: 'socket', socketPath }
    let requests = 0
    const launcher: Launcher = {
      available: () => true,
      launch: async () => await listen(socketPath, () => requests++),
    }

    const result = await callApp(
      { target, server: serverWithElicitation('accept'), launcher },
      '/health',
    )

    expect(result).toEqual({ ok: true })
    // 起動確認の1回と、元の呼び出しの再試行1回。再試行は増やさない。
    expect(requests).toBe(2)
  })

  it('断られたら起動しない', async () => {
    const socketPath = pendingSocket()
    const launch = vi.fn()
    const launcher: Launcher = { available: () => true, launch }

    await expect(
      callApp({ target: { kind: 'socket', socketPath }, server: serverWithElicitation('decline'), launcher }, '/health'),
    ).rejects.toBeInstanceOf(LaunchDeclinedError)
    expect(launch).not.toHaveBeenCalled()
  })

  it('確認する手段が無ければ勝手に起動せず、未起動として返す', async () => {
    const socketPath = pendingSocket()
    const launch = vi.fn()
    const launcher: Launcher = { available: () => true, launch }

    await expect(
      callApp({ target: { kind: 'socket', socketPath }, server: serverWithoutElicitation(), launcher }, '/health'),
    ).rejects.toBeInstanceOf(AppNotRunningError)
    expect(launch).not.toHaveBeenCalled()
  })

  it('起動したが応答しなければ待ちを打ち切って報告する', async () => {
    const socketPath = pendingSocket()
    // 起動要求は通るが、いつまでも待ち受けが現れない状況。
    const launcher: Launcher = { available: () => true, launch: async () => {} }

    await expect(
      callApp(
        {
          target: { kind: 'socket', socketPath },
          server: serverWithElicitation('accept'),
          launcher,
          launchTimeoutMs: 1_000,
        },
        '/health',
      ),
    ).rejects.toBeInstanceOf(AppStartTimeoutError)
  })

  it('起動済みなら確認を求めない', async () => {
    const socketPath = pendingSocket()
    await listen(socketPath)
    const server = serverWithElicitation('accept')

    await expect(callApp({ target: { kind: 'socket', socketPath }, server }, '/health')).resolves.toEqual({
      ok: true,
    })
    expect(server.elicitInput).not.toHaveBeenCalled()
  })

  it('明示的に承諾済みなら確認を挟まずに起動する', async () => {
    const socketPath = pendingSocket()
    const launcher: Launcher = { available: () => true, launch: () => listen(socketPath) }
    const server = serverWithElicitation('decline') // 呼ばれたら decline になる＝呼ばれてはいけない

    await expect(
      callApp({ target: { kind: 'socket', socketPath }, server, launcher, preapproved: true }, '/health'),
    ).resolves.toEqual({ ok: true })
    expect(server.elicitInput).not.toHaveBeenCalled()
  })
})
