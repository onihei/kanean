import { describe, it, expect } from 'vitest'
import { parseCsv, toCsv } from '../csv.js'

describe('toCsv（RFC4180）', () => {
  it('単純な行は CRLF 区切りでそのまま出力', () => {
    expect(toCsv([['a', 'b'], ['c', 'd']])).toBe('a,b\r\nc,d')
  })

  it('カンマ/改行/ダブルクォートを含むフィールドは囲み、" は "" にエスケープ', () => {
    expect(toCsv([['x,y', 'a"b', 'line1\nline2', 'plain']])).toBe('"x,y","a""b","line1\nline2",plain')
  })

  it('number はそのまま、null/undefined は空文字', () => {
    expect(toCsv([[1, 0, -5, null, undefined, '']])).toBe('1,0,-5,,,')
  })
})

describe('parseCsv（RFC4180）', () => {
  it('クォート囲み・クォート内カンマ/改行・"" エスケープ・CRLF を扱う', () => {
    expect(parseCsv('a,b\r\n"x,y","a""b"\r\n"line1\nline2",plain')).toEqual([
      ['a', 'b'],
      ['x,y', 'a"b'],
      ['line1\nline2', 'plain'],
    ])
  })

  it('先頭 BOM を除去し、最終行の改行なしも1行として読む', () => {
    expect(parseCsv('\ufeffa,b\nc,d')).toEqual([['a', 'b'], ['c', 'd']])
  })

  it('toCsv とのラウンドトリップ（string[][] のみ・BOM は非対称なので片方向）', () => {
    // toCsv は BOM を付けない仕様・parseCsv は BOM を除去する仕様。null→'' 正規化があるため
    // ラウンドトリップが成立するのは string[][] に限る（issue #138 の注意）。
    const rows = [
      ['日付', '摘要', '金額'],
      ['2026/5/1', 'x,y', '1,000'],
      ['2026/5/2', 'a"b', 'line1\nline2'],
    ]
    expect(parseCsv('\ufeff' + toCsv(rows))).toEqual(rows)
    expect(parseCsv(toCsv(rows))).toEqual(rows)
  })
})
