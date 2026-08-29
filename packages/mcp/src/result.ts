import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { AppNotRunningError, AppResponseError, AppStoppedError, describeTarget } from './connection.js'
import { AppStartTimeoutError, LaunchDeclinedError, LaunchFailedError } from './launch.js'
import { screenLink, type OpenableTab } from '@kanean/shared'

/**
 * ツールの返り値の形（mcp-server spec「次の一手の提示」）。
 *
 * ツールの説明文は「何ができるか」しか伝えない。順序・前提・禁止事項は伝わらないので、
 * **返り値に次の一手を載せる**のが最も効く。前提が足りないときは、空の結果ではなく
 * 「何が足りないか」と「選べる選択肢」を返す。
 */

/**
 * アプリの該当画面を開くリンク。
 *
 * `kanean://local/` はデスクトップ版が UI を配る出所と同じスキーム。
 * 画面は `packages/web` の `TabKey`（`nav.ts`）で指定する。
 * **リンクは画面遷移のためだけにある**。開くだけで会計データが変わる形は作らない。
 */
// 画面一覧・リンク書式は @kanean/shared（プロセス間契約・issue #167）が正。
// desktop の受理側（deepLink）と同じ定義を共有する＝提示したリンクが必ず受理される。
export type Screen = OpenableTab
export { screenLink }

export interface Payload {
  /** ツール本体の結果。 */
  data?: unknown
  /** 次にできること・すべきこと（人へ提示する導線を含む）。 */
  nextActions?: string[]
  /** アプリの該当画面へのリンク。 */
  openInApp?: Screen
  /** 黙って落とさないための件数（除外・重複・未確定など）。 */
  counts?: Record<string, number>
}

/** 正常な結果。 */
export function ok(payload: Payload): CallToolResult {
  return {
    content: [{ type: 'text', text: JSON.stringify(toBody(payload), null, 2) }],
  }
}

/** 処理できなかった結果。前提不足も含め、必ず「次の一手」を添える。 */
export function problem(
  message: string,
  payload: Payload & { code?: string } = {},
): CallToolResult {
  const { code, ...rest } = payload
  return {
    isError: true,
    content: [
      { type: 'text', text: JSON.stringify({ error: { code, message }, ...toBody(rest) }, null, 2) },
    ],
  }
}

function toBody(payload: Payload): Record<string, unknown> {
  const body: Record<string, unknown> = {}
  if (payload.data !== undefined) body.data = payload.data
  if (payload.counts) body.counts = payload.counts
  if (payload.nextActions?.length) body.nextActions = payload.nextActions
  if (payload.openInApp) body.openInApp = screenLink(payload.openInApp)
  return body
}

/**
 * 接続・起動まわりの失敗を、人が次に何をすればよいか分かる形へ翻訳する。
 * 判別できない失敗を汎用エラーとして返さない。
 */
export function toProblem(err: unknown): CallToolResult {
  if (err instanceof AppNotRunningError) {
    return problem(`Kanean が起動していません（${describeTarget(err.target)} に到達できません）。`, {
      code: 'app_not_running',
      nextActions: [
        'Kanean を起動してよいか利用者に確認する',
        '承諾を得たら kanean_start_app を呼ぶ（勝手に起動しない）',
      ],
    })
  }
  if (err instanceof LaunchDeclinedError) {
    return problem('起動が承諾されなかったため、何も実行していません。', {
      code: 'launch_declined',
      nextActions: ['利用者が Kanean を起動したら、同じ操作をやり直す'],
    })
  }
  if (err instanceof AppStartTimeoutError) {
    return problem(err.message, {
      code: 'app_start_timeout',
      nextActions: [
        'Kanean のウィンドウが開いているか利用者に確認する',
        '開いていれば同じ操作をやり直す（別の経路は試さない）',
      ],
    })
  }
  if (err instanceof LaunchFailedError) {
    return problem(err.message, {
      code: 'launch_failed',
      nextActions: ['Kanean がインストールされているか利用者に確認する'],
    })
  }
  if (err instanceof AppStoppedError) {
    return problem('処理の途中で Kanean が終了しました。結果は保証できません。', {
      code: 'app_stopped',
      nextActions: ['Kanean を起動し直してから、同じ操作をやり直す'],
    })
  }
  if (err instanceof AppResponseError) return fromAppResponse(err)

  return problem(err instanceof Error ? err.message : String(err), { code: 'unexpected' })
}

/** 本体が返したエラー応答を翻訳する。帳簿の指定要求など、選択肢は必ず人へ返す。 */
function fromAppResponse(err: AppResponseError): CallToolResult {
  // 本体のエラーは2形式ある: 業務 API の flat な `{error: "文字列"}` と、
  // 帳簿・モード・取込系の `{error: {code, message}}`。どちらの理由も落とさず人へ返す。
  const body = err.body as
    | { error?: string | { code?: string; message?: string }; books?: unknown }
    | string
    | null
  const e = typeof body === 'object' ? body?.error : undefined

  // 帳簿が2冊以上あるときは推測しない。どの帳簿に対する操作かは会計上の判断。
  if (typeof e === 'object' && e?.code === 'book_required') {
    return problem('対象の帳簿が決まりません。どの帳簿か利用者に確認してください。', {
      code: 'book_required',
      data: { books: typeof body === 'object' ? body?.books : undefined },
      nextActions: ['利用者にどの帳簿かを尋ね、その id を bookId として同じ操作をやり直す'],
    })
  }

  const message =
    (typeof e === 'string' ? e : e?.message) ?? (typeof body === 'string' ? body : null)
  const code = (typeof e === 'object' ? e?.code : undefined) ?? `http_${err.status}`
  return problem(message ?? err.message, { code })
}
