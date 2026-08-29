import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js'
import { z } from 'zod'
import { ok, problem } from '../result.js'
import { bookArg, defineTool, type ToolDeps } from './register.js'

/**
 * レシートの取込（receipt-inbox spec / mcp-server spec「書き込みの限定」）。
 *
 * **現金は起票し、カードは起票しない。** カードの明細は [[acquisition]] が取り込むので、
 * ここで起票すると二重計上になる。カードは突合候補を返すだけで、選ぶのは人。
 *
 * 冪等の鍵は画像の SHA-256。同じ写真を送り直しても仕訳も添付も増えない。
 */

/** 受理する画像の拡張子 → Content-Type（本体の受理形式と同じ集合）。 */
const CONTENT_TYPES: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.heic': 'image/heic',
  '.heif': 'image/heif',
}

interface ReceiptImportResponse {
  outcome: 'registered' | 'skipped'
  entryId?: number
  attachmentId?: number
  accountName?: string
  date?: string
  totalAmount?: number
  unresolved?: string
  reason?: string
  detail?: string
}

interface MatchCandidate {
  entryId: number
  entryDate: string
  description: string | null
  amount: number
  accountName: string
  status: string
  reasons: string[]
}

export function registerReceiptTools(server: McpServer, deps: ToolDeps): void {
  defineTool(
    server,
    deps,
    'import_cash_receipt',
    {
      title: '現金レシートを取り込む',
      description:
        '現金払いのレシートを draft 仕訳として起票し、画像を証憑として添付する。' +
        'カード払いには使わない（二重計上になる。カードは kanean_match_card_receipt）。' +
        '同じ画像を再び渡しても増えない。確定は利用者が Kanean の画面で行う。',
      inputSchema: {
        imagePath: z.string().describe('レシート画像のローカルパス（JPEG / PNG / HEIC）'),
        transactionDate: z
          .string()
          .optional()
          .describe('レシートの日付 YYYY-MM-DD。読み取れなければ省く（推測で埋めない）'),
        totalAmount: z
          .number()
          .int()
          .optional()
          .describe('合計金額（円整数）。読み取れなければ省く（推測で埋めない）'),
        merchant: z.string().optional().describe('店名'),
        proposedAccount: z
          .string()
          .optional()
          .describe('提案する勘定科目名。マスタに無い名前は未確定勘定へ寄せられる'),
        usage: z
          .enum(['business', 'prorated', 'private'])
          .optional()
          .describe('用途（事業／按分／私用）。端末で付いていればそのまま渡す'),
        partySize: z
          .number()
          .int()
          .optional()
          .describe('飲食の参加人数。交際費／会議費の判断材料になるので落とさない'),
        participants: z.array(z.string()).optional().describe('飲食の相手（誰と）'),
        memo: z.string().optional().describe('摘要'),
        ...bookArg,
      },
      readOnly: false,
    },
    async (args, call) => {
      const contentType = CONTENT_TYPES[path.extname(args.imagePath).toLowerCase()]
      if (!contentType) {
        return problem(`レシートとして扱えない形式です: ${args.imagePath}`, {
          code: 'unsupported_image',
          nextActions: ['JPEG / PNG / HEIC のファイルパスを指定してやり直す'],
        })
      }
      let bytes: Buffer
      try {
        bytes = fs.readFileSync(args.imagePath)
      } catch {
        return problem(`レシート画像が読めません: ${args.imagePath}`, {
          code: 'image_unreadable',
          nextActions: ['パスを確かめてやり直す（仕訳はまだ作られていない）'],
        })
      }

      const res = await call<ReceiptImportResponse>('/skill/receipts/journal-candidates', {
        method: 'POST',
        body: {
          transactionDate: args.transactionDate,
          totalAmount: args.totalAmount,
          merchant: args.merchant,
          proposedAccount: args.proposedAccount,
          usage: args.usage,
          meal: args.partySize
            ? { partySize: args.partySize, participants: args.participants }
            : undefined,
          memo: args.memo,
          image: {
            fileName: path.basename(args.imagePath),
            contentType,
            sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
            base64: bytes.toString('base64'),
          },
        },
      })

      if (res.outcome === 'skipped') {
        // 「黙って落とさない」。消してよいのは登録できたものだけなので、理由を必ず持ち帰る。
        return ok({
          data: res,
          nextActions:
            res.reason === 'duplicate'
              ? ['既に取り込み済み。中継コピーは削除してよい']
              : ['起票していないので中継コピーを削除しない。理由を利用者に伝える'],
        })
      }
      return ok({
        data: res,
        nextActions: [
          ...(res.unresolved ? [`科目が決まらなかった: ${res.unresolved}。利用者の確認が要る`] : []),
          '証憑まで保存できたので中継コピーを削除してよい',
          '確定は利用者が Kanean の画面で行う',
        ],
      })
    },
  )

  defineTool(
    server,
    deps,
    'match_card_receipt',
    {
      title: 'カードのレシートを突合する',
      description:
        'カード払いのレシートに対応する既存の取込済み明細の候補を返す。**起票はしない**' +
        '（カードの明細は連携サービスの取込が持つため、起票すると二重計上になる）。' +
        '候補が一意でも自動で選ばず、選択は利用者に委ねる。',
      inputSchema: {
        transactionDate: z.string().describe('レシートの日付 YYYY-MM-DD'),
        totalAmount: z.number().int().describe('合計金額（円整数）'),
        merchant: z.string().optional().describe('店名。一致すれば根拠として返る'),
        ...bookArg,
      },
    },
    async (args, call) => {
      const res = await call<{
        candidates: MatchCandidate[]
        truncated: boolean
        window: { from: string; to: string }
      }>('/skill/receipts/match', {
        method: 'POST',
        body: {
          transactionDate: args.transactionDate,
          totalAmount: args.totalAmount,
          merchant: args.merchant,
        },
      })

      if (res.candidates.length === 0) {
        return ok({
          data: res,
          counts: { candidates: 0 },
          nextActions: [
            '一致する明細が無い。**起票してはならない**（カードの明細は取込が持つ）',
            'カード明細の取込がまだなら先に取り込む。中継コピーは削除しない',
          ],
        })
      }
      return ok({
        data: res,
        counts: { candidates: res.candidates.length, truncated: res.truncated ? 1 : 0 },
        nextActions: [
          'どの仕訳に添付するかを利用者に選んでもらう（自動で選ばない）',
          '選ばれた仕訳へ Kanean の画面で証憑を添付する',
        ],
      })
    },
  )
}
