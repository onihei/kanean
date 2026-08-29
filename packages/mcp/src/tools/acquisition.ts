import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type {
  CalibrationView,
  ClassifyResult,
  DiagnosticView,
  JobState,
  JobView,
  UnclassifiedResult,
} from '../apiTypes.js'
import { ok, problem } from '../result.js'
import { bookArg, defineTool, query, type ToolDeps } from './register.js'

/**
 * 連携サービスの取込（[[acquisition]]）。
 *
 * ここで露出してよいのは **開始 / 状態の問い合わせ / 未確定 draft の分類 / 失敗の診断 / 較正の更新** だけ
 * （mcp-server spec「書き込みの限定と承認の非委譲」）。draft の確定はここには無い。
 *
 * 取込は人のログイン待ちを含むので、開始と結果取得が分かれる。**取込は分類を待たずに完了する**
 * （科目が決まらない明細も未確定として帳簿に並ぶ）。分類はその後、未確定に科目を当てる操作で行う。
 */

/** 進行の説明（人へそのまま見せられる1行）。 */
const STATE_LABEL: Record<JobState, string> = {
  starting: '開始しています',
  awaiting_login: 'ログイン待ち（利用者がブラウザ窓で入力します）',
  fetching: '明細を取得しています',
  done: '完了（取り込んだ仕訳は帳簿に並んでいます）',
  failed: '失敗',
  aborted: '中断',
}

function nextActionsFor(job: JobView): string[] {
  switch (job.state) {
    case 'starting':
    case 'fetching':
      return ['kanean_get_import_status で進行を確かめる（巡回の完了は待たずに返る）']
    case 'awaiting_login':
      return [
        '開いたブラウザ窓で利用者がログイン・2要素認証を行う（認証情報は代わりに入力しない）',
        'kanean_get_import_status で完了を確かめる',
      ]
    case 'done':
      return [
        '取り込んだ仕訳はすべて draft。**確定は利用者が Kanean の画面で行う**',
        '件数の内訳（受理・重複・期間外・未確定・取得できず）を利用者へ伝える',
        // 部分成功を黙って完了扱いにしない（acquisition spec「部分成功の可視化」）。
        ...(job.counts?.failed
          ? [
              `${job.counts.failed} 件は取得できなかった（部分成功）。理由は counts.warnings に並ぶ。` +
                '黙って完了扱いにせず、利用者へ伝える',
            ]
          : []),
        ...(job.counts?.unresolved
          ? [`${job.counts.unresolved} 件は科目が未確定。kanean_list_unclassified で分類できる`]
          : []),
      ]
    case 'failed':
      return [
        'kanean_get_import_diagnostic で失敗の手掛かりを取る',
        '較正で直る見込みがあれば kanean_update_site_calibration で直して取り直す',
      ]
    case 'aborted':
      return ['中断したので何も投入していない。取り直すなら kanean_start_import から']
  }
}

