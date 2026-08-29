import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer, MAX_TOOLS, TOOL_PREFIX } from '../server.js'

/**
 * 露出する動詞の範囲（mcp-server spec「露出する動詞の範囲」「書き込みの限定と承認の非委譲」）。
 *
 * 「持っていないこと」の検証が要点。承認・確定・マスタ編集がツールとして生えていないことを
 * 機械で固定しておかないと、便利さに引かれて後から足されてしまう。
 */

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

/** 本体の代わりに応答する最小のサーバを立て、そこへ繋いだ MCP クライアントを返す。 */
async function connectWithFakeApp(routes: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-tools-'))
  const socketPath = path.join(dir, 'kanean.sock')
  const seen: string[] = []
  const app = http.createServer((req, res) => {
    const urlPath = (req.url ?? '').split('?')[0]
    seen.push(`${req.method} ${req.url}`)
    const body = routes[urlPath]
    res.setHeader('content-type', 'application/json')
    if (body === undefined) {
      res.statusCode = 404
      res.end(JSON.stringify({ error: { code: 'not_found', message: `未定義: ${urlPath}` } }))
      return
    }
    res.end(JSON.stringify(body))
  })
  await new Promise<void>((resolve) => app.listen(socketPath, resolve))

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
  const server = createMcpServer({ target: { kind: 'socket', socketPath } })
  const client = new Client({ name: 'test', version: '0.0.0' })
  await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])

  cleanups.push(async () => {
    await client.close()
    await new Promise<void>((resolve) => {
      app.close(() => {
        fs.rmSync(dir, { recursive: true, force: true })
        resolve()
      })
      app.closeAllConnections?.()
    })
  })
  return { client, seen }
}

/** ツールの結果本文（JSON）を取り出す。 */
function bodyOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error('text 応答ではない')
  return JSON.parse(first.text) as Record<string, unknown>
}

const ONE_BOOK = { books: [{ id: '01J', name: 'じぶんの帳簿', createdAt: '', archivedAt: null }] }
const OPEN_YEAR = {
  fiscalYears: [{ id: 1, startDate: '2026-01-01', endDate: '2026-12-31', status: 'open' }],
}

describe('露出する動詞の範囲', () => {
  it('ツール数が上限を超えない', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    expect(tools.length).toBeGreaterThan(0)
    expect(tools.length).toBeLessThanOrEqual(MAX_TOOLS)
  })

  it('すべてのツール名が名前空間の接頭辞を持つ', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    for (const tool of tools) expect(tool.name.startsWith(TOOL_PREFIX)).toBe(true)
  })

  it('すべてのツールに説明がある', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    for (const tool of tools) expect(tool.description?.length ?? 0).toBeGreaterThan(0)
  })

  it('仕訳の確定・取消・削除を行うツールを持たない', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).join(' ')
    for (const forbidden of ['confirm', 'approve', 'unconfirm', 'delete_entry', 'update_entry']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('マスタ・期首残高・税区分を編集するツールを持たない', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).join(' ')
    for (const forbidden of ['opening_balance', 'tax_category', 'create_account', 'update_account']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('書き込みツールは連携サービスの登録・取込の進行・較正の更新・レシートの取込・申告の完了記録だけ', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    const writes = tools.filter((t) => t.annotations?.readOnlyHint === false).map((t) => t.name)
    // mcp-server spec「書き込みの限定と承認の非委譲」。ここを増やすときは spec を先に変えること。
    expect(writes.sort()).toEqual(
      [
        `${TOOL_PREFIX}register_linked_service`,
        `${TOOL_PREFIX}start_app`,
        `${TOOL_PREFIX}start_import`,
        `${TOOL_PREFIX}classify_drafts`,
        `${TOOL_PREFIX}update_site_calibration`,
        `${TOOL_PREFIX}reset_site_calibration`,
        `${TOOL_PREFIX}import_cash_receipt`,
        `${TOOL_PREFIX}record_filing`,
      ].sort(),
    )
  })

  it('カードのレシートを起票するツールが存在しない（突合は読み取りのみ）', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    const match = tools.find((t) => t.name === `${TOOL_PREFIX}match_card_receipt`)
    // カードの明細は [[acquisition]] の取込が持つ。ここで起票すると二重計上になる。
    expect(match?.annotations?.readOnlyHint).not.toBe(false)
    expect(tools.map((t) => t.name)).not.toContain(`${TOOL_PREFIX}import_card_receipt`)
  })

  it('完了記録を削除するツールを持たない（削除は UI で行う）', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).join(' ')
    expect(names).not.toContain('delete_filing')
    expect(names).not.toContain('remove_filing')
  })
})

