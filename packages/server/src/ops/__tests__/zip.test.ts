import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { createZip, writeZip, crc32, openZip, ZipFormatError } from '../zip.js'
import { readZip, crc32Reference } from './zipTestUtil.js'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'kanean-zip-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

/** unzip コマンドがあれば -t（全エントリ CRC 検査）を実行。無ければ null（テスト側で skip）。 */
function unzipTest(zipPath: string): { status: number | null; output: string } | null {
  const r = spawnSync('unzip', ['-t', zipPath], { encoding: 'utf8' })
  if (r.error) return null // コマンド不在（ENOENT）等
  return { status: r.status, output: `${r.stdout}\n${r.stderr}` }
}

describe('crc32', () => {
  it('既知ベクタ（"123456789" → 0xCBF43926）と参照実装に一致する', () => {
    const v = Buffer.from('123456789')
    expect(crc32(v)).toBe(0xcbf43926)
    expect(crc32(v)).toBe(crc32Reference(v))
    const rand = Buffer.from(Array.from({ length: 999 }, (_, i) => (i * 7919) % 256))
    expect(crc32(rand)).toBe(crc32Reference(rand))
    expect(crc32(Buffer.alloc(0))).toBe(0)
  })
})

describe('createZip（STORE・UTF-8名・CRC-32）', () => {
  it('生成 zip を自前リーダで走査でき、名前・内容・CRC が一致する（日本語名含む）', () => {
    const a = Buffer.from('hello zip')
    const b = Buffer.from('請求書の内容です。日本語テキスト🧾')
    const zip = createZip([
      { name: 'a.txt', data: a, mtime: new Date('2026-07-07T12:34:56') },
      { name: '証憑/領収書（コーヒー）.txt', data: b },
    ])

    const entries = readZip(zip)
    expect(entries.map((e) => e.name)).toEqual(['a.txt', '証憑/領収書（コーヒー）.txt'])
    expect(entries[0].data.equals(a)).toBe(true)
    expect(entries[1].data.equals(b)).toBe(true)
    for (const e of entries) {
      expect(e.method).toBe(0) // STORE
      expect(e.flags & 0x0800).toBe(0x0800) // UTF-8 ファイル名フラグ（bit11）
      expect(e.crc).toBe(crc32Reference(e.data)) // 独立実装で CRC 検証
    }
  })

  it('システムの unzip -t でも整合する（コマンド不在時は skip）', () => {
    const zipPath = path.join(tmp, 'sys.zip')
    fs.writeFileSync(
      zipPath,
      createZip([
        { name: 'dir/nested/file.bin', data: Buffer.from([0, 1, 2, 253, 254, 255]) },
        { name: '日本語ファイル名.txt', data: Buffer.from('中身') },
      ]),
    )
    const r = unzipTest(zipPath)
    if (!r) return // unzip が無い環境では検証をスキップ
    expect(r.status, r.output).toBe(0)
    expect(r.output).toContain('No errors detected')
  })

  it('不正なエントリ名（空・絶対パス・../・バックスラッシュ）は明示エラー', () => {
    const data = Buffer.from('x')
    expect(() => createZip([{ name: '', data }])).toThrow(/空/)
    expect(() => createZip([{ name: '/abs.txt', data }])).toThrow(/不正/)
    expect(() => createZip([{ name: 'a/../b.txt', data }])).toThrow(/パス脱出/)
    expect(() => createZip([{ name: 'a\\b.txt', data }])).toThrow(/不正/)
  })

  it('65535 エントリ超は明示エラー（ZIP64 非対応）', () => {
    const entries = Array.from({ length: 65536 }, (_, i) => ({
      name: `e${i}`,
      data: Buffer.alloc(0),
    }))
    expect(() => createZip(entries)).toThrow(/65535/)
  })
})

describe('writeZip（ファイル逐次書き出し・パス指定エントリ）', () => {
  it('パス指定エントリを書き込み時に読み、fileCount/byteSize が実ファイルと一致する', () => {
    const srcPath = path.join(tmp, 'source.dat')
    const content = Buffer.from('ファイルパスから読むエントリ')
    fs.writeFileSync(srcPath, content)

    const zipPath = path.join(tmp, 'out.zip')
    const r = writeZip(zipPath, [
      { name: 'from-path.dat', data: srcPath },
      { name: 'from-buffer.txt', data: Buffer.from('メモリから') },
    ])
    expect(r.fileCount).toBe(2)
    expect(r.byteSize).toBe(fs.statSync(zipPath).size)

    const entries = readZip(fs.readFileSync(zipPath))
    expect(entries.map((e) => e.name)).toEqual(['from-path.dat', 'from-buffer.txt'])
    expect(entries[0].data.equals(content)).toBe(true)
    expect(entries[0].crc).toBe(crc32Reference(content))

    const sys = unzipTest(zipPath)
    if (sys) expect(sys.status, sys.output).toBe(0)
  })

  it('途中失敗（参照ファイル不在）では書きかけの zip を残さない', () => {
    const zipPath = path.join(tmp, 'broken.zip')
    expect(() =>
      writeZip(zipPath, [
        { name: 'ok.txt', data: Buffer.from('ok') },
        { name: 'missing.txt', data: path.join(tmp, 'no-such-file') },
      ]),
    ).toThrow()
    expect(fs.existsSync(zipPath)).toBe(false)
  })
})

