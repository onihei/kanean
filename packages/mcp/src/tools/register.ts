import type { McpServer, ToolCallback } from '@modelcontextprotocol/sdk/server/mcp.js'
import type { ShapeOutput } from '@modelcontextprotocol/sdk/server/zod-compat.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { z } from 'zod'
import { callApp, type CallContext } from '../callApp.js'
import type { RequestOptions } from '../connection.js'
import { toProblem } from '../result.js'
import { TOOL_PREFIX } from '../server.js'

/**
 * ツール登録の共通部分。
 *
 * 各ツールは「本体 API を呼んで、結果を人向けに整える」だけを書けばよい状態にする。
 * 接続・未起動時の確認・エラーの翻訳はここで一手に引き受ける。
 */

/** どのツールにも共通で効く引数（対象帳簿の指定）。 */
export const bookArg = {
  bookId: z
    .string()
    .optional()
    .describe('対象帳簿の id。帳簿が1冊なら省略する。2冊以上で省略すると選択肢が返る'),
}

export interface ToolDeps {
  /** 呼び出しごとに接続文脈を作る（server 参照を含む）。 */
  context: () => CallContext
}

/** ツール本体。本体 API を呼ぶ `call` を受け取り、結果を返す。 */
export type ToolBody<A> = (
  args: A,
  call: <T>(urlPath: string, options?: RequestOptions) => Promise<T>,
) => Promise<CallToolResult>

/**
 * ツールを1本登録する。名前には接頭辞を付ける（クライアントは複数サーバを繋ぐため）。
 * 例外はすべて「次の一手つきの結果」へ翻訳し、生のスタックを人へ見せない。
 */
export function defineTool<S extends z.ZodRawShape>(
  server: McpServer,
  deps: ToolDeps,
  name: string,
  config: { title: string; description: string; inputSchema: S; readOnly?: boolean },
  body: ToolBody<ShapeOutput<S>>,
): void {
  server.registerTool(
    `${TOOL_PREFIX}${name}`,
    {
      title: config.title,
      description: config.description,
      inputSchema: config.inputSchema,
      annotations: {
        readOnlyHint: config.readOnly ?? true,
        // ローカルの自分のデータのみを扱う。外部へ送信しない。
        openWorldHint: false,
      },
    },
    // SDK のコールバック型は `Args extends ZodRawShapeCompat ? … : …` の条件型で、
    // ジェネリックな S のままでは TS が解決できず代入可能性を判定できない。
    // 引数の型付けは body 側（ShapeOutput<S>）で効いているので、境界で1回だけ均す。
    (async (args: ShapeOutput<S>) => {
      const ctx = deps.context()
      const bookId = (args as { bookId?: string }).bookId
      const call = <T>(urlPath: string, options: RequestOptions = {}) =>
        callApp<T>(ctx, urlPath, { bookId, ...options })
      try {
        return await body(args, call)
      } catch (err) {
        return toProblem(err)
      }
    }) as unknown as ToolCallback<S>,
  )
}

/** クエリ文字列を組み立てる（値が無いキーは落とす）。 */
export function query(params: Record<string, string | number | undefined | null>): string {
  const entries = Object.entries(params).filter(([, v]) => v !== undefined && v !== null && v !== '')
  if (entries.length === 0) return ''
  return `?${entries.map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`).join('&')}`
}