describe('現在地', () => {
  it('帳簿・会計年度・承認待ち件数を返す', async () => {
    const { client } = await connectWithFakeApp({
      '/api/books': ONE_BOOK,
      '/api/app-mode': { mode: 'personal' },
      '/api/fiscal-years': OPEN_YEAR,
      '/api/entries': { entries: [{ id: 1, status: 'draft' }, { id: 2, status: 'draft' }] },
    })
    const body = bodyOf((await client.callTool({ name: 'kanean_get_context', arguments: {} })) as CallToolResult)

    expect(body.counts).toEqual({ pendingDrafts: 2 })
    expect(body.data).toMatchObject({ appMode: 'personal' })
    // 承認は UI に残す。ここから確定できないことを次の一手として伝える。
    expect(JSON.stringify(body.nextActions)).toContain('確定')
    expect(body.openInApp).toBe('kanean://local/#raw')
  })

  it('会計年度が無ければ空の帳票を返さず、作成へ誘導する', async () => {
    const { client } = await connectWithFakeApp({
      '/api/books': ONE_BOOK,
      '/api/app-mode': { mode: 'personal' },
      '/api/fiscal-years': { fiscalYears: [] },
    })
    const result = (await client.callTool({ name: 'kanean_get_context', arguments: {} })) as CallToolResult
    const body = bodyOf(result)

    expect(result.isError).toBe(true)
    expect(body.error).toMatchObject({ code: 'no_open_fiscal_year' })
    expect(body.openInApp).toBe('kanean://local/#settings')
  })

  it('帳簿が2冊以上あれば処理せず選択肢を返す', async () => {
    const { client } = await connectWithFakeApp({
      '/api/books': {
        books: [
          { id: '01J', name: 'じぶんの帳簿', createdAt: '', archivedAt: null },
          { id: '01K', name: '顧問先A', createdAt: '', archivedAt: null },
        ],
      },
      '/api/app-mode': { mode: 'office' },
    })
    const result = (await client.callTool({ name: 'kanean_get_context', arguments: {} })) as CallToolResult
    const body = bodyOf(result)

    expect(result.isError).toBe(true)
    expect(body.error).toMatchObject({ code: 'book_required' })
    expect(JSON.stringify(body.data)).toContain('顧問先A')
  })
})

describe('帳票', () => {
  const TRIAL = {
    report: {
      rows: [
        {
          accountId: 5,
          accountName: '売掛金',
          normalBalance: 'debit',
          balance: 120000,
          totalDebit: 200000,
          totalCredit: 80000,
        },
      ],
      totalDebit: 200000,
      totalCredit: 200000,
      balanced: true,
    },
  }

  it('試算表に承認待ちの件数を添える（集計には混ぜない）', async () => {
    const { client } = await connectWithFakeApp({
      '/api/reports/trial-balance': TRIAL,
      '/api/entries': { entries: [{ id: 1, status: 'draft' }] },
    })
    const body = bodyOf(
      (await client.callTool({ name: 'kanean_get_trial_balance', arguments: {} })) as CallToolResult,
    )
    expect(body.counts).toMatchObject({ pendingDrafts: 1 })
    expect(JSON.stringify(body.nextActions)).toContain('集計に入っていない')
  })

  it('指定日時点の科目残高を返す（例: 7月末の売掛金）', async () => {
    const { client, seen } = await connectWithFakeApp({
      '/api/reports/trial-balance': TRIAL,
      '/api/entries': { entries: [] },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_get_account_balance',
        arguments: { account: '売掛金', asOf: '2026-07-31' },
      })) as CallToolResult,
    )

    expect(body.data).toMatchObject({
      asOf: '2026-07-31',
      matches: [{ accountName: '売掛金', balance: 120000 }],
    })
    // 専用エンドポイントを足さず、試算表を期末で締めて取り出している。
    expect(seen.some((s) => s.includes('/api/reports/trial-balance?to=2026-07-31'))).toBe(true)
  })

  it('科目が見つからなければ候補を返す', async () => {
    const { client } = await connectWithFakeApp({
      '/api/reports/trial-balance': TRIAL,
      '/api/entries': { entries: [] },
    })
    const result = (await client.callTool({
      name: 'kanean_get_account_balance',
      arguments: { account: '存在しない科目' },
    })) as CallToolResult
    const body = bodyOf(result)

    expect(result.isError).toBe(true)
    expect(JSON.stringify(body.data)).toContain('売掛金')
  })

  it('元帳は科目の指定が無ければ処理せず案内する', async () => {
    const { client } = await connectWithFakeApp({})
    const result = (await client.callTool({ name: 'kanean_get_ledger', arguments: {} })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(bodyOf(result).error).toMatchObject({ code: 'account_required' })
  })
})