describe('openZip（取り込み側のリーダ）', () => {
  /** entries を zip としてファイルに書き、そのパスを返す。 */
  function writeFixture(name: string, entries: Parameters<typeof createZip>[0]): string {
    const p = path.join(tmp, name)
    fs.writeFileSync(p, createZip(entries))
    return p
  }

  it('自分が書いた zip を読み戻せる（往復）', () => {
    const big = Buffer.alloc(200_000, 0x5a)
    const zipPath = writeFixture('rt.zip', [
      { name: 'manifest.json', data: Buffer.from('{"a":1}') },
      { name: 'books/x/attachments/請求書.txt', data: Buffer.from('日本語の中身') },
      { name: 'books/x.sqlite', data: big },
    ])

    const zip = openZip(zipPath)
    expect(zip.entries.map((e) => e.name)).toEqual([
      'manifest.json',
      'books/x/attachments/請求書.txt',
      'books/x.sqlite',
    ])
    expect(zip.readEntry(zip.entry('manifest.json')!, 1024).toString('utf8')).toBe('{"a":1}')
    expect(zip.under('books/x/attachments/').map((e) => e.name)).toEqual([
      'books/x/attachments/請求書.txt',
    ])

    // 大きいエントリはストリームで展開する（メモリに全載せしない経路）。
    const out = path.join(tmp, 'out', 'db.sqlite')
    return zip.extractTo(zip.entry('books/x.sqlite')!, out).then(() => {
      expect(fs.readFileSync(out).equals(big)).toBe(true)
    })
  })

  it('DEFLATE で圧縮された zip も読める（解凍→再 zip された書庫を受ける）', async () => {
    // ライタは STORE しか書かないので、外部ツール（zip コマンド）で圧縮版を作る。
    const src = path.join(tmp, 'src')
    fs.mkdirSync(src, { recursive: true })
    const body = Buffer.from('a'.repeat(50_000)) // よく縮む＝確実に DEFLATE が選ばれる
    fs.writeFileSync(path.join(src, 'manifest.json'), body)
    const zipPath = path.join(tmp, 'deflated.zip')
    const r = spawnSync('zip', ['-r', zipPath, '.'], { cwd: src, encoding: 'utf8' })
    if (r.error || r.status !== 0) return // zip コマンド不在の環境では skip

    const zip = openZip(zipPath)
    const entry = zip.entry('manifest.json')!
    expect(entry.method).toBe(8)
    expect(entry.compressedSize).toBeLessThan(entry.size)
    expect(zip.readEntry(entry, 1024 * 1024).equals(body)).toBe(true)

    const out = path.join(tmp, 'inflated.bin')
    await zip.extractTo(entry, out)
    expect(fs.readFileSync(out).equals(body)).toBe(true)
  })

  it('CRC-32 が合わないエントリは展開せず、書きかけを残さない', async () => {
    const zipPath = writeFixture('corrupt.zip', [{ name: 'data.bin', data: Buffer.from('original') }])
    // データ本体の1バイトを書き換える（CRC はセントラルディレクトリの元の値のまま）。
    const buf = fs.readFileSync(zipPath)
    buf[buf.indexOf(Buffer.from('original'))] = 0x58
    fs.writeFileSync(zipPath, buf)

    const zip = openZip(zipPath)
    const entry = zip.entry('data.bin')!
    const out = path.join(tmp, 'out.bin')
    await expect(zip.extractTo(entry, out)).rejects.toThrow(/CRC-32/)
    expect(fs.existsSync(out)).toBe(false)
    expect(() => zip.readEntry(entry, 1024)).toThrow(/CRC-32/)
  })

  it('パス脱出を含むエントリ名の zip は開かない', () => {
    // ライタは assertSafeName で拒否するため、名前を後から書き換えて仕込む。
    const zipPath = writeFixture('evil.zip', [{ name: 'aa/bb.txt', data: Buffer.from('x') }])
    const buf = fs.readFileSync(zipPath)
    // ローカルヘッダ・セントラルディレクトリ両方の名前を '../bb.txt' に置換（同じ長さ）。
    let at = 0
    for (;;) {
      const i = buf.indexOf('aa/bb.txt', at, 'utf8')
      if (i < 0) break
      buf.write('../bb.txt', i, 'utf8')
      at = i + 9
    }
    fs.writeFileSync(zipPath, buf)

    expect(() => openZip(zipPath)).toThrow(/パス脱出/)
  })

  it('zip でないファイル・空ファイルは明示エラーにする', () => {
    const notZip = path.join(tmp, 'not.zip')
    fs.writeFileSync(notZip, Buffer.alloc(1000, 0x41))
    expect(() => openZip(notZip)).toThrow(ZipFormatError)
    expect(() => openZip(notZip)).toThrow(/EOCD/)

    const empty = path.join(tmp, 'empty.zip')
    fs.writeFileSync(empty, Buffer.alloc(0))
    expect(() => openZip(empty)).toThrow(/小さすぎます/)
  })

  it('ディレクトリエントリは目録に載せない', () => {
    const src = path.join(tmp, 'dirsrc')
    fs.mkdirSync(path.join(src, 'books'), { recursive: true })
    fs.writeFileSync(path.join(src, 'books', 'a.txt'), 'x')
    const zipPath = path.join(tmp, 'withdirs.zip')
    const r = spawnSync('zip', ['-r', zipPath, '.'], { cwd: src, encoding: 'utf8' })
    if (r.error || r.status !== 0) return // zip コマンド不在の環境では skip

    const zip = openZip(zipPath)
    expect(zip.entries.every((e) => !e.name.endsWith('/'))).toBe(true)
    expect(zip.entries.map((e) => e.name)).toContain('books/a.txt')
  })
})
