import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  AccountBalanceRow,
  BalanceSheet,
  GeneralLedger,
  ProfitAndLoss,
  SubLedger,
  TrialBalance,
} from '../apiTypes.js'
import { ok, problem } from '../result.js'
import { bookArg, defineTool, query, type ToolDeps } from './register.js'

/**
 * 帳票（試算表・損益計算書・貸借対照表・元帳）と科目残高。
 *
 * どれも**確定済み仕訳のみ**を集計する（[[reports]]）。承認待ちは混ぜず、
 * 件数として別に示す。「集計に載っていない仕訳がある」ことが分からないまま
 * 数字だけ渡すと、判断を誤らせるため。
 */

const dateArgs = {
  from: z.string().optional().describe('集計開始日 YYYY-MM-DD。省略時は会計年度の期首'),
  to: z.string().optional().describe('集計終了日 YYYY-MM-DD。省略時は会計年度の期末'),
}

/** 承認待ちの件数を添える。集計そのものには入っていないことを明示するため。 */
async function pendingDraftCount(
  call: <T>(urlPath: string) => Promise<T>,
): Promise<number> {
  const { entries } = await call<{ entries: unknown[] }>('/api/entries?status=draft')
  return entries.length
}

function draftNote(pending: number): string[] {
  return pending > 0
    ? [
        `承認待ちの仕訳が ${pending} 件ある。これらは集計に入っていない。確定は Kanean の画面で人が行う`,
      ]
    : []
}

export function registerReportTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    'get_trial_balance',
    {
      title: '試算表',
      description:
        '試算表（科目ごとの期首残高・期間の借方貸方・期末残高）を返す。期間を指定できる。' +
        '確定済みの仕訳のみを集計する。',
      inputSchema: { ...dateArgs, ...bookArg },
    },
    async (args, call) => {
      const [{ report }, pending] = await Promise.all([
        call<{ report: TrialBalance }>(`/api/reports/trial-balance${query({ from: args.from, to: args.to })}`),
        pendingDraftCount(call),
      ])
      return ok({ data: report, counts: { pendingDrafts: pending }, nextActions: draftNote(pending) })
    },
  )

  defineTool(
    server,
    deps,
    'get_profit_and_loss',
    {
      title: '損益計算書',
      description: '損益計算書（収益・費用・利益）を返す。確定済みの仕訳のみを集計する。',
      inputSchema: { ...bookArg },
    },
    async (_args, call) => {
      const [{ report }, pending] = await Promise.all([
        call<{ report: ProfitAndLoss }>('/api/reports/pl'),
        pendingDraftCount(call),
      ])
      return ok({ data: report, counts: { pendingDrafts: pending }, nextActions: draftNote(pending) })
    },
  )

  defineTool(
    server,
    deps,
    'get_balance_sheet',
    {
      title: '貸借対照表',
      description: '貸借対照表（資産・負債・資本）を返す。確定済みの仕訳のみを集計する。',
      inputSchema: { ...bookArg },
    },
    async (_args, call) => {
      const [{ report }, pending] = await Promise.all([
        call<{ report: BalanceSheet }>('/api/reports/bs'),
        pendingDraftCount(call),
      ])
      return ok({ data: report, counts: { pendingDrafts: pending }, nextActions: draftNote(pending) })
    },
  )

  // 総勘定元帳と補助元帳は「どの軸で明細を並べるか」が違うだけなので1本にまとめる。
  defineTool(
    server,
    deps,
    'get_ledger',
    {
      title: '元帳',
      description:
        '指定した勘定科目の総勘定元帳を返す。subAccountId を指定すると補助元帳になる。' +
        '科目の id は get_trial_balance の結果から取れる。',
      inputSchema: {
        accountId: z.number().int().optional().describe('勘定科目の id（総勘定元帳）'),
        subAccountId: z.number().int().optional().describe('補助科目の id（補助元帳）'),
        ...dateArgs,
        ...bookArg,
      },
    },
    async (args, call) => {
      if (args.accountId == null && args.subAccountId == null) {
        return problem('どの科目の元帳かが決まりません。', {
          code: 'account_required',
          nextActions: [
            'get_trial_balance を呼んで科目の id を確認する',
            'accountId（総勘定元帳）か subAccountId（補助元帳）のどちらかを指定する',
          ],
        })
      }
      const period = query({ from: args.from, to: args.to })
      const [report, pending] = await Promise.all([
        args.subAccountId != null
          ? call<{ report: SubLedger }>(`/api/reports/sub-ledger/${args.subAccountId}${period}`)
          : call<{ report: GeneralLedger }>(`/api/reports/ledger/${args.accountId}${period}`),
        pendingDraftCount(call),
      ])
      return ok({
        data: report.report,
        counts: { pendingDrafts: pending },
        nextActions: draftNote(pending),
      })
    },
  )

  defineTool(
    server,
    deps,
    'get_account_balance',
    {
      title: '科目残高',
      description:
        '指定した日付時点の、指定した勘定科目の残高を返す（例:「7月末の売掛金」）。' +
        '科目名は部分一致で探す。確定済みの仕訳のみを集計する。',
      inputSchema: {
        account: z.string().describe('勘定科目名（部分一致。例: 売掛金）'),
        asOf: z.string().optional().describe('基準日 YYYY-MM-DD。省略時は会計年度の期末'),
        ...bookArg,
      },
    },
    async (args, call) => {
      // 専用の API は足さない。試算表を期末で締めて、該当科目を取り出す。
      const [{ report }, pending] = await Promise.all([
        call<{ report: TrialBalance }>(`/api/reports/trial-balance${query({ to: args.asOf })}`),
        pendingDraftCount(call),
      ])

      const needle = args.account.trim()
      const matched = report.rows.filter((row: AccountBalanceRow) => row.accountName.includes(needle))

      if (matched.length === 0) {
        return problem(`「${needle}」に一致する勘定科目が見つかりません。`, {
          code: 'account_not_found',
          data: { availableAccounts: report.rows.map((r: AccountBalanceRow) => r.accountName) },
          nextActions: ['候補の科目名から選び直す'],
        })
      }

      return ok({
        data: {
          asOf: args.asOf ?? '会計年度の期末',
          matches: matched.map((row: AccountBalanceRow) => ({
            accountId: row.accountId,
            accountName: row.accountName,
            // normal_balance 方向の残高（正＝通常側）。`to` のみ指定で期末時点の累計になる。
            balance: row.balance,
            normalBalance: row.normalBalance,
          })),
        },
        counts: { pendingDrafts: pending, matchedAccounts: matched.length },
        nextActions: draftNote(pending),
      })
    },
  )
}
