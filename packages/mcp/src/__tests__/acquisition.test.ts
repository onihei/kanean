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
 * 取込ツール（[[acquisition]]）。
 *
 * 要点は「何を返さないか」。分類のために外へ出るのは品名・摘要と識別子だけで、
 * 金額・取引識別子・残高は出ない。確定するツールも無い。
 */

interface Route {
  status?: number
  body: unknown
}

const cleanups: Array<() => void | Promise<void>> = []
afterEach(async () => {
  for (const fn of cleanups.splice(0)) await fn()
})

async function connectWithFakeApp(routes: Record<string, Route | unknown>) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mw-acq-'))
  const socketPath = path.join(dir, 'kanean.sock')
  const seen: { method: string; url: string; body: string }[] = []
  const app = http.createServer((req, res) => {
    const chunks: Buffer[] = []
    req.on('data', (c: Buffer) => chunks.push(c))
    req.on('end', () => {
      const urlPath = (req.url ?? '').split('?')[0]
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        body: Buffer.concat(chunks).toString('utf8'),
      })
      const key = `${req.method} ${urlPath}`
      const route = (routes[key] ?? routes[urlPath]) as Route | undefined
      res.setHeader('content-type', 'application/json')
      if (route === undefined) {
        res.statusCode = 404
        res.end(JSON.stringify({ error: { code: 'not_found', message: `未定義: ${key}` } }))
        return
      }
      const isWrapped = typeof route === 'object' && route !== null && 'body' in route
      res.statusCode = isWrapped ? (route.status ?? 200) : 200
      res.end(JSON.stringify(isWrapped ? route.body : route))
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
  return { client, seen }
}

function bodyOf(result: CallToolResult): Record<string, unknown> {
  const first = result.content[0]
  if (first?.type !== 'text') throw new Error('text 応答ではない')
  return JSON.parse(first.text) as Record<string, unknown>
}

const JOB = {
  jobId: 'job-1',
  source: 'bank_ufj',
  kind: 'bank',
  state: 'awaiting_login',
  waitingFor: '三菱UFJダイレクトにログインしてください',
  message: null,
  range: { since: '2026-01-01', until: '2026-06-30' },
  rangeLimited: false,
  pendingItems: 0,
  failedStep: null,
  counts: null,
}

describe('取込の開始', () => {
  it('巡回の完了を待たずに識別子と状態を返し、次の一手を添える', async () => {
    const { client, seen } = await connectWithFakeApp({ 'POST /api/acquisition/jobs': { body: JOB } })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_start_import',
        arguments: { source: 'bank_ufj' },
      })) as CallToolResult,
    )
    expect(body.data).toMatchObject({ jobId: 'job-1', state: 'awaiting_login' })
    expect(JSON.stringify(body.nextActions)).toContain('ログイン')
    // 認証情報を代わりに入れないことを次の一手として伝える
    expect(JSON.stringify(body.nextActions)).toContain('認証情報は代わりに入力しない')
    expect(seen[0].method).toBe('POST')
  })

  it('範囲を限ったときは差分の起点が前進しないことを伝える', async () => {
    const { client } = await connectWithFakeApp({
      'POST /api/acquisition/jobs': { body: { ...JOB, rangeLimited: true } },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_start_import',
        arguments: { source: 'bank_ufj', since: '2026-06-01' },
      })) as CallToolResult,
    )
    expect(JSON.stringify(body.nextActions)).toContain('前進しない')
  })

  it('デスクトップ以外では、その旨が返る', async () => {
    const { client } = await connectWithFakeApp({
      'POST /api/acquisition/jobs': {
        status: 503,
        body: { error: { code: 'crawler_unavailable', message: '取込の巡回はデスクトップアプリからのみ実行できます' } },
      },
    })
    const result = (await client.callTool({
      name: 'kanean_start_import',
      arguments: { source: 'bank_ufj' },
    })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(JSON.stringify(bodyOf(result))).toContain('デスクトップアプリ')
  })
})