export function registerAcquisitionTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    'start_import',
    {
      title: '連携サービスの取込を開始',
      description:
        '登録済みの連携サービス（EC・銀行・カード）の明細取込を開始する。' +
        'ブラウザ窓が開き、ログイン・2要素認証は利用者が行う（代わりに入力してはならない）。' +
        '巡回の完了は待たずに識別子と状態を返すので、kanean_get_import_status で進める。' +
        '取得範囲は既定で「開いている会計期間 ∩ 前回取得以降」。**取込はデスクトップアプリでのみ行える**。',
      inputSchema: {
        source: z
          .string()
          .describe('連携サービスの識別子（kanean_list_linked_services の serviceKey）'),
        since: z
          .string()
          .optional()
          .describe('取得開始日 YYYY-MM-DD。**通常は指定しない**（指定すると差分の起点が前進しない）'),
        until: z.string().optional().describe('取得終了日 YYYY-MM-DD。通常は指定しない'),
        ...bookArg,
      },
      readOnly: false,
    },
    async (args, call) => {
      const job = await call<JobView>('/api/acquisition/jobs', {
        method: 'POST',
        body: { source: args.source, since: args.since, until: args.until },
      })
      return ok({
        data: { ...job, stateLabel: STATE_LABEL[job.state] },
        nextActions: [
          ...(job.rangeLimited
            ? ['範囲を限ったので差分の起点は前進しない（残りは次回の対象として残る）']
            : []),
          ...nextActionsFor(job),
        ],
        openInApp: 'services',
      })
    },
  )

  defineTool(
    server,
    deps,
    'get_import_status',
    {
      title: '取込の進行を見る',
      description:
        '取込の進行状態を返す。完了していれば受理・重複・期間外・未確定・取得できず（部分成功）の件数が返る。' +
        '取込は分類を待たずに完了し、科目が決まらなかった明細は未確定の draft として帳簿に並ぶ。',
      inputSchema: {
        jobId: z.string().describe('kanean_start_import が返した取込の識別子'),
        ...bookArg,
      },
    },
    async (args, call) => {
      const job = await call<JobView>(`/api/acquisition/jobs/${encodeURIComponent(args.jobId)}`)
      return ok({
        data: { ...job, stateLabel: STATE_LABEL[job.state] },
        counts: job.counts
          ? {
              受理: job.counts.accepted,
              重複: job.counts.duplicated,
              期間外: job.counts.outOfPeriod,
              未確定: job.counts.unresolved,
              取得できず: job.counts.failed,
            }
          : undefined,
        nextActions: nextActionsFor(job),
        openInApp: job.state === 'done' ? 'raw' : undefined,
      })
    },
  )

  defineTool(
    server,
    deps,
    'list_unclassified',
    {
      title: '科目が決まっていない仕訳を見る',
      description:
        '科目が決まっていない draft（未確定勘定のまま残っているもの）の品名・摘要を、重複をまとめて返す。' +
        '取込の経路（巡回・CSV・手入力）によらず同じものが返る。' +
        'あわせて **policy（この帳簿の分類方針）** と **history（過去に確定した分類）** を返す。' +
        '判断はこの順に従う: ①history に同じ摘要があればそれに倣う ②policy の決定的ルール ' +
        '③品名からの判断 ④どれでもなければ**分類しない**（未確定のまま残す）。' +
        '**金額・取引識別子・残高・日付は返らない**（判断は文字だけで行う）。',
      inputSchema: {
        source: z
          .string()
          .optional()
          .describe('連携サービスの識別子で絞る（省略すると帳簿全体の未確定）'),
        limit: z.number().int().positive().optional().describe('返す種類数の上限'),
        ...bookArg,
      },
    },
    async (args, call) => {
      const result = await call<UnclassifiedResult>(
        `/api/acquisition/unclassified${query({ source: args.source, limit: args.limit })}`,
      )
      if (result.total === 0) {
        return ok({
          data: { policy: result.policy },
          counts: { 未確定: 0 },
          nextActions: ['科目が決まっていない仕訳はない'],
        })
      }
      return ok({
        data: { policy: result.policy, items: result.items, history: result.hints },
        counts: { 未確定の種類: result.total, 返した種類: result.items.length },
        nextActions: [
          'policy（この帳簿の分類方針）に従う。とくに「決定的な項目」は必ずその科目にする',
          'history に同じ摘要・品名があれば、まずそれに倣う（利用者が過去に確定した実績）',
          'それぞれに勘定科目を決めて kanean_classify_drafts で返す',
          '**reason（理由を1行）と confidence を必ず添える**。'
            + '添えないと利用者の画面で根拠が出ず、確信度での一括確定ができない',
          '判断がつかないものは無理に埋めず、外して未確定のまま残す（推測で科目を作らない）',
          ...(result.total > result.items.length
            ? [`未確定は全部で ${result.total} 種類ある。残りは続けて取得する`]
            : []),
        ],
      })
    },
  )

  defineTool(
    server,
    deps,
    'classify_drafts',
    {
      title: '未確定の仕訳に科目を当てる',
      description:
        'kanean_list_unclassified が返した識別子ごとに勘定科目を当てる。' +
        '同じ品名・摘要の未確定すべてに効く。**確定はしない**（確定は利用者が画面で行う）。' +
        '既に利用者が片付けていた対象は「適用0件」として返り、失敗にはならない。' +
        '**reason と confidence は必ず付けること**: 利用者はそれを見て確定するので、' +
        '無いと1件ずつ中身を開いて確かめることになる。',
      inputSchema: {
        answers: z
          .array(
            z.object({
              id: z.string().describe('kanean_list_unclassified が返した items の id'),
              proposedAccount: z
                .string()
                .describe('勘定科目名（例: 消耗品費）。存在する科目名を指すこと（新設はできない）'),
              reason: z
                .string()
                .describe('そう判断した理由を1行で。利用者が確定するときに読む（例: 「携帯回線の月額」）'),
              confidence: z
                .enum(['high', 'medium', 'low'])
                .describe(
                  'high=履歴か決定的ルールに一致 / medium=品名から妥当 / low=自信が無い。'
                    + '利用者は high をまとめて確定し、それ以外を1件ずつ見る',
                ),
              policyRef: z.string().optional().describe('依拠した方針の項目名（任意）'),
            }),
          )
          .describe('分類結果。判断がつかないものは含めない'),
        source: z.string().optional().describe('対象を連携サービスで絞る（省略すると帳簿全体）'),
        ...bookArg,
      },
      readOnly: false,
    },
    async (args, call) => {
      const r = await call<ClassifyResult>('/api/acquisition/unclassified', {
        method: 'POST',
        body: { answers: args.answers, source: args.source },
      })
      return ok({
        data: r,
        counts: { 適用: r.applied, 対応なし: r.unmatched, 残りの未確定: r.remaining },
        nextActions: [
          '利用者の画面では、確信度 high をまとめて確定 → 残りを1件ずつ精査する流れになる',
          ...(r.unknownAccounts.length
            ? [
                `存在しない勘定科目を指したため当てていない: ${r.unknownAccounts.join(' / ')}`,
                '勘定科目は新設できない。既存の科目名から選び直す',
              ]
            : []),
          ...(r.unmatched
            ? [`${r.unmatched} 件は対応する未確定が無かった（利用者が先に片付けた可能性）`]
            : []),
          ...(r.remaining
            ? [`まだ ${r.remaining} 件の未確定がある。kanean_list_unclassified で続けられる`]
            : []),
          '当てたのは科目の提案まで。**確定は利用者が Kanean の画面で行う**',
        ],
        openInApp: 'raw',
      })
    },
  )

  defineTool(
    server,
    deps,
    'get_import_diagnostic',
    {
      title: '取込が失敗した理由を調べる',
      description:
        '直近の巡回失敗について、どの手順で・どの画面で失敗したかを返す。' +
        '較正の差し替えで直る見込みがあるか（calibratable）も判定して返すので、' +
        '**直らない種類の失敗に対して較正の更新を繰り返さないこと**。' +
        '認証情報とセッション識別子は含まれない。',
      inputSchema: {
        source: z.string().describe('連携サービスの識別子'),
        ...bookArg,
      },
    },
    async (args, call) => {
      const d = await call<DiagnosticView>(
        `/api/acquisition/${encodeURIComponent(args.source)}/diagnostic`,
      )
      return ok({
        data: d,
        nextActions: d.calibratable
          ? [
              `較正で直る見込み: ${d.verdict}`,
              `kanean_get_site_calibration で現在の較正を見て、${d.suggestedKeys.join(' / ') || '該当キー'} を直す`,
              'kanean_update_site_calibration で更新してから取り直す',
            ]
          : [
              `較正では直らない: ${d.verdict}`,
              '較正の更新は繰り返さない。画面の状態を利用者に確認してもらう',
            ],
      })
    },
  )

  defineTool(
    server,
    deps,
    'get_site_calibration',
    {
      title: 'サイト較正を見る',
      description:
        '巡回が画面上の要素を見つけるために使う較正（セレクタ・ラベル・列名）を返す。' +
        '同梱の既定（bundled）と、実際に使われている値（effective）の両方が返る。',
      inputSchema: { source: z.string().describe('連携サービスの識別子'), ...bookArg },
    },
    async (args, call) => {
      const view = await call<CalibrationView>(
        `/api/acquisition/${encodeURIComponent(args.source)}/calibration`,
      )
      return ok({
        data: view,
        nextActions: [
          '直すのは失敗の診断が指しているキーだけにする（当てずっぽうで広く書き換えない）',
          ...(view.origin === 'override'
            ? ['既に上書きがある。うまくいかないときは kanean_reset_site_calibration で同梱へ戻せる']
            : []),
        ],
      })
    },
  )

  defineTool(
    server,
    deps,
    'update_site_calibration',
    {
      title: 'サイト較正を更新',
      description:
        'サイトの作りが変わって巡回が失敗するとき、要素の指し方（較正）を差し替える。' +
        '**受け付けるのはデータだけ**（文字列・数値・文字列配列）で、プログラムは受け付けない。' +
        '同梱に無いキーの追加・型の変更・http/https 以外の URL は拒否される。' +
        'うまくいかなければ kanean_reset_site_calibration で同梱の較正へ戻せる。',
      inputSchema: {
        source: z.string().describe('連携サービスの識別子'),
        calibration: z
          .record(z.string(), z.unknown())
          .describe('差し替えるキーと値だけを渡す（渡さなかったキーは同梱のまま）'),
        version: z.string().optional().describe('この較正の呼び名（結果に残る）'),
        ...bookArg,
      },
      readOnly: false,
    },
    async (args, call) => {
      const view = await call<CalibrationView>(
        `/api/acquisition/${encodeURIComponent(args.source)}/calibration`,
        { method: 'PUT', body: { ...args.calibration, version: args.version } },
      )
      return ok({
        data: view,
        nextActions: [
          `較正を更新した（${view.overridden.join(' / ')}）`,
          'kanean_start_import で取り直して、直ったかを確かめる',
        ],
      })
    },
  )

  defineTool(
    server,
    deps,
    'reset_site_calibration',
    {
      title: 'サイト較正を同梱へ戻す',
      description:
        '上書きした較正を消して、アプリに同梱されている較正へ戻す。壊れた較正からの復帰に使う。',
      inputSchema: { source: z.string().describe('連携サービスの識別子'), ...bookArg },
      readOnly: false,
    },
    async (args, call) => {
      const view = await call<CalibrationView & { hadOverride: boolean }>(
        `/api/acquisition/${encodeURIComponent(args.source)}/calibration`,
        { method: 'DELETE' },
      )
      if (!view.hadOverride) {
        return problem('上書きの較正はありませんでした（もともと同梱の較正で動いています）。', {
          code: 'no_override',
          data: view,
          nextActions: ['失敗が続くなら kanean_get_import_diagnostic で原因を確かめる'],
        })
      }
      return ok({
        data: view,
        nextActions: ['同梱の較正へ戻した。kanean_start_import で取り直す'],
      })
    },
  )
}
