import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { registerAcquisitionTools } from './acquisition.js'
import { registerContextTools } from './context.js'
import { registerEntryTools } from './entries.js'
import { registerFilingTools } from './filing.js'
import { registerReceiptTools } from './receipts.js'
import { registerReportTools } from './reports.js'
import { registerServiceTools } from './services.js'
import type { ToolDeps } from './register.js'

/**
 * 露出する動詞の一覧（mcp-server spec「露出する動詞の範囲」）。
 *
 * **本体の HTTP ルートを機械的に写像しない。** ルートは 143 本あり、そのまま出すと
 * ツール定義がコンテキストを圧迫してモデルが選べなくなる。ここは意味のある動詞に集約し、
 * 上限（MAX_TOOLS＝24・目安12）を守る。
 */
export function registerAllTools(server: McpServer, deps: ToolDeps): void {
  registerContextTools(server, deps) // 現在地・起動
  registerReportTools(server, deps) // 試算表・PL・BS・元帳・科目残高
  registerEntryTools(server, deps) // 仕訳検索・納税予測
  registerServiceTools(server, deps) // 連携サービスの一覧・登録
  registerAcquisitionTools(server, deps) // 取込の開始・進行・分類の投入・診断・較正
  registerReceiptTools(server, deps) // レシートの取込（現金=起票 / カード=突合のみ）
  registerFilingTools(server, deps) // 申告前チェック・入力指示書・完了記録
}

export type { ToolDeps }
