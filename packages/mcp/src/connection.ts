import fs from 'node:fs'
import http from 'node:http'
import { clientHeaders } from './version.js'
import { defaultDataDir, socketPathIn } from '@kanean/shared/node'

/**
 * 起動中のアプリへの到達（mcp-server spec「ローカルアプリへの MCP 接続」）。
 *
 * **既定はローカルソケットのみ**を試す。ソケットが無ければ「アプリが起動していない」と
 * 判別し、TCP ポートを探しに行かない。配布したバンドルが暗黙にポートを探すと、
 * ①デスクトップ版は TCP を開かないという設計と食い違って見え、
 * ②別プロセスがそのポートを掴んでいた場合に誤接続しうるため。
 * 開発時は `KANEAN_BASE_URL` を**明示したときだけ** TCP 経路を使う。
 */

/** アプリが起動していない（ソケットが無い／接続を拒否された）。 */
export class AppNotRunningError extends Error {
  constructor(readonly target: Target) {
    super('Kanean が起動していません')
    this.name = 'AppNotRunningError'
  }
}

/** 処理の途中でアプリが終了して到達できなくなった。黙って再試行しない。 */
export class AppStoppedError extends Error {
  constructor() {
    super('処理の途中で Kanean が終了しました')
    this.name = 'AppStoppedError'
  }
}

/** 本体が返したエラー応答（4xx/5xx）。本文をそのまま持ち回して人へ提示する。 */
export class AppResponseError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`Kanean が ${status} を返しました`)
    this.name = 'AppResponseError'
  }
}

export type Target =
  | { kind: 'socket'; socketPath: string }
  | { kind: 'tcp'; host: string; port: number }

/** デスクトップ版の既定の `DATA_DIR`（実体は @kanean/shared/node・issue #167）。 */
export { defaultDataDir } from '@kanean/shared/node'

/**
 * 接続先を決める。**明示が無い限りソケットのみ**。
 *
 * 1. `KANEAN_BASE_URL` … 明示されたときだけ TCP（開発時のサーバ単体起動用）
 * 2. `KANEAN_SOCKET` … ソケットの明示
 * 3. `$DATA_DIR/kanean.sock` … `DATA_DIR` を明示している検証環境
 * 4. `<userData>/data/kanean.sock` … デスクトップ版の既定
 */
export function resolveTarget(env: NodeJS.ProcessEnv = process.env): Target {
  const baseUrl = env.KANEAN_BASE_URL?.trim()
  if (baseUrl) {
    const url = new URL(baseUrl)
    // `localhost` は環境により `::1` へ解決されて届かないことがある（取込スキルと同じ規約）。
    const host = url.hostname === 'localhost' ? '127.0.0.1' : url.hostname
    return { kind: 'tcp', host, port: Number(url.port || 80) }
  }

  const explicitSocket = env.KANEAN_SOCKET?.trim()
  if (explicitSocket) return { kind: 'socket', socketPath: explicitSocket }

  const dataDir = env.DATA_DIR?.trim() || defaultDataDir()
  return { kind: 'socket', socketPath: socketPathIn(dataDir) }
}

/** 人へ提示するための接続先の呼び名。 */
export function describeTarget(target: Target): string {
  return target.kind === 'socket'
    ? `ローカルソケット（${target.socketPath}）`
    : `${target.host}:${target.port}`
}

export interface RequestOptions {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'
  /** 対象帳簿。1冊なら省略でよい（解決は本体の規約に従う）。 */
  bookId?: string
  body?: unknown
  /** 生バイナリ送信（証憑アップロード等）。body と排他。content-type はここで指定する。 */
  rawBody?: { bytes: Buffer; contentType: string }
  timeoutMs?: number
}

/**
 * 本体の HTTP API を呼ぶ。socket / TCP のどちらでも呼び方は同じ。
 *
 * 認証は無い（同一マシンから到達できること自体が認可＝[[local-access]]）。
 */
export function requestApp<T>(
  target: Target,
  urlPath: string,
  options: RequestOptions = {},
): Promise<T> {
  const { method = 'GET', bookId, body, rawBody, timeoutMs = 30_000 } = options

  // ソケット経路は「ファイルが無い＝アプリが起動していない」が即座に判る。
  if (target.kind === 'socket' && !fs.existsSync(target.socketPath)) {
    return Promise.reject(new AppNotRunningError(target))
  }

  const payload =
    rawBody !== undefined
      ? rawBody.bytes
      : body === undefined
        ? undefined
        : Buffer.from(JSON.stringify(body), 'utf8')
  // 名乗りは**ここ1箇所**で載せる。ツールごとの実装に散らすと、足し忘れた経路だけが
  // 「版を名乗らないクライアント」として拒否される（mcp-server spec）。
  const headers: Record<string, string> = { accept: 'application/json', ...clientHeaders() }
  if (bookId) headers['x-book-id'] = bookId
  if (payload) {
    headers['content-type'] = rawBody?.contentType ?? 'application/json'
    headers['content-length'] = String(payload.byteLength)
  }

  return new Promise<T>((resolve, reject) => {
    const req = http.request(
      target.kind === 'socket'
        ? { socketPath: target.socketPath, path: urlPath, method, headers }
        : { host: target.host, port: target.port, path: urlPath, method, headers },
      (res) => {
        const chunks: Buffer[] = []
        res.on('data', (chunk: Buffer) => chunks.push(chunk))
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8')
          let parsed: unknown = text
          try {
            parsed = text ? JSON.parse(text) : null
          } catch {
            // JSON でない応答（PDF・CSV 等）はそのまま文字列で返す。
          }
          const status = res.statusCode ?? 0
          if (status >= 200 && status < 300) resolve(parsed as T)
          else reject(new AppResponseError(status, parsed))
        })
      },
    )

    req.setTimeout(timeoutMs, () => req.destroy(new Error('応答がありません（タイムアウト）')))

    req.on('error', (err: NodeJS.ErrnoException) => {
      // 接続が確立できない＝待ち受けが消えている。ソケットは起動中しか存在しないので、
      // 「起動していない」と「途中で終了した」を呼び出し側が区別できる形で返す。
      //   ENOENT      … ソケットが無い（通常の未起動）
      //   ECONNREFUSED… 異常終了で残った残骸（誰も待ち受けていない）
      //   ENOTSOCK    … その場所がソケットでない別のファイル
      // いずれも「そこには誰もいない」＝未起動として扱う。アプリ側は起動時に残骸を
      // 掃除するので、起動を促すのが利用者にとって正しい次の一手になる。
      if (err.code === 'ENOENT' || err.code === 'ECONNREFUSED' || err.code === 'ENOTSOCK') {
        reject(new AppNotRunningError(target))
      } else if (err.code === 'ECONNRESET' || err.code === 'EPIPE') {
        reject(new AppStoppedError())
      } else {
        reject(err)
      }
    })

    if (payload) req.write(payload)
    req.end()
  })
}

/** 到達できるか（アプリが起動しているか）を短いタイムアウトで確かめる。 */
export async function isReachable(target: Target): Promise<boolean> {
  try {
    await requestApp(target, '/health', { timeoutMs: 3_000 })
    return true
  } catch {
    return false
  }
}
