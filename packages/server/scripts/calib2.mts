/**
 * ページ2較正用: テンプレ2ページ目に pt ルーラー（縦横10pt罫・50pt強調＋数値ラベル）を重ね、
 * argv の矩形 [x0 y0 w h] に CropBox を設定して単一ページPDFを /tmp/calib2.pdf に出力する。
 * gs -dUseCropBox で当該領域だけを高解像度レンダリングして座標を読む。
 * 使い方: pnpm -s exec tsx scripts/calib2.mts <x0> <y0> <w> <h>
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb } from 'pdf-lib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, '..', 'assets', 'forms', 'aoiro_r05.pdf')

const [x0, y0, w, h] = process.argv.slice(2).map(Number)

const src = await PDFDocument.load(fs.readFileSync(TEMPLATE))
const doc = await PDFDocument.create()
const font = await doc.embedFont('Helvetica')
const [ep] = await doc.embedPages([src.getPage(1)])
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
// 50pt罫の数値ラベルを盤面内に繰返し配置（どの crop でも座標が読めるよう）。
for (let x = 0; x <= W; x += 50) {
  for (let ly = 25; ly <= H; ly += 100) page.drawText(String(x), { x: x + 1, y: ly, size: 5, font, color: red })
}
for (let y = 0; y <= H; y += 50) {
  for (let lx = 25; lx <= W; lx += 100) page.drawText(String(y), { x: lx, y: y + 1, size: 5, font, color: red })
}

if (Number.isFinite(x0)) page.setCropBox(x0, y0, w, h)
fs.writeFileSync('/tmp/calib2.pdf', await doc.save())
console.log(`wrote /tmp/calib2.pdf crop=[${x0},${y0},${w},${h}]`)
