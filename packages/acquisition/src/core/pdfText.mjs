// 適格請求書 PDF のテキスト化（pdf.js）。Amazon の商品別純額は PDF が一次ソースなので、
// どちらの殻でも同じ抽出結果になるように実装を1つに寄せる。
//
// **アプリ外のバイナリに依存しない**のが要件（tasks 10.2a）。以前は poppler の `pdftotext -layout` を
// 子プロセスで呼んでいたが、それだと DMG から入れた人に `brew install poppler` を強いることになり、
// 「終了後に何も残さない・自己完結」という配布形態と噛み合わなかった。pdf.js は Apache-2.0 で、
// 同梱に署名・再パスの手当ても要らない。
//
// pdf.js が返すのは**座標付きの断片**で、読み順にも並んでいない（請求書の右下の断片が2番目に来る）。
// `-layout` 相当の行組みは `layoutFromItems` で作る。ここが唯一の作り込みなので純関数に切り出し、
// pdf.js 抜きで単体テストできるようにしてある。
import path from 'node:path'
import { createRequire } from 'node:module'
import { pathToFileURL } from 'node:url'

/** 同じ行とみなす y の許容差（pt）。行間より十分小さく、添字のズレより大きい。 */
const Y_TOL = 3
/** 空白1つ分の見当（pt）。桁揃えは読みやすさのためで、パーサ側は `\s+` で見るので厳密でなくてよい。 */
const CHAR_W = 6

/**
 * 座標付き断片から `pdftotext -layout` 相当の行を組む（純関数）。
 * @param {{str:string, x:number, y:number, w?:number}[]} items
 * @returns {string}
 */
export function layoutFromItems(items) {
  const rows = []
  for (const it of items) {
    if (typeof it.str !== 'string' || it.str.trim() === '') continue // 列の隙間を埋める空白断片は捨てる
    const row = rows.find((r) => Math.abs(r.y - it.y) <= Y_TOL)
    if (row) row.parts.push(it)
    else rows.push({ y: it.y, parts: [it] })
  }
  rows.sort((a, b) => b.y - a.y) // 上から下へ
  return rows
    .map((r) => {
      r.parts.sort((a, b) => a.x - b.x)
      let line = ''
      let cursor = r.parts[0].x
      for (const part of r.parts) {
        if (line !== '') line += ' '.repeat(Math.max(1, Math.round((part.x - cursor) / CHAR_W)))
        line += part.str
        cursor = part.x + (part.w ?? 0)
      }
      return line
    })
    .join('\n')
}

/** pdf.js の読み込みは重いので、実際に PDF を読むときまで遅らせる。 */
let pdfjsPromise = null
function loadPdfjs() {
  pdfjsPromise ??= (async () => {
    const require = createRequire(import.meta.url)
    const root = path.dirname(require.resolve('pdfjs-dist/package.json'))
    const lib = await import(pathToFileURL(path.join(root, 'legacy/build/pdf.mjs')).href)
    return { lib, root }
  })()
  return pdfjsPromise
}

/**
 * PDF をテキストへ。**非同期**（pdf.js の制約。以前の `execFileSync` 版は同期だった）。
 * @param {Buffer|Uint8Array} buffer
 * @returns {Promise<string>}
 */
export async function pdfToText(buffer) {
  const { lib, root } = await loadPdfjs()
  const task = lib.getDocument({
    data: new Uint8Array(buffer), // pdf.js は渡された領域を掴むので複製して渡す（証跡と共有しない）
    // 日本語の請求書は CID フォント。cMap が無いと文字が化けるので必ず渡す
    cMapUrl: path.join(root, 'cmaps/'),
    cMapPacked: true,
    standardFontDataUrl: path.join(root, 'standard_fonts/'),
    isEvalSupported: false,
    verbosity: 0, // フォント修復の警告を出さない（読めているので人には要らない）
  })
  const doc = await task.promise

  const pages = []
  for (let p = 1; p <= doc.numPages; p++) {
    const content = await (await doc.getPage(p)).getTextContent()
    pages.push(
      layoutFromItems(
        content.items.map((it) => ({
          str: it.str,
          x: it.transform[4],
          y: it.transform[5],
          w: it.width,
        }))
      )
    )
  }
  await task.destroy() // ワーカーを畳む（巡回は何百 PDF も読むので溜めない）
  return pages.join('\n')
}
