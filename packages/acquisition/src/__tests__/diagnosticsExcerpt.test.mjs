import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { dataDirDiagnosticsSink, readDiagnostic } from '../core/diagnosticsStore.mjs'

/**
 * readDiagnostic の HTML 抜粋規則（issue #174）。
 * これは MCP の get_import_diagnostic が返す中身そのもの＝抜粋が壊れると較正ヒントが役に立たない。
 * 「表・見出し・入力欄を優先」「先頭 N 文字ではない」「上限で打ち切る」を固定する。
 */

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-excerpt-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function readBack(html, opts) {
  await dataDirDiagnosticsSink(tmp, 'bank_ufj').dump({ step: 's', message: 'm', html })
  return readDiagnostic(tmp, 'bank_ufj', opts)
}

describe('readDiagnostic の HTML 抜粋（excerptAroundTables）', () => {
  it('先頭が <head> のスクリプトで埋まっていても、表・見出し・入力欄を優先して抜く', async () => {
    const html =
      '<head><script>' + 'x'.repeat(5000) + '</script></head>' +
      '<body><h2>入出金明細</h2><table><tr><th>日付</th><th>残高</th></tr></table>' +
      '<input id="tx-start-date" type="date"></body>'
    const d = await readBack(html)
    expect(d.htmlExcerpt).toContain('<table>')
    expect(d.htmlExcerpt).toContain('入出金明細')
    expect(d.htmlExcerpt).toContain('tx-start-date')
    expect(d.htmlExcerpt).not.toContain('xxxxx') // 先頭Nバイト方式ならこれで埋まる
  })

  it('上限を超えたら打ち切り、省略したことを明示する', async () => {
    const html = '<table>' + '<tr><td>行</td></tr>'.repeat(500) + '</table>'
    const d = await readBack(html, { htmlExcerptChars: 300 })
    expect(d.htmlExcerpt.length).toBeLessThan(400)
    expect(d.htmlExcerpt).toContain('…（省略）')
  })

  it('優先パターンが1つも無ければ全文（上限内）へフォールバックする', async () => {
    const d = await readBack('<div>プレーンな失敗画面</div>')
    expect(d.htmlExcerpt).toContain('プレーンな失敗画面')
  })

  it('html 無しの診断は htmlExcerpt=null・htmlBytes=0', async () => {
    await dataDirDiagnosticsSink(tmp, 'bank_ufj').dump({ step: 's', message: 'm' })
    const d = readDiagnostic(tmp, 'bank_ufj')
    expect(d.htmlExcerpt).toBeNull()
    expect(d.htmlBytes).toBe(0)
    expect(d.screenshotPath).toBeNull()
  })

  it('診断が無ければ null（未失敗＝正常）', () => {
    expect(readDiagnostic(tmp, 'amazon')).toBeNull()
  })
})
