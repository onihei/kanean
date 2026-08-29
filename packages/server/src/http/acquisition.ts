import { Hono } from 'hono'
import type { AcquisitionTarget, AcquisitionTargets } from '@kanean/shared'
import { z } from 'zod'
import type { DbRouter } from '../db/router.js'
import type { BookVariables } from '../books/middleware.js'
import { getCrawler } from '../acquisition/crawler.js'
import {
  abortJob,
  getJob,
  listJobViews,
  startJob,
} from '../acquisition/jobs.js'
import {
  applyClassification,
  listUnclassified,
  type ClassifyResult,
  type UnclassifiedResult,
} from '../acquisition/classify.js'
import { listTargets } from '../acquisition/range.js'
import {
  getCalibration,
  resetCalibration,
  updateCalibration,
} from '../acquisition/calibration.js'
import { getDiagnostic } from '../acquisition/diagnostics.js'
import { getPolicy, resetPolicy, setPolicy } from '../acquisition/policy.js'
import { getWatermark } from '../acquisition/watermark.js'
import { toHandled, validationError } from './errors.js'
import { dataDir } from '../config.js'
import { getOpenFiscalYear } from '../db/lookups.js'
import type { DataDb } from '../db/router.js'

/**
 * アプリ内取込の API（acquisition spec）。UI からも MCP ブリッジからも同じ入口を使う
 * （どちらから開始しても辿る状態と最終結果は一致する）。
 *
 * ここに **draft を確定する口は無い**。承認は人が UI で行う（skill-import spec の原則）。
 */

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD 形式')

const startSchema = z.object({
  source: z.string().min(1).max(200),
  since: isoDate.optional(),
  until: isoDate.optional(),
  evidence: z.boolean().optional(),
})

const answersSchema = z.object({
  source: z.string().max(200).optional(),
  answers: z
    .array(
      z.object({
        id: z.string().min(1).max(64),
        proposedAccount: z.string().min(1).max(200),
        reason: z.string().max(2000).optional(),
        confidence: z.enum(['high', 'medium', 'low']).optional(),
        policyRef: z.string().max(200).optional(),
      }),
    )
    .max(5000),
})

const policySchema = z.object({ text: z.string().max(40_000) })

// validationError / toHandled（クラス→status の一元表）は http/errors.ts へ昇格（issue #115）。

export function acquisitionRoutes(router: DbRouter): Hono<{ Variables: BookVariables }> {
  const app = new Hono<{ Variables: BookVariables }>()

  // fn の戻り値型 T を保持する。unknown に消すと「年度なし分岐だけフィールドが欠ける」類の
  // 応答契約のズレ（issue #142 の policy 欠落）を tsc が検出できない。
  const guard = async <T extends object>(
    c: { json: (b: unknown, s?: number) => Response },
    fn: () => T,
  ) => {
    try {
      return c.json(fn())
    } catch (e) {
      const handled = toHandled(e)
      if (handled) return c.json(handled.body, handled.status)
      console.error('[acquisition] unexpected error', e)
      return c.json({ error: { code: 'internal', message: 'internal error' } }, 500)
    }
  }

  // 巡回できる対象と、次に取りに行く範囲
  app.get('/acquisition/targets', (c) => {
    const bookId = c.get('bookId')
    const db = router.bookDb(bookId)
    const { openFiscalYear, evidenceCapture, targets } = listTargets(db)
    // wire 形はここで完成する。shared の型で注釈し、フィールドのドリフトを型検査で止める（issue #128）
    const payload: AcquisitionTargets = {
      crawlerAvailable: getCrawler().available,
      openFiscalYear,
      evidenceCapture,
      targets: targets.map((t): AcquisitionTarget => ({
        ...t,
        continuousUntil: getWatermark(dataDir(), bookId, t.source),
        hasCrawler: getCalibrationSafe(t.source) !== null,
      })),
    }
    return c.json(payload)
  })

  app.get('/acquisition/jobs', (c) => c.json({ jobs: listJobViews(c.get('bookId')) }))

  app.post('/acquisition/jobs', async (c) => {
    const parsed = startSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(validationError(parsed.error), 400)
    const { source, ...requested } = parsed.data
    return guard(c, () => startJob(router, c.get('bookId'), source, requested))
  })

  app.get('/acquisition/jobs/:jobId', (c) => guard(c, () => getJob(c.req.param('jobId'))))

  app.post('/acquisition/jobs/:jobId/abort', (c) => guard(c, () => abortJob(c.req.param('jobId'))))

  // 未確定の分類対象（品名・摘要とその識別子だけ）。取込経路によらず同じ口。
  app.get('/acquisition/unclassified', (c) =>
    guard<UnclassifiedResult>(c, () => {
      const db = router.bookDb(c.get('bookId'))
      const fy = openFiscalYear(db)
      // 年度が無くても policy は返す（MCP は「policy に従って分類する」前提で読む）。
      if (!fy) return { items: [], hints: [], policy: getPolicy().text, total: 0 }
      const limit = Number(c.req.query('limit') ?? '') || undefined
      return listUnclassified(db, fy.id, { source: c.req.query('source'), limit })
    }),
  )

  // 未確定の draft に科目を当てる（確定はしない）
  app.post('/acquisition/unclassified', async (c) => {
    const parsed = answersSchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(validationError(parsed.error), 400)
    return guard<ClassifyResult>(c, () => {
      const db = router.bookDb(c.get('bookId'))
      const fy = openFiscalYear(db)
      if (!fy) return { applied: 0, unmatched: parsed.data.answers.length, unknownAccounts: [], remaining: 0 }
      return applyClassification(db, fy.id, parsed.data.answers, { source: parsed.data.source })
    })
  })

  // 分類方針（AI への指示。アプリの動作は変えない）
  app.get('/acquisition/policy', (c) => guard(c, () => getPolicy()))

  app.put('/acquisition/policy', async (c) => {
    const parsed = policySchema.safeParse(await c.req.json().catch(() => null))
    if (!parsed.success) return c.json(validationError(parsed.error), 400)
    return guard(c, () => setPolicy(parsed.data.text))
  })

  app.delete('/acquisition/policy', (c) => guard(c, () => resetPolicy()))

  // 失敗の診断（較正で直る見込みがあるかの判定つき）
  app.get('/acquisition/:source/diagnostic', (c) => {
    const d = getDiagnostic(c.req.param('source'))
    return d ? c.json(d) : c.json({ error: { code: 'not_found', message: '直近の失敗診断はありません' } }, 404)
  })

  // 較正の参照・更新・復帰
  app.get('/acquisition/:source/calibration', (c) => guard(c, () => getCalibration(c.req.param('source'))))

  app.put('/acquisition/:source/calibration', async (c) => {
    const body = await c.req.json().catch(() => null)
    return guard(c, () => updateCalibration(c.req.param('source'), body))
  })

  app.delete('/acquisition/:source/calibration', (c) =>
    guard(c, () => resetCalibration(c.req.param('source'))),
  )

  return app
}

/** 開いている会計年度（無ければ未確定も存在しえない）。 */
function openFiscalYear(db: DataDb) {
  return getOpenFiscalYear(db)
}

/** 巡回手順を持っているサイトか（連携サービスとして登録されていても巡回できるとは限らない）。 */
function getCalibrationSafe(source: string): unknown {
  try {
    return getCalibration(source)
  } catch {
    return null
  }
}