describe('未確定の分類', () => {
  const UNCLASSIFIED = {
    'GET /api/acquisition/unclassified': {
      body: {
        items: [
          { id: 'a1b2c3d4e5f6', text: 'デンキダイ', count: 2, sources: ['bank_ufj'] },
          { id: '0f1e2d3c4b5a', text: 'ヤマダデンキ', count: 1, sources: ['bank_ufj'] },
        ],
        hints: [
          {
            pattern: 'デンキダイ',
            proposedAccount: '水道光熱費',
            treatment: 'expense',
            hitCount: 4,
            lastUsedAt: '2026-04-01T00:00:00Z',
          },
        ],
        policy: '# 分類方針\n\n- 推測で科目を作らない。',
        total: 2,
      },
    },
  }

  it('品名・摘要・分類方針・確定履歴を返す（金額は返らない）', async () => {
    const { client } = await connectWithFakeApp(UNCLASSIFIED)
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_list_unclassified',
        arguments: {},
      })) as CallToolResult,
    )
    const data = body.data as Record<string, unknown>
    expect(data.items).toHaveLength(2)
    // 方針はアプリが渡す（Claude Desktop はファイルを読めない）
    expect(String(data.policy)).toContain('分類方針')
    // 確定履歴はアプリ側が引いて添える（外部クライアントに取りに行かせない）
    expect(data.history).toHaveLength(1)
    expect(JSON.stringify(body.nextActions)).toContain('推測で科目を作らない')
  })

  it('根拠（理由・確信度）を必ず添えるよう促す', async () => {
    const { client } = await connectWithFakeApp(UNCLASSIFIED)
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_list_unclassified',
        arguments: {},
      })) as CallToolResult,
    )
    expect(JSON.stringify(body.nextActions)).toContain('reason')
    expect(JSON.stringify(body.nextActions)).toContain('一括確定')
  })

  it('未確定が無くても方針は返す', async () => {
    const { client } = await connectWithFakeApp({
      'GET /api/acquisition/unclassified': {
        body: { items: [], hints: [], policy: '# 方針', total: 0 },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_list_unclassified',
        arguments: {},
      })) as CallToolResult,
    )
    expect((body.data as Record<string, unknown>).policy).toBe('# 方針')
  })

  it('未確定が無ければ、無いと言う', async () => {
    const { client } = await connectWithFakeApp({
      'GET /api/acquisition/unclassified': { body: { items: [], hints: [], policy: '# 方針', total: 0 } },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_list_unclassified',
        arguments: {},
      })) as CallToolResult,
    )
    expect(JSON.stringify(body.nextActions)).toContain('科目が決まっていない仕訳はない')
  })

  it('連携サービスで絞れる', async () => {
    const { client, seen } = await connectWithFakeApp(UNCLASSIFIED)
    await client.callTool({ name: 'kanean_list_unclassified', arguments: { source: 'bank_ufj' } })
    expect(seen[0].url).toContain('source=bank_ufj')
  })

  it('科目を当てると適用件数が返り、確定はされない', async () => {
    const { client, seen } = await connectWithFakeApp({
      'POST /api/acquisition/unclassified': {
        body: { applied: 2, unmatched: 0, unknownAccounts: [], remaining: 1 },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_classify_drafts',
        arguments: {
          answers: [
            {
              id: 'a1b2c3d4e5f6',
              proposedAccount: '水道光熱費',
              reason: '電気代の口座振替',
              confidence: 'high',
            },
          ],
        },
      })) as CallToolResult,
    )
    expect(body.counts).toMatchObject({ 適用: 2, 残りの未確定: 1 })
    expect(JSON.stringify(body.nextActions)).toContain('確定は利用者が Kanean の画面で行う')
    expect(JSON.parse(seen[0].body)).toEqual({
      answers: [
        {
          id: 'a1b2c3d4e5f6',
          proposedAccount: '水道光熱費',
          reason: '電気代の口座振替',
          confidence: 'high',
        },
      ],
    })
  })

  it('人が先に片付けていた分は「対応なし」として返る（失敗にしない）', async () => {
    const { client } = await connectWithFakeApp({
      'POST /api/acquisition/unclassified': {
        body: { applied: 0, unmatched: 1, unknownAccounts: [], remaining: 0 },
      },
    })
    const result = (await client.callTool({
      name: 'kanean_classify_drafts',
      arguments: {
        answers: [
          { id: 'deadbeef', proposedAccount: '水道光熱費', reason: 'x', confidence: 'low' },
        ],
      },
    })) as CallToolResult
    expect(result.isError).toBeFalsy()
    expect(JSON.stringify(bodyOf(result).nextActions)).toContain('先に片付けた')
  })

  it('存在しない勘定科目を指したら、新設できないと伝える', async () => {
    const { client } = await connectWithFakeApp({
      'POST /api/acquisition/unclassified': {
        body: { applied: 0, unmatched: 0, unknownAccounts: ['架空の科目'], remaining: 1 },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_classify_drafts',
        arguments: {
          answers: [
            { id: 'a1b2c3d4e5f6', proposedAccount: '架空の科目', reason: 'x', confidence: 'low' },
          ],
        },
      })) as CallToolResult,
    )
    expect(JSON.stringify(body.nextActions)).toContain('新設できない')
  })
})

