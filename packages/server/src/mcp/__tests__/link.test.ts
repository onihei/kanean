import { describe, it, expect, beforeAll, beforeEach, afterAll } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { inArray } from 'drizzle-orm'
import type { DbRouter } from '../../db/router.js'
import { appSettings } from '../../db/control/schema.js'
import { createBook } from '../../books/resolve.js'
import { createApp } from '../../app.js'
import {
  CLIENT_HEADER,
  ENTRY_HEADER,
  SOCKET_ENTRY,
  UNKNOWN_VERSION,
  linkStatus,
  parseClientVersion,
  recordSeen,
  tagSocketEntry,
} from '../link.js'

/**
 * MCP クライアントの版の検査と到達の記録
 * （mcp-server spec「クライアントの版の表明と一致の要求」「連携の到達の記録」）。
 *
 * 守りたい線は2つ。**一致しなければ通さない**ことと、**到達確認は塞がない**こと。
 * 後者を破ると、古いバンドルが「アプリが起動していません」と誤って案内する。
 */

const BUNDLED = '0.2.0'

let tmp: string
let router: DbRouter

/**
 * `getRouter()` はモジュール単位のシングルトンなので、DATA_DIR をテストごとに差し替えても
 * アプリは最初の control.sqlite を掴み続ける。データ置き場はファイルで1つに固定し、
 * **検査対象の記録だけ**をテストごとに消す。
 */
beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-mcplink-'))
  process.env.DATA_DIR = tmp
  router = createApp().router
})

