import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileDiagnosticsSink, fileEvidenceStore } from '../core/fileStores.mjs'
import { dataDirDiagnosticsSink, readDiagnostic } from '../core/diagnosticsStore.mjs'
import { dataDirEvidenceStore } from '../core/evidenceStore.mjs'

/** 診断シンク・証跡ストアの実体（issue #166 で core/fileStores へ一本化）。 */

let tmp
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'acq-filestores-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('fileDiagnosticsSink', () => {
  it('screenshot.png / page.html / error.json を書く（MCP artifactsDir 契約のファイル名）', async () => {
    const dir = path.join(tmp, 'latest')
    const written = []
    const sink = fileDiagnosticsSink(dir, { onWritten: (d) => written.push(d) })
    const out = await sink.dump({ step: 'x', message: 'm', html: '<html/>', screenshot: Buffer.from('png') })
    expect(out).toBe(dir)
    expect(fs.readdirSync(dir).sort()).toEqual(['error.json', 'page.html', 'screenshot.png'])
    expect(JSON.parse(fs.readFileSync(path.join(dir, 'error.json'), 'utf8'))).toEqual({ step: 'x', message: 'm' })
    expect(written).toEqual([dir])
  })

  it('前回分を消してから書く（latest は常に直近1回分）・html/screenshot 無しは error.json のみ', async () => {
    const dir = path.join(tmp, 'latest')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'stale.txt'), 'old')
    await fileDiagnosticsSink(dir).dump({ step: 'y' })
    expect(fs.readdirSync(dir)).toEqual(['error.json'])
  })
})

describe('fileEvidenceStore', () => {
  it('enabled なら保存して絶対パスを返し、ref は保存先を指す', async () => {
    const store = fileEvidenceStore(path.join(tmp, 'ev'), true)
    const full = await store.save('249-1/inv1.pdf', Buffer.from('pdf'))
    expect(full).toBe(path.join(tmp, 'ev', '249-1/inv1.pdf'))
    expect(fs.existsSync(full)).toBe(true)
    expect(store.ref('249-1/inv1.pdf', 'fb')).toBe(full)
  })

  it('無効なら保存せず null・ref は fallback', async () => {
    const store = fileEvidenceStore(path.join(tmp, 'ev'), false)
    expect(await store.save('x.png', Buffer.from('p'))).toBeNull()
    expect(fs.existsSync(path.join(tmp, 'ev'))).toBe(false)
    expect(store.ref('x.png', 'https://example')).toBe('https://example')
  })
})

describe('dataDir 系ラッパ（$DATA_DIR/acquisition/ 配下へ委譲）', () => {
  it('診断はダンプ後に readDiagnostic で読み戻せる', async () => {
    const sink = dataDirDiagnosticsSink(tmp, 'bank_ufj')
    await sink.dump({ step: 's', message: 'm', html: '<table>t</table>' })
    const d = readDiagnostic(tmp, 'bank_ufj')
    expect(d.step).toBe('s')
    expect(d.artifactsDir).toBe(path.join(tmp, 'acquisition', 'diagnostics', 'bank_ufj', 'latest'))
    expect(d.htmlExcerpt).toContain('<table>')
  })

  it('証跡は acquisition/evidence/<key>/ 配下', async () => {
    const store = dataDirEvidenceStore(tmp, 'amazon', true)
    const full = await store.save('o/1.png', Buffer.from('p'))
    expect(full).toBe(path.join(tmp, 'acquisition', 'evidence', 'amazon', 'o/1.png'))
  })
})
