import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { resolveTarget, type Target } from './connection.js'
import { registerPrompts } from './prompts.js'
import { registerAllTools } from './tools/index.js'
import { clientVersion } from './version.js'

/**
 * Kanean の MCP サーバ本体（トランスポート非依存）。
 *
 * ここには**会計ロジックを置かない**（mcp-server spec「ローカルアプリへの MCP 接続」）。
 * ツールはローカルで動くアプリの HTTP API を呼ぶだけで、検証・期間ゲート・冪等・帳簿解決の
 * 権威は本体側に残す。同じ規則が2箇所に分かれると必ずずれるため。
 *
 * トランスポート（stdio）との接続は index.ts が行う。テストからは接続せずに構築だけできる。
 */

/** 露出するツール数の上限（目安12。filing 追加で 22 本＝上限24へ拡張）。超えるとモデルが選べなくなる。 */
export const MAX_TOOLS = 24

/** ツール名の接頭辞。クライアントは複数の MCP サーバを繋ぐので名前空間を分ける。 */
export const TOOL_PREFIX = 'kanean_'

export interface CreateOptions {
  /** 接続先。省略時は環境から解決する（既定はローカルソケットのみ）。 */
  target?: Target
}

export function createMcpServer(options: CreateOptions = {}): McpServer {
  const server = new McpServer(
    // 版はクライアントが名乗るものと同じ出所（`manifest.json`）を使う。ここに数字を直書きすると
    // 名乗りとずれ、Claude Desktop の一覧の表示と拒否の判定が食い違う。
    // 読めなければ '0.0.0'（＝名乗りも無いので、アプリからは一致しないものとして扱われる）。
    { name: 'kanean', version: clientVersion() ?? '0.0.0' },
    {
      instructions:
        'Kanean（個人事業主向けの確定申告/会計システム）のローカル連携。' +
        '会計データの問い合わせと連携サービスの登録ができる。' +
        '仕訳の確定・承認とマスタの編集は Kanean の画面で人が行うため、ここには無い。',
    },
  )

  const target = options.target ?? resolveTarget()
  registerAllTools(server, {
    // 起動確認（elicitation）にサーバ参照が要るので、呼び出しのたびに文脈を組む。
    context: () => ({ target, server: server.server }),
  })
  registerPrompts(server)

  return server
}
