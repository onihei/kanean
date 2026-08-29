import type { Context } from 'hono'
import { HTTPException } from 'hono/http-exception'
import type { z } from 'zod'
import { JobConflictError, JobNotFoundError } from '../acquisition/jobs.js'
import { NoSuspenseAccountError } from '../acquisition/classify.js'
import { CrawlerUnavailableError } from '../acquisition/crawler.js'
import { NoOpenFiscalYearError, UnknownSourceError } from '../acquisition/range.js'
import { PolicyTooLargeError } from '../acquisition/policy.js'
import { CalibrationRejected } from '../acquisition/calibration.js'

/**
 * /api のエラー集約（issue #115）。
 *
 * 同型の per-route try-catch（`catch { return c.json({error: msg}, 400) }` ×約70）を
 * root app の onError へ一元化する。封筒は従来どおり flat な `{error: string}`
 * （web/src/api.ts:4 が期待する形。ec/acquisition のネスト形式と混ぜない）。
 */

/** ドメイン層が HTTP ステータスを明示して投げるための基底（型付きドメインエラー）。 */
export class DomainError extends Error {
  constructor(
    message: string,
    readonly status: 400 | 404 | 409 = 400,
  ) {
    super(message)
    this.name = 'DomainError'
  }
}

/** 対象が存在しない（onError で 404 になる）。「見つかりません」系の throw を型で分類する受け皿。 */
export class NotFoundError extends DomainError {
  constructor(message: string) {
    super(message, 404)
    this.name = 'NotFoundError'
  }
}

/**
 * root app に登録する onError（`route()` マウントのサブアプリでは効かないため必ず root）。
 *
 * Phase 1（現状互換）: 素の Error は per-route catch と同じ「400 ＋ message」。
 * throw 側の DomainError 化が進んだら「素の Error → 500」へフリップする（issue #115 Phase 2）。
 */
export function apiErrorHandler(err: Error, c: Context): Response {
  // Hono 組込（bodyLimit の 413 等）は自身の応答をそのまま通す。
  if (err instanceof HTTPException) return err.getResponse()
  if (err instanceof DomainError) return c.json({ error: err.message }, err.status)
  return c.json({ error: err.message }, 400)
}

/** zod 失敗の共通整形（ec / acquisition のネスト封筒。逐語重複していたものを一本化）。 */
export function validationError(err: z.ZodError) {
  return {
    error: {
      code: 'validation_error',
      message: '入力が不正です',
      details: err.issues.map((i) => ({ path: i.path.join('.'), issue: i.message })),
    },
  }
}

export type Handled = {
  status: 400 | 404 | 409 | 503
  body: { error: { code: string; message: string; details?: unknown } }
}

/**
 * 想定済みのドメイン失敗を、人にも AI にも次の一手が分かる形へ寄せる（クラス→status の一元表）。
 * http/acquisition.ts から昇格（issue #115。B2 が提案していた一元マップの実体）。
 */
export function toHandled(e: unknown): Handled | null {
  if (e instanceof JobConflictError)
    return { status: 409, body: { error: { code: e.code, message: e.message, details: e.job } } }
  if (e instanceof JobNotFoundError) return { status: 404, body: { error: { code: e.code, message: e.message } } }
  if (e instanceof PolicyTooLargeError)
    return { status: 400, body: { error: { code: e.code, message: e.message } } }
  if (e instanceof NoSuspenseAccountError)
    return { status: 409, body: { error: { code: e.code, message: e.message } } }
  if (e instanceof CrawlerUnavailableError)
    return { status: 503, body: { error: { code: e.code, message: e.message } } }
  if (e instanceof NoOpenFiscalYearError || e instanceof UnknownSourceError)
    return { status: 409, body: { error: { code: e.code, message: e.message } } }
  if (e instanceof CalibrationRejected)
    return { status: 400, body: { error: { code: 'calibration_rejected', message: e.message, details: e.reasons } } }
  return null
}
