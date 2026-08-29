import { describe, expect, it } from 'vitest'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { createMcpServer } from '../server.js'

/** サーバを起動し、繋いだクライアントを返す（トランスポートは in-memory）。 */
async function connect() {
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer()
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
  return { client, close: () => client.close() }
}

describe('MCP サーバ', () => {
  it('クライアントが接続してサーバ情報を取得できる', async () => {
    const { client, close } = await connect()
    expect(client.getServerVersion()?.name).toBe('kanean')
    await close()
  })

  it('何をするサーバかを instructions で伝える', async () => {
    const { client, close } = await connect()
    // 承認とマスタ編集は UI に残す方針（mcp-server spec「書き込みの限定と承認の非委譲」）を
    // 接続時点で伝える。ツール一覧だけでは「何をすべきでないか」が伝わらないため。
    expect(client.getInstructions()).toContain('Kanean')
    await close()
  })

  it('ツールを提供することを capability として宣言する', async () => {
    // 露出範囲そのものの検証（上限・接頭辞・持ってはいけない動詞）は tools.test.ts。
    const { client, close } = await connect()
    expect(client.getServerCapabilities()?.tools).toBeDefined()
    await close()
  })
})
