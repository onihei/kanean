import { afterEach, describe, expect, it } from 'vitest'
import fs from 'node:fs'
import http from 'node:http'
import os from 'node:os'
import path from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js'
import { createMcpServer } from '../server.js'

/**
 * 申告の提出支援ツール（filing spec / mcp-server spec）。
 * 読み2本（precheck / sheet）の次の一手と、record_filing の「先にファイル検証 → 記録 → 生バイナリ添付」を固定する。
 */

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

interface Captured {
  method: string
  path: string
  contentType: string | undefined
  body: Buffer
}

/** メソッド対応・リクエスト本文キャプチャ付きの偽アプリ。routes のキーは「METHOD /path」。 */
async function connectWithFakeApp(routes: Record<string, unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-filing-'))
  const socketPath = path.join(dir, 'kanean.sock')
  const captured: Captured[] = []
  const app = http.createServer((req, res) => {
    const urlPath = (req.url ?? '').split('?')[0]
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      captured.push({
        method: req.method ?? '',
        path: urlPath,
        contentType: req.headers['content-type'],
        body: Buffer.concat(chunks),
      })
      const body = routes[`${req.method} ${urlPath}`]
      res.setHeader('content-type', 'application/json')
      if (body === undefined) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: { code: 'not_found', message: `未定義: ${urlPath}` } }))
        return
      }
      res.end(JSON.stringify(body))
    })
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
  return { client, captured, dir }
}

function bodyOf(result: unknown): Record<string, unknown> {
  const first = (result as CallToolResult).content[0]
  if (first?.type !== 'text') throw new Error('text 応答ではない')
  return JSON.parse(first.text) as Record<string, unknown>
}

const PRECHECK_OK = {
  precheck: {
    fiscalYearId: 1,
    year: 2026,
    issues: [{ level: 'warning', code: 'deduction_inputs_missing', message: '所得控除が未入力', screen: 'incometax' }],
    draftCount: 0,
    disclaimer: '「提出可能」を意味しません',
  },
}

const SHEET_OK = {
  sheet: {
    fiscalYearId: 1,
    year: 2026,
    groups: [{ id: 'A1', screen: '種類選択', items: [] }],
    checksum: { incomeTaxPayable: 822000, incomeTaxRefund: 0, consumptionNational: 390000, consumptionLocal: 110000, consumptionTotal: 500000 },
    consumptionApplicable: true,
    disclaimer: 'x',
  },
}

describe('kanean_get_filing_precheck', () => {
  it('不備が無ければ入力指示書へ誘導する', async () => {
    const { client } = await connectWithFakeApp({ 'GET /api/filing/precheck': PRECHECK_OK })
    const body = bodyOf(await client.callTool({ name: 'kanean_get_filing_precheck', arguments: {} }))
    expect(body.counts).toMatchObject({ blocking: 0, warning: 1 })
    expect(JSON.stringify(body.nextActions)).toContain('kanean_get_filing_sheet')
    expect(String(body.openInApp)).toContain('#filing')
  })

  it('不備（blocking）があれば転記へ進めず解消を促す', async () => {
    const withBlocking = {
      precheck: {
        ...PRECHECK_OK.precheck,
        issues: [{ level: 'blocking', code: 'trial_unbalanced', message: '貸借不一致', screen: 'trial' }],
      },
    }
    const { client } = await connectWithFakeApp({ 'GET /api/filing/precheck': withBlocking })
    const body = bodyOf(await client.callTool({ name: 'kanean_get_filing_precheck', arguments: {} }))
    expect(body.counts).toMatchObject({ blocking: 1 })
    expect(JSON.stringify(body.nextActions)).toContain('解消')
  })

  it('会計年度が無ければ空の結果ではなく前提不足を返す', async () => {
    const { client } = await connectWithFakeApp({ 'GET /api/filing/precheck': { precheck: null } })
    const body = bodyOf(await client.callTool({ name: 'kanean_get_filing_precheck', arguments: {} }))
    expect((body.error as { code: string }).code).toBe('no_open_year')
  })
})

