import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { AppMode, BookInfo, EntryView, FiscalYearView } from '../apiTypes.js'
import { callApp } from '../callApp.js'
import { isReachable } from '../connection.js'
import { ok, problem, toProblem } from '../result.js'
import { bookArg, defineTool, type ToolDeps } from './register.js'

/**
 * 現在地（帳簿・会計年度・アプリモード・承認待ち件数）と、アプリの起動。
 *
 * 会話の最初にここを呼べば、以降のツールが前提を満たしているか分かる。
 * 帳簿が2冊以上あるとき・会計年度が無いときの分岐もここで見える。
 */

export function registerContextTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    'get_context',
    {
      title: '現在地',
      description:
        'Kanean の現在地を返す（帳簿・会計年度・アプリモード・承認待ち件数）。' +
        '他のツールを使う前にまずこれを呼ぶと、帳簿の指定が要るか・会計年度があるかが分かる。',
      inputSchema: { ...bookArg },
    },
    async (_args, call) => {
      const [{ books }, { mode }] = await Promise.all([
        call<{ books: BookInfo[] }>('/api/books'),
        call<{ mode: AppMode }>('/api/app-mode'),
      ])

      const active = books.filter((b) => !b.archivedAt)
      // 帳簿が2冊以上あると年度・件数の取得も帳簿指定を要求される。ここで止めて選択肢を返す。
      if (active.length > 1 && !(_args as { bookId?: string }).bookId) {
        return problem('対象の帳簿が決まりません。どの帳簿か利用者に確認してください。', {
          code: 'book_required',
          data: { books: active.map((b) => ({ id: b.id, name: b.name })) },
          nextActions: ['利用者にどの帳簿かを尋ね、その id を bookId として同じ操作をやり直す'],
        })
      }

      const { fiscalYears } = await call<{ fiscalYears: FiscalYearView[] }>('/api/fiscal-years')
      const openYear = fiscalYears.find((y) => y.status === 'open') ?? null

      if (!openYear) {
        // 空の帳票を返さない。何が足りないかと、その解決先を返す。
        return problem('会計年度がまだありません。帳票も仕訳もこの状態では作れません。', {
          code: 'no_open_fiscal_year',
          data: { books: active, appMode: mode },
          nextActions: ['Kanean の設定画面で会計年度を作成してもらう'],
          openInApp: 'settings',
        })
      }

      // 承認待ちは件数だけ返す（明細そのものは会話に載せない）。
      const { entries } = await call<{ entries: EntryView[] }>('/api/entries?status=draft')

      return ok({
        data: {
          appMode: mode,
          books: active.map((b) => ({ id: b.id, name: b.name })),
          openFiscalYear: { from: openYear.startDate, to: openYear.endDate },
        },
        counts: { pendingDrafts: entries.length },
        nextActions:
          entries.length > 0
            ? ['承認待ちの仕訳がある。確定は Kanean の画面で人が行う（ここからは確定できない）']
            : [],
        openInApp: entries.length > 0 ? 'raw' : undefined,
      })
    },
  )

  // 起動そのものはツールとして分ける。elicitation を持たないクライアントでも、
  // 「人に確認 → このツールを呼ぶ」で確認付き起動が成り立つようにするため。
  server.registerTool(
    'kanean_start_app',
    {
      title: 'Kanean を起動する',
      description:
        'Kanean を起動する。**利用者の承諾を得てから呼ぶこと**。' +
        '会計データを読むツールが「起動していない」と返したときの次の一手。',
      inputSchema: {
        confirmed: z
          .literal(true)
          .describe('利用者が起動に同意したことを示す。同意を得ずに true にしない'),
      },
      annotations: { readOnlyHint: false, openWorldHint: false },
    },
    async () => {
      const ctx = deps.context()
      if (await isReachable(ctx.target)) {
        return ok({ data: { alreadyRunning: true }, nextActions: ['そのまま目的の操作を続ける'] })
      }
      try {
        await callApp({ ...ctx, preapproved: true }, '/health')
        return ok({ data: { started: true }, nextActions: ['目的の操作をやり直す'] })
      } catch (err) {
        return toProblem(err)
      }
    },
  )
}
