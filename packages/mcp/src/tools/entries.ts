import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { EntryView, TaxForecast } from '../apiTypes.js'
import { ok } from '../result.js'
import { bookArg, defineTool, query, type ToolDeps } from './register.js'

/** 仕訳の検索と納税予測。 */

export function registerEntryTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    'search_entries',
    {
      title: '仕訳検索',
      description:
        '仕訳を検索する（期間・摘要の部分一致・勘定科目で絞り込み）。' +
        '既定は確定済みのみ。承認待ちを見たいときは status に draft を指定する。',
      inputSchema: {
        q: z.string().optional().describe('摘要の部分一致'),
        from: z.string().optional().describe('取引日の開始 YYYY-MM-DD'),
        to: z.string().optional().describe('取引日の終了 YYYY-MM-DD'),
        accountId: z.number().int().optional().describe('この勘定科目を含む仕訳に限定'),
        status: z
          .enum(['confirmed', 'draft', 'all'])
          .optional()
          .describe('既定は confirmed（確定済みのみ）'),
        limit: z.number().int().positive().max(500).optional().describe('返す件数の上限'),
        ...bookArg,
      },
    },
    async (args, call) => {
      const { entries } = await call<{ entries: EntryView[] }>(
        `/api/entries${query({
          q: args.q,
          from: args.from,
          to: args.to,
          accountId: args.accountId,
          status: args.status,
          limit: args.limit,
        })}`,
      )

      const drafts = entries.filter((e) => e.status === 'draft').length
      return ok({
        data: entries,
        counts: { returned: entries.length, drafts },
        nextActions:
          drafts > 0
            ? ['承認待ちが含まれている。確定は Kanean の画面で人が行う（ここからは確定できない）']
            : [],
        openInApp: drafts > 0 ? 'raw' : undefined,
      })
    },
  )

  defineTool(
    server,
    deps,
    'get_tax_forecast',
    {
      title: '納税予測',
      description:
        '現時点の確定済み仕訳から、所得税・消費税の見込み額を返す。' +
        '**提出できる申告額ではない**。実際の申告は決算整理と税理士の確認を経る。',
      inputSchema: { ...bookArg },
    },
    async (_args, call) => {
      const forecast = await call<{ forecast: TaxForecast } | TaxForecast>('/api/tax-forecast')
      return ok({
        data: forecast,
        nextActions: [
          'これは見込みであり、決算整理前の値であることを利用者に伝える',
          '申告書そのものは Kanean の「所得税申告」画面で作る',
        ],
        openInApp: 'incometax',
      })
    },
  )
}
