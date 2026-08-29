import { describe, it, expect } from 'vitest'
import { layoutFromItems, pdfToText } from '../core/pdfText.mjs'

/**
 * pdf.js が返すのは**座標付きの断片**で、読み順にも並んでいない。
 * `-layout` 相当の行組みを作るのがここの仕事（tasks 10.2a で poppler を外した）。
 *
 * 断片の形（x/y/w）は実物の Amazon 請求書を pdf.js で読んだときの値を写している。
 */
describe('layoutFromItems', () => {
  it('読み順に並んでいない断片を、上から下・左から右へ組み直す', () => {
    // 実物は「適格請求書(y=802)」の次に「1 of 1 ページ(y=53)」が来る＝そのまま繋ぐと無意味
    const text = layoutFromItems([
      { str: '1 of 1 ページ', x: 508, y: 53, w: 58 },
      { str: '適格請求書', x: 493, y: 802, w: 71 },
      { str: '購入明細', x: 38, y: 459, w: 45 },
    ])
    expect(text.split('\n')).toEqual(['適格請求書', '購入明細', '1 of 1 ページ'])
  })

  it('同じ行の断片は x 昇順で繋ぎ、間を空ける', () => {
    const text = layoutFromItems([
      { str: '￥11,977', x: 527.2, y: 325.8, w: 30 },
      { str: '10%', x: 339.5, y: 325.8, w: 11.3 },
      { str: '￥1,089', x: 459.7, y: 325.8, w: 26.3 },
      { str: '￥10,888', x: 391.9, y: 325.8, w: 30 },
    ])
    expect(text).toMatch(/^10%\s+￥10,888\s+￥1,089\s+￥11,977$/)
  })

  it('y のわずかな違いは同じ行として扱う（添字などのズレを行に割らない）', () => {
    const text = layoutFromItems([
      { str: 'A', x: 10, y: 300, w: 5 },
      { str: 'B', x: 40, y: 301.5, w: 5 },
    ])
    expect(text.split('\n')).toHaveLength(1)
  })

  it('行が離れていれば別の行にする', () => {
    const text = layoutFromItems([
      { str: '税抜', x: 406.9, y: 346.8, w: 15 },
      { str: '小計', x: 403.2, y: 360.3, w: 15 },
    ])
    expect(text.split('\n')).toEqual(['小計', '税抜'])
  })

  it('列の隙間を埋める空白だけの断片は捨てる', () => {
    const text = layoutFromItems([
      { str: '合計', x: 301.4, y: 304, w: 15 },
      { str: ' ', x: 316.4, y: 304, w: 75.5 },
      { str: '￥11,977', x: 391.9, y: 304, w: 30 },
    ])
    expect(text).toMatch(/^合計\s+￥11,977$/)
    expect(text).not.toMatch(/\n/)
  })

  it('断片が無ければ空文字（推測で作らない）', () => {
    expect(layoutFromItems([])).toBe('')
  })
})

describe('pdfToText', () => {
  it('壊れた PDF は投げる（黙って空文字にしない）', async () => {
    await expect(pdfToText(Buffer.from('これは PDF ではない'))).rejects.toThrow()
  })
})
