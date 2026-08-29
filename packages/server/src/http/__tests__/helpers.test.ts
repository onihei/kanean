import { describe, it, expect } from 'vitest'
import iconv from 'iconv-lite'
import { parseEntriesFilter, lossyShiftJisChars, rfc5987, csvResponse, pdfResponse } from '../helpers.js'

/** http/helpers のモジュールレベル純関数の単体テスト（issue #127 = B15）。 */

describe('parseEntriesFilter', () => {
  const q = (map: Record<string, string>) => (k: string) => map[k]

  it('既定は confirmed・他キー null/undefined', () => {
    expect(parseEntriesFilter(q({}))).toEqual({ status: 'confirmed', from: null, to: null, q: null, accountId: null, limit: undefined })
  })

  it('status は all/draft/confirmed のみ許可・不正値は confirmed に倒す', () => {
    expect(parseEntriesFilter(q({ status: 'all' })).status).toBe('all')
    expect(parseEntriesFilter(q({ status: 'draft' })).status).toBe('draft')
    expect(parseEntriesFilter(q({ status: 'evil' })).status).toBe('confirmed')
  })

  it('from/to/q は素通し、accountId/limit は数値化', () => {
    const f = parseEntriesFilter(q({ from: '2026-01-01', to: '2026-12-31', q: '入金', accountId: '7', limit: '50' }))
    expect(f).toEqual({ status: 'confirmed', from: '2026-01-01', to: '2026-12-31', q: '入金', accountId: 7, limit: 50 })
  })
})

describe('lossyShiftJisChars', () => {
  it('Shift_JIS に無い文字だけを重複なく列挙する', () => {
    expect(lossyShiftJisChars('電気代 5月')).toEqual([])
    expect(lossyShiftJisChars('絵文字😀と😀ダッシュ—')).toEqual(expect.arrayContaining(['😀', '—']))
    expect(lossyShiftJisChars('😀😀').length).toBe(1)
  })

  it("'?' 自体は正当にマップされるので欠落扱いしない", () => {
    expect(lossyShiftJisChars('何か?')).toEqual([])
  })

  it('先頭30種で打ち切る', () => {
    const many = Array.from({ length: 40 }, (_, i) => String.fromCodePoint(0x1f600 + i)).join('')
    expect(lossyShiftJisChars(many).length).toBe(30)
  })
})

describe('rfc5987', () => {
  it("encodeURIComponent が残す ' ( ) * ! も pct-encode する", () => {
    expect(rfc5987("a'b(c)d*e!f")).toBe('a%27b%28c%29d%2Ae%21f')
    expect(rfc5987('仕訳帳.csv')).toBe(encodeURIComponent('仕訳帳.csv'))
  })
})

/** ヘッダ収集つきの最小 Context スタブ（csvResponse/pdfResponse は header/body しか触らない）。 */
function ctxStub() {
  const headers = new Map<string, string>()
  return {
    headers,
    c: {
      header: (k: string, v: string) => void headers.set(k, v),
      body: (b: string | ArrayBuffer) => new Response(b),
    },
  }
}

describe('csvResponse', () => {
  it('UTF-8 は BOM 付き・charset=utf-8・attachment の filename*', async () => {
    const { headers, c } = ctxStub()
    const res = csvResponse(c, '仕訳帳.csv', 'a,b\r\n1,2')
    expect(headers.get('Content-Type')).toBe('text/csv; charset=utf-8')
    expect(headers.get('Content-Disposition')).toBe(`attachment; filename*=UTF-8''${rfc5987('仕訳帳.csv')}`)
    // Response.text() は BOM を剥がすため、バイト列で BOM（EF BB BF）を確認する。
    const bytes = new Uint8Array(await res.arrayBuffer())
    expect([...bytes.slice(0, 3)]).toEqual([0xef, 0xbb, 0xbf])
    expect(new TextDecoder().decode(bytes.slice(3))).toBe('a,b\r\n1,2')
  })

  it('Shift_JIS は BOM なし・欠落文字を X-Export-Lossy-Chars で通知（黙って文字化けさせない）', () => {
    const { headers, c } = ctxStub()
    csvResponse(c, '仕訳.csv', '摘要😀', 'shift_jis')
    expect(headers.get('Content-Type')).toBe('text/csv; charset=Shift_JIS')
    expect(decodeURIComponent(headers.get('X-Export-Lossy-Chars')!)).toBe('😀')
  })

  it('Shift_JIS で全文字が表現可能ならヘッダを付けない', () => {
    const { headers, c } = ctxStub()
    csvResponse(c, 'x.csv', '電気代,5000', 'shift_jis')
    expect(headers.has('X-Export-Lossy-Chars')).toBe(false)
  })

  it('Shift_JIS 本文は実際に Shift_JIS バイト列', async () => {
    const { c } = ctxStub()
    const res = csvResponse(c, 'x.csv', '電気代', 'shift_jis')
    const buf = Buffer.from(await res.arrayBuffer())
    expect(iconv.decode(buf, 'Shift_JIS')).toBe('電気代')
  })
})

describe('pdfResponse', () => {
  it('inline 表示・application/pdf・バイト列そのまま', async () => {
    const { headers, c } = ctxStub()
    const bytes = new Uint8Array([0x25, 0x50, 0x44, 0x46]) // %PDF
    const res = pdfResponse(c, '確定申告書.pdf', bytes)
    expect(headers.get('Content-Type')).toBe('application/pdf')
    expect(headers.get('Content-Disposition')).toBe(`inline; filename*=UTF-8''${rfc5987('確定申告書.pdf')}`)
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(bytes)
  })
})
