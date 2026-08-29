#!/usr/bin/env node
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js'
import { createMcpServer } from './server.js'

/**
 * Kanean MCP サーバのエントリ（stdio）。
 *
 * MCP クライアント（Claude Desktop 等）がこのプロセスを起動し、stdio でツールを呼ぶ。
 *
 * **stdout は MCP のプロトコル用に予約されている**（JSON-RPC が流れる）。
 * ログは必ず stderr へ出すこと。stdout に1行でも混ざるとクライアントとの通信が壊れる。
 */

async function main(): Promise<void> {
  const server = createMcpServer()
  await server.connect(new StdioServerTransport())
}

main().catch((err: unknown) => {
  console.error('[kanean-mcp] 起動に失敗しました:', err)
  process.exit(1)
})
