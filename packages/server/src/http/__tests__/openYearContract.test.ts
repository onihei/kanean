import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createApp } from '../../app.js'

/**
 * open 年度なしのレスポンス契約（issue #119 = B7）。契約は2つ**だけ**:
 * - 更新系・ファイル出力系: 400 ＋ {error:'開いている会計年度がありません'}（文言はこの1本）
 * - JSON 参照系: 200 ＋ null/[]（withOpenYearOrNull の意図的契約）
 * 旧文言（「会計年度がありません」「会計年度が未設定です。…」）が復活しないことをここで固定する。
 */

const MSG = '開いている会計年度がありません'

describe('open 年度なしの契約', () => {
  let tmp: string
  beforeEach(() => {
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-openyear-'))
    process.env.DATA_DIR = tmp
  })
  afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

  it('更新系・ファイル出力系は 400 ＋ 統一文言', async () => {
    const { app } = createApp()
    const post = (p: string, body: unknown) =>
      app.request(p, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })

    const cases = [
      await post('/api/entries', { lines: [] }), // 手入力起票
      await post('/api/closing/rollover', { confirm: true }), // 年度繰越
      await post('/api/fixed-assets/post-depreciation', {}), // 償却起票
      await app.request('/api/reports/pl.csv'), // 帳票 CSV
      await app.request('/api/tax-return/income-tax.pdf'), // 様式 PDF
      await app.request('/api/reports/comparison/pl.csv'), // 前期比較 CSV
    ]
    for (const res of cases) {
      expect(res.status).toBe(400)
      expect(await res.json()).toEqual({ error: MSG })
    }
  })

  it('JSON 参照系は 200 ＋ null/[]（withOpenYearOrNull の契約）', async () => {
    const { app } = createApp()
    const pl = await app.request('/api/reports/pl')
    expect(pl.status).toBe(200)
    expect(await pl.json()).toEqual({ report: null })

    const settings = await app.request('/api/proration-settings')
    expect(settings.status).toBe(200)
    expect(await settings.json()).toEqual({ settings: [] })
  })
})
