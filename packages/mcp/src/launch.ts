import { spawn } from 'node:child_process'
import { isReachable, type Target } from './connection.js'

/**
 * アプリの起動（mcp-server spec「アプリ未起動の検知と確認付き起動」）。
 *
 * **確認なしに起動しない。** 会話の副作用で GUI が勝手に立ち上がるのは驚きになる。
 * 待ちは有限で打ち切り、別経路を探して代替はしない。
 */

/** 起動を試みたが所定時間内に到達可能にならなかった。 */
export class AppStartTimeoutError extends Error {
  constructor(readonly waitedMs: number) {
    super(`Kanean を起動しましたが ${Math.round(waitedMs / 1000)} 秒以内に応答しませんでした`)
    this.name = 'AppStartTimeoutError'
  }
}

/** 利用者が起動を承諾しなかった。アプリを起動せず、処理も行わない。 */
export class LaunchDeclinedError extends Error {
  constructor() {
    super('利用者が Kanean の起動を承諾しませんでした')
    this.name = 'LaunchDeclinedError'
  }
}

/** 起動を試みたが、そもそも起動する手段がなかった（アプリ未インストール等）。 */
export class LaunchFailedError extends Error {
  constructor(readonly reason: string) {
    super(`Kanean を起動できませんでした: ${reason}`)
    this.name = 'LaunchFailedError'
  }
}

/** 起動後に待つ上限。ここを過ぎたら打ち切って人へ報告する（黙って待ち続けない）。 */
export const LAUNCH_TIMEOUT_MS = 60_000

/** 到達確認の間隔。 */
const POLL_INTERVAL_MS = 500

export interface Launcher {
  /** アプリの起動を要求する。戻り値は「起動要求を出せたか」であって到達可否ではない。 */
  launch: () => Promise<void>
  /** この環境で起動要求を出せるか。 */
  available: () => boolean
}

/** macOS の `open -a` でアプリを起動する既定の実装。 */
export const macLauncher: Launcher = {
  available: () => process.platform === 'darwin',
  launch: () =>
    new Promise<void>((resolve, reject) => {
      // アプリ本体はこのプロセスから切り離す。MCP サーバが終了してもアプリは生き続け、
      // 逆にアプリを閉じたらアプリだけが終わる（[[desktop-app]]「アプリ寿命に閉じたプロセス」）。
      const child = spawn('open', ['-a', 'Kanean'], { detached: true, stdio: 'ignore' })
      child.once('error', (err) => reject(new LaunchFailedError(err.message)))
      child.once('exit', (code) => {
        if (code === 0) resolve()
        else reject(new LaunchFailedError(`open -a Kanean が終了コード ${code} で終了しました`))
      })
      child.unref()
    }),
}

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms))

/**
 * 到達可能になるまで待つ。有限で打ち切り、待ちきれなければ `false` を返す。
 */
export async function waitUntilReachable(
  target: Target,
  timeoutMs = LAUNCH_TIMEOUT_MS,
  now: () => number = Date.now,
): Promise<boolean> {
  const deadline = now() + timeoutMs
  for (;;) {
    if (await isReachable(target)) return true
    if (now() >= deadline) return false
    await sleep(POLL_INTERVAL_MS)
  }
}

/**
 * 起動して到達可能になるまで待つ。承諾済みであることは呼び出し側の責任。
 *
 * @throws {LaunchFailedError} 起動要求そのものが出せなかった
 * @throws {AppStartTimeoutError} 起動はしたが時間内に応答しなかった
 */
export async function launchAndWait(
  target: Target,
  launcher: Launcher = macLauncher,
  timeoutMs = LAUNCH_TIMEOUT_MS,
): Promise<void> {
  if (!launcher.available()) {
    throw new LaunchFailedError('この環境からアプリを起動する手段がありません')
  }
  await launcher.launch()
  if (!(await waitUntilReachable(target, timeoutMs))) throw new AppStartTimeoutError(timeoutMs)
}
