import fs from 'node:fs'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import type { FilingInstructionSheet, FilingPrecheck, FilingRecord } from '../apiTypes.js'
import { ok, problem } from '../result.js'
import { bookArg, defineTool, query, type ToolDeps } from './register.js'

/**
 * 申告の提出支援（filing spec / mcp-server spec「申告の準備」「申告の完了記録」）。
 *
 * 読み: precheck（前提の不備）と入力指示書（作成コーナー転記値）。
 * 書き: 完了記録の作成＋控えの添付だけ。記録の削除・設定の変更はここからはできない。
 * どの応答も「提出可能」を宣言しない——判定はいつも人（と税理士）の側にある。
 */

/** 控えファイルの拡張子 → Content-Type（本体の受理形式と同じ集合）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

export function registerFilingTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    'get_filing_precheck',
    {
      title: '申告前チェック',
      description:
        '確定申告の前提（貸借の一致・青色申告特別控除の設定・消費税の事業区分・所得控除入力・' +
        '承認待ち仕訳）を点検し、不備（blocking）と注意（warning）に区分して返す。' +
        '不備が無くても「提出可能」を意味しない。',
      inputSchema: { ...bookArg },
    },
    async (_args, call) => {
      const { precheck } = await call<{ precheck: FilingPrecheck | null }>('/api/filing/precheck')
      if (!precheck) {
        return problem('開いている会計年度がありません。', {
          code: 'no_open_year',
          nextActions: ['Kanean の画面で会計年度を作成してから、やり直す'],
          openInApp: 'home',
        })
      }
      const blocking = precheck.issues.filter((i) => i.level === 'blocking')
      return ok({
        data: precheck,
        counts: {
          blocking: blocking.length,
          warning: precheck.issues.length - blocking.length,
          pendingDrafts: precheck.draftCount,
        },
        nextActions:
          blocking.length > 0
            ? ['不備（blocking）を解消してから転記に進む（各 issue の screen が該当画面）']
            : ['kanean_get_filing_sheet で入力指示書を取得し、転記に進める'],
        openInApp: 'filing',
      })
    },
  )

  defineTool(
    server,
    deps,
    'get_filing_sheet',
    {
      title: '入力指示書',
      description:
        '確定申告書等作成コーナーへ転記すべき値の一覧を、コーナーの画面順（決算書→所得税→消費税）で返す。' +
        '項目は input（入力）/ select（選択）/ verify（コーナーの自動計算欄＝入力せず一致を確認）の3種。' +
        '末尾の checksum は送信前に画面の税額と1円単位で突き合わせる検算値。',
      inputSchema: { ...bookArg },
    },
    async (_args, call) => {
      const { sheet } = await call<{ sheet: FilingInstructionSheet | null }>('/api/filing/instruction-sheet')
      if (!sheet) {
        return problem('開いている会計年度がありません。', {
          code: 'no_open_year',
          nextActions: ['Kanean の画面で会計年度を作成してから、やり直す'],
          openInApp: 'home',
        })
      }
      return ok({
        data: sheet,
        counts: { groups: sheet.groups.length },
        nextActions: [
          '転記する数値・選択はこの指示書のみを源とする（計算・推測・補完で値を作らない）',
          'ログイン・マイナンバーカードの認証（QR 読み取り）・送信の操作は利用者が行う',
          'verify 欄が一致しないときは入力を止め、欄名と両方の値を利用者に報告する',
          '送信前に checksum と作成コーナーの計算結果の一致を利用者に提示する',
        ],
      })
    },
  )

  defineTool(
    server,
    deps,
    'record_filing',
    {
      title: '申告の完了記録',
      description:
        '申告の提出を記録し、受信通知・申告書控え等のファイルを控えとして添付する。' +
        '検算（checksum）の一致と利用者による送信の完了を確認してから呼ぶこと。' +
        '記録は事実の記録であり、提出の有効性を判定しない。記録の削除は Kanean の画面で行う。',
      inputSchema: {
        taxKind: z.enum(['income_tax', 'consumption']).describe('税目（所得税 / 消費税）'),
        method: z
          .enum(['corner_etax', 'paper', 'other'])
          .describe('提出方法。作成コーナーからの e-Tax 送信は corner_etax'),
        submittedOn: z.string().describe('提出日 YYYY-MM-DD'),
        receiptNumber: z.string().optional().describe('受付番号（受信通知に記載）'),
        memo: z.string().optional().describe('メモ'),
        attachmentPaths: z
          .array(z.string())
          .optional()
          .describe('控えファイル（PDF 等）のローカルパス。受信通知・申告書控えのダウンロード先を指定する'),
        ...bookArg,
      },
      readOnly: false,
    },
    async (args, call) => {
      // 先にファイルを読めることを確かめる（記録だけ作って添付に失敗する中途半端を避ける）。
      const files: { name: string; contentType: string; bytes: Buffer }[] = []
      for (const p of args.attachmentPaths ?? []) {
        const contentType = CONTENT_TYPES[path.extname(p).toLowerCase()]
        if (!contentType) {
          return problem(`控えとして扱えない形式です: ${p}`, {
            code: 'unsupported_attachment',
            nextActions: ['PDF / JPEG / PNG / HEIC のファイルパスを指定してやり直す'],
          })
        }
        try {
          files.push({ name: path.basename(p), contentType, bytes: fs.readFileSync(p) })
        } catch {
          return problem(`控えファイルが読めません: ${p}`, {
            code: 'attachment_unreadable',
            nextActions: ['ダウンロード先のパスを確かめてやり直す（記録はまだ作られていない）'],
          })
        }
      }

      const { record } = await call<{ record: FilingRecord }>('/api/filing/records', {
        method: 'POST',
        body: {
          taxKind: args.taxKind,
          method: args.method,
          submittedOn: args.submittedOn,
          receiptNumber: args.receiptNumber,
          memo: args.memo,
        },
      })

      let attached = 0
      for (const f of files) {
        await call(`/api/filing/records/${record.id}/attachments${query({ fileName: f.name })}`, {
          method: 'POST',
          rawBody: { bytes: f.bytes, contentType: f.contentType },
        })
        attached++
      }

      return ok({
        data: { record },
        counts: { attached },
        nextActions: [
          '記録と控えは Kanean の確定申告画面から確認できる',
          ...(args.method === 'corner_etax' && args.taxKind === 'income_tax'
            ? ['e-Tax 送信を記録した。青色申告特別控除（65万円）の設定が実態と合っているか、画面の案内から確認する']
            : []),
        ],
        openInApp: 'filing',
      })
    },
  )
}