describe('取込の完了', () => {
  it('分類を待たずに完了し、未確定があれば分類へ誘導する', async () => {
    const { client } = await connectWithFakeApp({
      'GET /api/acquisition/jobs/job-1': {
        body: {
          ...JOB,
          state: 'done',
          waitingFor: null,
          counts: { accepted: 12, duplicated: 3, outOfPeriod: 1, unresolved: 5, failed: 0, warnings: [] },
        },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_get_import_status',
        arguments: { jobId: 'job-1' },
      })) as CallToolResult,
    )
    expect(body.counts).toMatchObject({ 受理: 12, 重複: 3, 期間外: 1, 未確定: 5, 取得できず: 0 })
    expect(JSON.stringify(body.nextActions)).toContain('kanean_list_unclassified')
    expect(JSON.stringify(body.nextActions)).toContain('確定は利用者が Kanean の画面で行う')
  })

  it('部分成功（取得できず）を黙って完了扱いにしない', async () => {
    // acquisition spec「部分成功の可視化」。counts.failed（PR#111 で追加）が MCP 経路でも
    // 件数と次の一手の両方に出ることを固定する（手書き型コピーのドリフトで欠落していた: issue #162）。
    const { client } = await connectWithFakeApp({
      'GET /api/acquisition/jobs/job-1': {
        body: {
          ...JOB,
          state: 'done',
          waitingFor: null,
          counts: {
            accepted: 20,
            duplicated: 0,
            outOfPeriod: 0,
            unresolved: 0,
            failed: 2,
            warnings: ['注文 249-xxx: 明細ページを開けなかった', '注文 249-yyy: 突合NG'],
          },
        },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_get_import_status',
        arguments: { jobId: 'job-1' },
      })) as CallToolResult,
    )
    expect(body.counts).toMatchObject({ 取得できず: 2 })
    expect(JSON.stringify(body.nextActions)).toContain('2 件は取得できなかった')
  })
})