afterAll(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

beforeEach(() => {
  router
    .controlDb()
    .delete(appSettings)
    .where(inArray(appSettings.key, ['mcp.last_seen_version', 'mcp.last_seen_at']))
    .run()
})

/** 同梱版が判明しているアプリ（＝検査が働く状態）。 */
const appWithBundle = (version: string | null = BUNDLED) =>
  createApp({ mcpBundleVersion: () => version }).app

/** ローカル連携の入口から来た要求として投げる。 */
const fromSocket = (app: ReturnType<typeof appWithBundle>, url: string, client?: string) =>
  app.fetch(
    tagSocketEntry(
      new Request(`http://local${url}`, { headers: client ? { [CLIENT_HEADER]: client } : {} }),
    ),
  )

describe('名乗りの解釈', () => {
  it('`<name>/<version>` から版を取る', () => {
    expect(parseClientVersion('kanean-mcp/0.2.0')).toBe('0.2.0')
  })

  it('名乗りが無ければ null', () => {
    expect(parseClientVersion(undefined)).toBeNull()
    expect(parseClientVersion('')).toBeNull()
  })

  it('版の無い名乗りは名乗っていないものとして扱う', () => {
    expect(parseClientVersion('kanean-mcp')).toBeNull()
    expect(parseClientVersion('kanean-mcp/')).toBeNull()
  })
})

describe('一致しないクライアントの拒否', () => {
  it('一致する版は通常どおり扱う', async () => {
    const res = await fromSocket(appWithBundle(), '/api/app-mode', `kanean-mcp/${BUNDLED}`)
    expect(res.status).toBe(200)
  })

  it('一致しない版を 426 で拒否し、入れ直しの手順を伴う', async () => {
    const res = await fromSocket(appWithBundle(), '/api/app-mode', 'kanean-mcp/0.1.0')
    expect(res.status).toBe(426)
    const body = (await res.json()) as { error: { code: string; message: string } }
    expect(body.error.code).toBe('client_version_mismatch')
    // 使用中の版と同梱の版の両方を示す（どちらが古いかを人が判断できるように）。
    expect(body.error.message).toContain('0.1.0')
    expect(body.error.message).toContain(BUNDLED)
    expect(body.error.message).toContain('書き出し')
  })

  it('同梱版より新しい版も拒否する（アプリの方が古い場合も捕まえる）', async () => {
    const res = await fromSocket(appWithBundle(), '/api/app-mode', 'kanean-mcp/0.3.0')
    expect(res.status).toBe(426)
  })

  it('版を名乗らない要求も同じ拒否になる（名乗る前の版のバンドル）', async () => {
    const res = await fromSocket(appWithBundle(), '/api/app-mode')
    expect(res.status).toBe(426)
    const body = (await res.json()) as { error: { code: string } }
    expect(body.error.code).toBe('client_version_mismatch')
  })

  it('拒否された書き込みは帳簿を変えない', async () => {
    const before = await appWithBundle().fetch(new Request('http://local/api/app-mode'))
    const beforeBody = await before.json()

    const res = await appWithBundle().fetch(
      tagSocketEntry(
        new Request('http://local/api/app-mode', {
          method: 'PUT',
          headers: { [CLIENT_HEADER]: 'kanean-mcp/0.1.0', 'content-type': 'application/json' },
          body: JSON.stringify({ mode: 'office' }),
        }),
      ),
    )
    expect(res.status).toBe(426)

    const after = await appWithBundle().fetch(new Request('http://local/api/app-mode'))
    expect(await after.json()).toEqual(beforeBody)
  })

  it('UI からの呼び出し（入口の印も名乗りも無い）は素通しする', async () => {
    const res = await appWithBundle().fetch(new Request('http://local/api/app-mode'))
    expect(res.status).toBe(200)
  })

  it('同梱版が分からなければ検査しない（開発時。design D7）', async () => {
    const res = await fromSocket(appWithBundle(null), '/api/app-mode', 'kanean-mcp/0.1.0')
    expect(res.status).toBe(200)
  })

  it('入口の印は詐称できない（送られてきた値を上書きする）', () => {
    const tagged = tagSocketEntry(
      new Request('http://local/api/app-mode', { headers: { [ENTRY_HEADER]: 'spoofed' } }),
    )
    expect(tagged.headers.get(ENTRY_HEADER)).toBe(SOCKET_ENTRY)
  })
})

/**
 * **到達確認は拒否しない**（design D2）。
 *
 * ここを塞ぐとクライアントの到達確認が偽になり、未起動と区別できなくなる。その結果
 * 古いバンドルは「Kanean が起動していません」と案内し、利用者はアプリを起動し直しても
 * 何も直らない。この回帰を止めるためのテスト。
 */
describe('到達確認は検査の対象外', () => {
  it('一致しない版でも /health は通る', async () => {
    const res = await fromSocket(appWithBundle(), '/health', 'kanean-mcp/0.1.0')
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({ ok: true })
  })

  it('版を名乗らなくても /health は通る', async () => {
    const res = await fromSocket(appWithBundle(), '/health')
    expect(res.status).toBe(200)
  })
})

describe('到達の記録', () => {
  it('未到達は「観測していない」として返す（未導入とは言わない）', () => {
    const status = linkStatus(router, BUNDLED)
    expect(status.seen).toBe(false)
    expect(status.lastVersion).toBeNull()
    expect(status.lastSeenAt).toBeNull()
    // 判断材料が無いので一致/不一致を名乗らない。
    expect(status.matches).toBeNull()
  })

  it('到達した版と時刻を記録する', async () => {
    await fromSocket(appWithBundle(), '/api/app-mode', `kanean-mcp/${BUNDLED}`)

    const status = linkStatus(router, BUNDLED)
    expect(status.seen).toBe(true)
    expect(status.lastVersion).toBe(BUNDLED)
    expect(status.matches).toBe(true)
    expect(status.lastSeenAt).not.toBeNull()
  })

  it('拒否した要求も記録する（＝古い版が使われていることの観測）', async () => {
    await fromSocket(appWithBundle(), '/api/app-mode', 'kanean-mcp/0.1.0')

    const status = linkStatus(router, BUNDLED)
    expect(status.seen).toBe(true)
    expect(status.lastVersion).toBe('0.1.0')
    expect(status.matches).toBe(false)
  })

  it('名乗らない到達も記録する（記録が無い状態と区別する）', async () => {
    await fromSocket(appWithBundle(), '/api/app-mode')

    const status = linkStatus(router, BUNDLED)
    expect(status.seen).toBe(true)
    expect(status.lastVersion).toBe(UNKNOWN_VERSION)
    expect(status.matches).toBe(false)
  })

  it('同梱版が分からなければ一致を判断しない', () => {
    recordSeen(router, '0.1.0')
    expect(linkStatus(router, null).matches).toBeNull()
  })

  it('UI からの呼び出しは到達として記録しない', async () => {
    await appWithBundle().fetch(new Request('http://local/api/app-mode'))
    expect(linkStatus(router, BUNDLED).seen).toBe(false)
  })

  it('記録は control plane に置く＝帳簿を切り替えても同じものを見る', async () => {
    await fromSocket(appWithBundle(), '/api/app-mode', `kanean-mcp/${BUNDLED}`)

    createBook(router, 'もう1冊')

    // 帳簿を作っても（＝data plane が増えても）連携の記録は同じ。
    expect(linkStatus(router, BUNDLED).lastVersion).toBe(BUNDLED)
  })
})

describe('疎通状態の API', () => {
  it('ホーム画面が読む形で返す', async () => {
    await fromSocket(appWithBundle(), '/api/app-mode', 'kanean-mcp/0.1.0')

    const res = await appWithBundle().fetch(new Request('http://local/api/mcp-link'))
    expect(res.status).toBe(200)
    expect(await res.json()).toMatchObject({
      seen: true,
      lastVersion: '0.1.0',
      bundledVersion: BUNDLED,
      matches: false,
    })
  })
})
