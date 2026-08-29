import type { Server } from '@modelcontextprotocol/sdk/server/index.js'
import {
  AppNotRunningError,
  requestApp,
  type RequestOptions,
  type Target,
} from './connection.js'
import {
  launchAndWait,
  LaunchDeclinedError,
  LAUNCH_TIMEOUT_MS,
  macLauncher,
  type Launcher,
} from './launch.js'

/**
 * ツールから本体 API を呼ぶ唯一の入口。
 *
 * アプリが起動していなければ、**確認を得てから**起動し、元の呼び出しを**1回だけ**再試行する
 * （mcp-server spec「アプリ未起動の検知と確認付き起動」）。再試行は1回に固定する。
 * 何度も試すと、落ちているアプリを相手に会話が固まるため。
 */

/** 起動の確認の取り方。クライアントが確認 UI を持たない場合に備えて分岐する。 */
export type Consent = 'accepted' | 'declined' | 'unsupported'

export interface CallContext {
  target: Target
  /** 確認 UI を持つクライアントに問い合わせるためのサーバ。 */
  server?: Server
  launcher?: Launcher
  /** 利用者が既に起動へ同意している場合（例: 起動ツールを明示的に呼ばれた）。 */
  preapproved?: boolean
  /** 起動後に到達可能になるまで待つ上限。 */
  launchTimeoutMs?: number
}

/**
 * クライアントに「Kanean を起動してよいか」を尋ねる。
 *
 * MCP の elicitation に対応したクライアントならその場で確認できる。対応していなければ
 * `unsupported` を返し、呼び出し側が「人に確認してから起動ツールを呼ぶ」導線へ倒す。
 */
export async function askToLaunch(server: Server | undefined): Promise<Consent> {
  if (!server?.getClientCapabilities()?.elicitation) return 'unsupported'
  try {
    const result = await server.elicitInput({
      mode: 'form',
      message:
        'Kanean が起動していません。会計データを読むにはアプリの起動が必要です。起動してよいですか？',
      requestedSchema: { type: 'object', properties: {} },
    })
    return result.action === 'accept' ? 'accepted' : 'declined'
  } catch {
    // 確認そのものに失敗したら、黙って起動はしない（安全側）。
    return 'unsupported'
  }
}

/**
 * 本体 API を呼ぶ。未起動なら確認 → 起動 → 1回だけ再試行。
 *
 * @throws {AppNotRunningError} 未起動で、確認する手段が無い（呼び出し側が人へ案内する）
 * @throws {LaunchDeclinedError} 利用者が起動を承諾しなかった
 * @throws {AppStartTimeoutError} 起動したが時間内に応答しなかった
 * @throws {AppStoppedError} 処理の途中でアプリが終了した
 */
export async function callApp<T>(
  ctx: CallContext,
  urlPath: string,
  options: RequestOptions = {},
): Promise<T> {
  const {
    target,
    server,
    launcher = macLauncher,
    preapproved = false,
    launchTimeoutMs = LAUNCH_TIMEOUT_MS,
  } = ctx

  try {
    return await requestApp<T>(target, urlPath, options)
  } catch (err) {
    if (!(err instanceof AppNotRunningError)) throw err

    const consent = preapproved ? 'accepted' : await askToLaunch(server)
    if (consent === 'declined') throw new LaunchDeclinedError()
    if (consent === 'unsupported') throw err

    await launchAndWait(target, launcher, launchTimeoutMs)
    // 再試行はここ1回だけ。ここで未起動が返るなら、それは人へ報告すべき状態。
    return await requestApp<T>(target, urlPath, options)
  }
}