describe('失敗の診断と較正', () => {
  it('較正で直る見込みがあれば、直すキーを示す', async () => {
    const { client } = await connectWithFakeApp({
      'GET /api/acquisition/bank_ufj/diagnostic': {
        body: {
          source: 'bank_ufj',
          step: 'extract-table',
          steps: ['open-login', 'extract-table'],
          message: '明細テーブルが見つからない',
          hint: 'SEL.tableHeaders を較正する',
          url: 'https://bank.example/',
          time: '2026-08-12T00:00:00Z',
          artifactsDir: '/data/acquisition/diagnostics/bank_ufj/latest',
          htmlExcerpt: '<table>…</table>',
          calibratable: true,
          verdict: '画面上の要素を指し損ねている',
          suggestedKeys: ['tableHeaders'],
        },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_get_import_diagnostic',
        arguments: { source: 'bank_ufj' },
      })) as CallToolResult,
    )
    expect(JSON.stringify(body.nextActions)).toContain('tableHeaders')
    expect(JSON.stringify(body.nextActions)).toContain('kanean_update_site_calibration')
  })

  it('較正では直らない失敗では、更新を繰り返させない', async () => {
    const { client } = await connectWithFakeApp({
      'GET /api/acquisition/bank_ufj/diagnostic': {
        body: {
          source: 'bank_ufj',
          step: 'normalize-verify',
          steps: [],
          message: '残高チェーン不連続',
          hint: null,
          url: null,
          time: '2026-08-12T00:00:00Z',
          artifactsDir: '/d',
          htmlExcerpt: null,
          calibratable: false,
          verdict: '取得はできているが検算が合わない',
          suggestedKeys: [],
        },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_get_import_diagnostic',
        arguments: { source: 'bank_ufj' },
      })) as CallToolResult,
    )
    expect(JSON.stringify(body.nextActions)).toContain('較正の更新は繰り返さない')
  })

  it('較正の更新はデータだけを送る', async () => {
    const { client, seen } = await connectWithFakeApp({
      'PUT /api/acquisition/bank_ufj/calibration': {
        body: {
          source: 'bank_ufj',
          origin: 'override',
          version: 'override:v1',
          overridden: ['tableHeaders'],
          bundled: {},
          effective: {},
          navigableKeys: ['loginUrl'],
        },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_update_site_calibration',
        arguments: {
          source: 'bank_ufj',
          calibration: { tableHeaders: ['取引日', '残高'] },
          version: 'v1',
        },
      })) as CallToolResult,
    )
    expect(JSON.parse(seen[0].body)).toEqual({ tableHeaders: ['取引日', '残高'], version: 'v1' })
    expect(JSON.stringify(body.nextActions)).toContain('取り直して')
  })

  it('プログラムを渡すと本体が拒否し、その理由が返る', async () => {
    const { client } = await connectWithFakeApp({
      'PUT /api/acquisition/bank_ufj/calibration': {
        status: 400,
        body: {
          error: {
            code: 'calibration_rejected',
            message: '較正データを受け付けません: loginUrl: http/https 以外の URL は受け付けません',
          },
        },
      },
    })
    const result = (await client.callTool({
      name: 'kanean_update_site_calibration',
      arguments: { source: 'bank_ufj', calibration: { loginUrl: 'javascript:alert(1)' } },
    })) as CallToolResult
    expect(result.isError).toBe(true)
    expect(JSON.stringify(bodyOf(result))).toContain('受け付けません')
  })

  it('同梱較正へ戻せる', async () => {
    const { client, seen } = await connectWithFakeApp({
      'DELETE /api/acquisition/bank_ufj/calibration': {
        body: {
          source: 'bank_ufj',
          origin: 'bundled',
          version: 'bundled:abc',
          overridden: [],
          bundled: {},
          effective: {},
          navigableKeys: [],
          hadOverride: true,
        },
      },
    })
    const body = bodyOf(
      (await client.callTool({
        name: 'kanean_reset_site_calibration',
        arguments: { source: 'bank_ufj' },
      })) as CallToolResult,
    )
    expect(seen[0].method).toBe('DELETE')
    expect(JSON.stringify(body.nextActions)).toContain('同梱の較正へ戻した')
  })
})

describe('露出しないもの', () => {
  it('取込まわりにも確定・承認のツールは無い', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    const names = tools.map((t) => t.name).join(' ')
    for (const forbidden of ['confirm', 'approve', 'commit_draft', 'finalize']) {
      expect(names).not.toContain(forbidden)
    }
  })

  it('取込を中断するツールは持たない（中断は画面から行う）', async () => {
    const { client } = await connectWithFakeApp({})
    const { tools } = await client.listTools()
    expect(tools.map((t) => t.name).join(' ')).not.toContain('abort')
  })
})
