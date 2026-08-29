import fs from 'node:fs'
import http from 'node:http'
import net from 'node:net'
import path from 'node:path'
import { getRequestListener } from '@hono/node-server'
import { socketPathIn } from '@kanean/shared/node'

/**
 * ローカル連携用の unix domain socket（local-access spec「アプリ寿命に縛られたローカルソケット」）。
 *
 * 取込スキル（acquisition）と将来の MCP サーバはここへ繋ぐ。TCP ポートを使わないので
 *   - ポート衝突が起きない
 *   - 開いているポートとして観測されない
 *   - **ソケットファイルの存在＝アプリ起動中**が目で分かる
 * という性質を持つ。アプリ終了時に必ず削除する。
 *
 * このモジュールは electron に依存しない（node の http/net のみ）。テスト可能にするため。
 */

/** macOS の `sun_path` 上限（実測: 104 バイトまで bind 可、105 で EINVAL）。 */
export const MAX_SOCKET_PATH_BYTES = 104

export type LocalSocketServer = {
  /** 待ち受けているソケットのパス。 */
  path: string
  /** 待ち受けを止めてソケットファイルを削除する。 */
  close: () => Promise<void>
}

export class SocketPathTooLongError extends Error {
  constructor(socketPath: string, bytes: number) {
    super(
      `ローカルソケットのパスが長すぎます（${bytes} バイト / 上限 ${MAX_SOCKET_PATH_BYTES} バイト）: ${socketPath}\n` +
        'DATA_DIR をより浅い場所に設定してください。',
    )
    this.name = 'SocketPathTooLongError'
  }
}

export class SocketInUseError extends Error {
  constructor(socketPath: string) {
    super(`ローカルソケットが既に使用中です（別のインスタンスが起動している可能性があります）: ${socketPath}`)
    this.name = 'SocketInUseError'
  }
}

/** 既存のソケットファイルが「生きている」か「異常終了の残骸」かを判定する。 */
function probeExisting(socketPath: string): Promise<'alive' | 'stale'> {
  return new Promise((resolve) => {
    const sock = net.connect({ path: socketPath })
    const done = (r: 'alive' | 'stale') => {
      sock.removeAllListeners()
      sock.destroy()
      resolve(r)
    }
    sock.once('connect', () => done('alive'))
    // ECONNREFUSED = 誰も待ち受けていない＝残骸。
    sock.once('error', () => done('stale'))
    setTimeout(() => done('stale'), 1000)
  })
}

/**
 * ソケットで待ち受けを開始する。
 * 異常終了で残ったソケットファイルは掃除してから待ち受ける（local-access spec）。
 */
export async function startLocalSocket(
  fetchHandler: (request: Request) => Response | Promise<Response>,
  socketPath: string,
): Promise<LocalSocketServer> {
  const bytes = Buffer.byteLength(socketPath, 'utf8')
  if (bytes > MAX_SOCKET_PATH_BYTES) throw new SocketPathTooLongError(socketPath, bytes)

  fs.mkdirSync(path.dirname(socketPath), { recursive: true })

  if (fs.existsSync(socketPath)) {
    if ((await probeExisting(socketPath)) === 'alive') throw new SocketInUseError(socketPath)
    fs.rmSync(socketPath, { force: true }) // 残骸を掃除する
  }

  const server = http.createServer(getRequestListener(fetchHandler))

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen(socketPath, () => {
      server.removeListener('error', reject)
      resolve()
    })
  })

  // 所有者以外は接続できないようにする（ローカル多ユーザー環境での多層防御）。
  fs.chmodSync(socketPath, 0o600)

  return {
    path: socketPath,
    close: () =>
      new Promise<void>((resolve) => {
        server.close(() => {
          fs.rmSync(socketPath, { force: true })
          resolve()
        })
        // 接続中のクライアントがいても待たずに閉じる（終了を遅延させない）。
        server.closeAllConnections?.()
      }),
  }
}

/** `$DATA_DIR/kanean.sock`（design task 2.2。パス規約は @kanean/shared/node が正）。 */
export function defaultSocketPath(dataDir: string): string {
  return socketPathIn(dataDir)
}