describe('kanean_get_filing_sheet', () => {
  it('指示書と転記の規約（指示書のみ・認証と送信は利用者・検算）を返す', async () => {
    const { client } = await connectWithFakeApp({ 'GET /api/filing/instruction-sheet': SHEET_OK })
    const body = bodyOf(await client.callTool({ name: 'kanean_get_filing_sheet', arguments: {} }))
    expect((body.data as { checksum: { consumptionTotal: number } }).checksum.consumptionTotal).toBe(500000)
    const actions = JSON.stringify(body.nextActions)
    expect(actions).toContain('指示書のみを源とする')
    expect(actions).toContain('利用者が行う')
    expect(actions).toContain('checksum')
  })
})

describe('kanean_record_filing', () => {
  it('記録を作成し、控えを生バイナリで添付する', async () => {
    const { client, captured, dir } = await connectWithFakeApp({
      'POST /api/filing/records': { record: { id: 7, attachments: [] } },
      'POST /api/filing/records/7/attachments': { attachment: { id: 1 } },
    })
    const pdf = path.join(dir, '控え.pdf')
    fs.writeFileSync(pdf, '%PDF-1.4 receipt')
    const body = bodyOf(
      await client.callTool({
        name: 'kanean_record_filing',
        arguments: {
          taxKind: 'income_tax',
          method: 'corner_etax',
          submittedOn: '2027-03-10',
          receiptNumber: 'R123',
          attachmentPaths: [pdf],
        },
      }),
    )
    expect(body.counts).toMatchObject({ attached: 1 })
    // 65万控除の設定確認への導線（corner_etax × income_tax のとき）
    expect(JSON.stringify(body.nextActions)).toContain('65万円')

    const post = captured.find((r) => r.method === 'POST' && r.path === '/api/filing/records')
    expect(JSON.parse(post!.body.toString())).toMatchObject({ taxKind: 'income_tax', receiptNumber: 'R123' })
    const attach = captured.find((r) => r.path === '/api/filing/records/7/attachments')
    expect(attach?.contentType).toBe('application/pdf')
    expect(attach?.body.toString()).toBe('%PDF-1.4 receipt')
  })

  it('読めない控えパスは記録を作る前に失敗する', async () => {
    const { client, captured } = await connectWithFakeApp({
      'POST /api/filing/records': { record: { id: 7, attachments: [] } },
    })
    const body = bodyOf(
      await client.callTool({
        name: 'kanean_record_filing',
        arguments: { taxKind: 'income_tax', method: 'paper', submittedOn: '2027-03-10', attachmentPaths: ['/no/such/控え.pdf'] },
      }),
    )
    expect((body.error as { code: string }).code).toBe('attachment_unreadable')
    expect(captured.some((r) => r.method === 'POST')).toBe(false)
  })

  it('対応しない形式の控えを拒否する', async () => {
    const { client } = await connectWithFakeApp({})
    const body = bodyOf(
      await client.callTool({
        name: 'kanean_record_filing',
        arguments: { taxKind: 'consumption', method: 'other', submittedOn: '2027-03-10', attachmentPaths: ['/tmp/a.txt'] },
      }),
    )
    expect((body.error as { code: string }).code).toBe('unsupported_attachment')
  })
})

describe('定型手順「確定申告の転記」', () => {
  it('転記手順の規約（指示書のみ・認証と送信は利用者・検算一致・提出可能の非宣言）を含む', async () => {
    const { client } = await connectWithFakeApp({})
    const result = await client.getPrompt({ name: 'kanean_filing' })
    const text = JSON.stringify(result.messages)
    expect(text).toContain('指示書のみを源とする')
    expect(text).toContain('認証（QR コードのスマホ読み取り）は利用者が行う')
    expect(text).toContain('checksum')
    expect(text).toContain('一致した場合のみ')
    expect(text).toContain('「提出可能」を宣言しない')
    expect(text).toContain('途中保存')
  })
})
