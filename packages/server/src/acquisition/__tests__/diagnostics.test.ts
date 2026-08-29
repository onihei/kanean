import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { classifyDiagnostic, getDiagnostic } from '../diagnostics.js'
import { dataDirDiagnosticsSink } from '@kanean/acquisition'
import { deleteJob, listJobs, purgeJobs, saveJob, type PersistedJob } from '../store.js'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-diag-'))
  process.env.DATA_DIR = tmp
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('「較正では直らない改変」の判別', () => {
  it('要素を指し損ねた失敗は較正で直る見込みがある', () => {
    const r = classifyDiagnostic({
      message: '明細テーブルが見つからない（ヘッダ: 日付/残高）',
      hint: 'SEL.tableHeaders/col* を実ヘッダに較正する',
    })
    expect(r.calibratable).toBe(true)
    expect(r.suggestedKeys).toContain('tableHeaders')
  })

  it('待てなかった locator も較正の対象', () => {
    expect(classifyDiagnostic({ message: '要素を待てませんでした（#bt-inquiry）', hint: null }).calibratable).toBe(true)
  })

  it('検算が合わない失敗は較正では直らない', () => {
    const r = classifyDiagnostic({ message: '残高チェーン不連続 row=3', hint: '並び順を疑う' })
    expect(r.calibratable).toBe(false)
    expect(r.verdict).toContain('検算')
  })

  it('巡回の流れが変わった失敗も較正では直らない', () => {
    expect(classifyDiagnostic({ message: '照会結果を取得できず（TOPバウンスを4回再試行）', hint: null }).calibratable).toBe(false)
    expect(classifyDiagnostic({ message: 'DOM反転後も新しい順 → 表示順の前提が変わった', hint: null }).calibratable).toBe(false)
  })

  it('人の事情（ログイン未完了・中断）は失敗として扱わない', () => {
    expect(classifyDiagnostic({ message: 'ログイン待ちタイムアウト（480秒）', hint: null }).verdict).toContain('較正の問題ではない')
    expect(classifyDiagnostic({ message: '人の操作で中断された', hint: null }).verdict).toContain('失敗ではない')
  })

  it('判別できないときは、そう言う（当てずっぽうで較正へ誘導しない）', () => {
    const r = classifyDiagnostic({ message: '何かがおかしい', hint: null })
    expect(r.calibratable).toBe(false)
    expect(r.verdict).toContain('判別できない')
  })
})

describe('診断の取り出し', () => {
  it('残っていなければ null', () => {
    expect(getDiagnostic('bank_ufj')).toBeNull()
  })

  it('画面の抜粋は表・見出し・入力欄を優先する（先頭N文字だと head で埋まる）', async () => {
    const head = '<head>' + '<script>var x=1</script>'.repeat(200) + '</head>'
    await dataDirDiagnosticsSink(tmp, 'bank_ufj').dump({
      source: 'bank_ufj',
      step: 'extract-table',
      steps: ['open-login', 'extract-table'],
      message: '明細テーブルが見つからない',
      hint: 'SEL.tableHeaders を較正する',
      url: 'https://bank.example/',
      html: `<html>${head}<body><table><tr><th>取引日</th><th>残高</th></tr></table></body></html>`,
      screenshot: Buffer.from('png'),
      time: '2026-08-12T00:00:00Z',
    })

    const d = getDiagnostic('bank_ufj')!
    expect(d.step).toBe('extract-table')
    expect(d.htmlExcerpt).toContain('取引日')
    expect(d.htmlExcerpt).not.toContain('var x=1')
    expect(d.screenshotPath).toMatch(/screenshot\.png$/)
    expect(d.calibratable).toBe(true)
  })
})

describe('古い記録の掃除', () => {
  const job = (over: Partial<PersistedJob>): PersistedJob => ({
    jobId: 'j',
    bookId: 'b',
    source: 'bank_ufj',
    accountRef: 'bank_ufj-1',
    kind: 'bank',
    state: 'fetching',
    waitingFor: null,
    message: null,
    failedStep: null,
    range: { since: '2026-01-01', until: '2026-06-30' },
    rangeLimited: false,
    startedAt: '2026-08-01T00:00:00Z',
    updatedAt: '2026-08-01T00:00:00Z',
    counts: null,
    calibration: null,
    ...over,
  })

  it('終わった記録は結果を見るあいだ残る', () => {
    saveJob(tmp, job({ jobId: 'done', state: 'done', updatedAt: '2026-08-10T00:00:00Z' }))
    purgeJobs(tmp, new Date('2026-08-12T00:00:00Z')) // 2日後
    expect(listJobs(tmp).map((j) => j.jobId)).toContain('done')
  })

  it('古い記録は捨てる（会計データではないので取り直しは起きない）', () => {
    saveJob(tmp, job({ jobId: 'old', state: 'done', updatedAt: '2026-08-01T00:00:00Z' }))
    purgeJobs(tmp, new Date('2026-08-12T00:00:00Z')) // 11日後
    expect(listJobs(tmp)).toHaveLength(0)
  })

  it('進行中のまま残った記録は短命（アプリを落とせば巡回は消えている）', () => {
    saveJob(tmp, job({ jobId: 'zombie', state: 'fetching', updatedAt: '2026-08-10T00:00:00Z' }))
    purgeJobs(tmp, new Date('2026-08-12T00:00:00Z')) // 2日後
    expect(listJobs(tmp)).toHaveLength(0)
  })

  it('形が変わる前の古い記録は無いものとして扱う（会計データは入っていない）', () => {
    const dir = path.join(tmp, 'acquisition', 'jobs')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(
      path.join(dir, 'legacy.json'),
      JSON.stringify({ jobId: 'legacy', bookId: 'b', state: 'awaiting_classification', items: [] }),
    )
    expect(listJobs(tmp)).toHaveLength(0)
  })

  it('消したジョブは一覧から消える', () => {
    saveJob(tmp, job({ jobId: 'x' }))
    deleteJob(tmp, 'x')
    expect(listJobs(tmp)).toHaveLength(0)
  })
})