describe('連携サービス', () => {
  it('未対応の key なら登録せず候補を返す', async () => {
    const { client, seen } = await connectWithFakeApp({
      '/api/services/catalog': { catalog: [{ key: 'amazon', label: 'Amazon', kind: 'ec' }] },
    })
    const result = (await client.callTool({
      name: 'kanean_register_linked_service',
      arguments: { serviceKey: 'unknown_shop' },
    })) as CallToolResult

    expect(result.isError).toBe(true)
    expect(bodyOf(result).error).toMatchObject({ code: 'unknown_service_key' })
    // 登録の POST まで到達していない。
    expect(seen.some((s) => s.startsWith('POST'))).toBe(false)
  })

  it('候補にある key なら登録して結果を返す', async () => {
    const { client } = await connectWithFakeApp({
      '/api/services/catalog': { catalog: [{ key: 'rakuten', label: '楽天市場', kind: 'ec' }] },
      '/api/services': {
        service: {
          subAccountId: 3,
          serviceKey: 'rakuten',
          name: '楽天市場',
          accountRef: 'rakuten-1',
          accountName: '未払金',
          label: '楽天市場',
          kind: 'ec',
        },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_register_linked_service',
        arguments: { serviceKey: 'rakuten' },
      })) as CallToolResult,
    )

    expect(body.data).toMatchObject({ accountRef: 'rakuten-1' })
    expect(body.openInApp).toBe('kanean://local/#services')
  })
})

describe('未起動時の扱い', () => {
  it('アプリが起動していなければ、勝手に起動せず次の一手を返す', async () => {
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    const server = createMcpServer({
      target: { kind: 'socket', socketPath: '/tmp/mw-not-there.sock' },
    })
    const client = new Client({ name: 'test', version: '0.0.0' })
    await Promise.all([server.connect(serverTransport), client.connect(clientTransport)])
    cleanups.push(() => client.close())

    const result = (await client.callTool({ name: 'kanean_get_context', arguments: {} })) as CallToolResult
    const body = bodyOf(result)

    expect(result.isError).toBe(true)
    expect(body.error).toMatchObject({ code: 'app_not_running' })
    expect(JSON.stringify(body.nextActions)).toContain('確認')
    expect(JSON.stringify(body.nextActions)).toContain('kanean_start_app')
  })
})

describe('定型手順（prompts）', () => {
  it('入口として提示される', async () => {
    const { client } = await connectWithFakeApp({})
    const { prompts } = await client.listPrompts()
    expect(prompts.map((p) => p.name).sort()).toEqual(
      [
        'kanean_closing_check',
        'kanean_filing',
        'kanean_import',
        'kanean_receipts',
        'kanean_this_month',
      ].sort(),
    )
  })

  it('レシートの取込手順が receipt-inbox の規約を運ぶ', async () => {
    const { client } = await connectWithFakeApp({})
    const result = await client.getPrompt({ name: 'kanean_receipts' })
    const text = JSON.stringify(result.messages)

    // 対が揃っていない件は同期の途中なので触らない。
    expect(text).toContain('対が揃っていない件は触らない')
    // 現金は起票・カードは突合のみ（取り違えると二重計上）。
    expect(text).toContain('kanean_import_cash_receipt')
    expect(text).toContain('kanean_match_card_receipt')
    expect(text).toContain('起票してはならない')
    expect(text).toContain('二重計上')
    // 削除は登録と証憑保存の完了を確認してから。未登録は消さない。
    expect(text).toContain('中継コピーを消してよいのは、登録と証憑保存の両方が完了した件だけ')
    expect(text).toContain('画像を残す')
    // status を書き戻さないと端末が「登録済み」を出せない。
    expect(text).toContain('status を書き戻す')
    // 読み取れないものを推測で埋めない。
    expect(text).toContain('推測で埋めず')
  })

  it('手順に前提と境界が含まれる（ツール説明では伝わらない部分）', async () => {
    const { client } = await connectWithFakeApp({})
    const result = await client.getPrompt({ name: 'kanean_closing_check' })
    const text = JSON.stringify(result.messages)

    expect(text).toContain('kanean_get_context') // 最初に現在地を見る
    expect(text).toContain('推測せず') // 帳簿が複数のときの作法
    expect(text).toContain('確定・承認') // ここからは確定できないという境界
  })
})
