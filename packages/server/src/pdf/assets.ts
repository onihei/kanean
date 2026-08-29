import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb, type PDFFont, type PDFPage } from 'pdf-lib'
import fontkit from '@pdf-lib/fontkit'
import type { Yen } from '@kanean/shared'

/**
 * pdf/ 6帳票の共有プリミティブ（issue #123 = B11）。
 * フォント・テンプレのバイト列はファイル名キーのプロセス内共有キャッシュ
 * （従来は各モジュールが自前キャッシュ×6＝同一フォントを重複保持していた）。
 */

const ASSETS = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'assets')

const cache = new Map<string, Buffer>()
function readCached(file: string): Buffer {
  let b = cache.get(file)
  if (!b) {
    b = fs.readFileSync(file)
    cache.set(file, b)
  }
  return b
}

/** assets/fonts/ のフォント（ipaexg.ttf 等）。 */
export function fontBytes(file: string): Buffer {
  return readCached(path.join(ASSETS, 'fonts', file))
}

/** assets/forms/ の官製様式テンプレ PDF。 */
export function templateBytes(file: string): Buffer {
  return readCached(path.join(ASSETS, 'forms', file))
}

/** registerFontkit＋日本語フォントのサブセット埋込（registerFontkit を忘れると空白化する規約を1箇所に）。 */
export async function embedJapaneseFont(doc: PDFDocument, fontFile: string): Promise<PDFFont> {
  doc.registerFontkit(fontkit)
  return doc.embedFont(fontBytes(fontFile), { subset: true })
}

/**
 * オーバーレイ様式の骨格: テンプレ PDF を読み、各ページを Form XObject 化（embedPages）して
 * 新規ドキュメントの背景に敷く。テンプレは gs 正規化で未平衡 CTM が残るため、ページを直接
 * コピーすると CTM を継承して描画位置がズレる — この回避が embedPages を使う理由
 * （3帳票で逐語同文だったボイラープレート）。
 */
export async function loadOverlay(
  templateFile: string,
  fontFile: string,
): Promise<{ doc: PDFDocument; font: PDFFont; pages: PDFPage[] }> {
  const src = await PDFDocument.load(templateBytes(templateFile))
  const doc = await PDFDocument.create()
  const font = await embedJapaneseFont(doc, fontFile)
  const embedded = await doc.embedPages(src.getPages())
  const pages = embedded.map((ep) => {
    const page = doc.addPage([ep.width, ep.height])
    page.drawPage(ep)
    return page
  })
  return { doc, font, pages }
}

/** 本文インク色（自前レイアウト3帳票の共通定数）。 */
export const INK = rgb(0.1, 0.1, 0.1)
/** 罫線色。 */
export const RULE = rgb(0.6, 0.6, 0.6)

/** 金額の3桁区切り（円記号なし。様式側に円欄がある前提）。 */
export function formatYen(amount: Yen): string {
  return amount.toLocaleString('ja-JP')
}

/** 会計年度開始日（西暦）→「令和N年分」（令和元年=2019）。 */
export function reiwa(startDate: string): string {
  const year = Number(startDate.slice(0, 4))
  return `令和${year - 2018}年分`
}

/** 左寄せ描画（色は INK）。 */
export function drawText(page: PDFPage, text: string, x: number, y: number, size: number, font: PDFFont): void {
  page.drawText(text, { x, y, size, font, color: INK })
}

/** 右寄せ描画（xRight が右端。色は INK）。 */
export function drawRight(page: PDFPage, text: string, xRight: number, y: number, size: number, font: PDFFont): void {
  page.drawText(text, { x: xRight - font.widthOfTextAtSize(text, size), y, size, font, color: INK })
}
