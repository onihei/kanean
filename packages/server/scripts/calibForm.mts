/**
 * 汎用フォーム較正: assets/forms 配下のテンプレ指定ページに pt ルーラー（縦横10pt罫・50pt強調＋
 * 盤面内に数値ラベル）を重ね、argv の矩形 [x0 y0 w h] に CropBox を設定して /tmp/calibform.pdf に出力。
 * 使い方: pnpm -s exec tsx scripts/calibForm.mts <formFile> <page1> [x0 y0 w h]
 *   例:   pnpm -s exec tsx scripts/calibForm.mts kakutei_r05.pdf 1 300 400 280 280
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb } from 'pdf-lib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const form = process.argv[2]
const page1 = Number(process.argv[3] ?? '1')
const [x0, y0, w, h] = process.argv.slice(4).map(Number)

const src = await PDFDocument.load(fs.readFileSync(path.join(HERE, '..', 'assets', 'forms', form)))
const doc = await PDFDocument.create()
const font = await doc.embedFont('Helvetica')
const [ep] = await doc.embedPages([src.getPage(page1 - 1)])
const page = doc.addPage([ep.width, ep.height])
page.drawPage(ep)
const W = ep.width
const H = ep.height
const red = rgb(0.85, 0.1, 0.1)
const blue = rgb(0.1, 0.3, 0.85)
for (let x = 0; x <= W; x += 10) {
  const major = x % 50 === 0
  page.drawLine({ start: { x, y: 0 }, end: { x, y: H }, thickness: major ? 0.4 : 0.15, color: major ? red : blue, opacity: major ? 0.5 : 0.3 })
}
for (let y = 0; y <= H; y += 10) {
  const major = y % 50 === 0
  page.drawLine({ start: { x: 0, y }, end: { x: W, y }, thickness: major ? 0.4 : 0.15, color: major ? red : blue, opacity: major ? 0.5 : 0.3 })
}
for (let x = 0; x <= W; x += 50) {
  for (let ly = 25; ly <= H; ly += 100) page.drawText(String(x), { x: x + 1, y: ly, size: 5, font, color: red })
}
for (let y = 0; y <= H; y += 50) {
  for (let lx = 25; lx <= W; lx += 100) page.drawText(String(y), { x: lx, y: y + 1, size: 5, font, color: red })
}
if (Number.isFinite(x0)) page.setCropBox(x0, y0, w, h)
fs.writeFileSync('/tmp/calibform.pdf', await doc.save())
console.log(`wrote /tmp/calibform.pdf ${form} p${page1} crop=[${x0},${y0},${w},${h}] size=${W.toFixed(1)}x${H.toFixed(1)}`)
