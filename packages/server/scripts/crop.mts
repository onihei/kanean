/**
 * 任意PDFの指定ページを矩形 CropBox で切り出し単一ページPDFを /tmp/crop.pdf に出力。
 * 使い方: pnpm -s exec tsx scripts/crop.mts <pdf> <page1> <x> <y> <w> <h>
 */
import fs from 'node:fs'
import { PDFDocument } from 'pdf-lib'
const [pdf, p, x, y, w, h] = [process.argv[2], ...process.argv.slice(3).map(Number)] as [string, number, number, number, number, number]
const src = await PDFDocument.load(fs.readFileSync(pdf))
const doc = await PDFDocument.create()
const [ep] = await doc.embedPages([src.getPage(p - 1)])
const page = doc.addPage([ep.width, ep.height])
page.drawPage(ep)
page.setCropBox(x, y, w, h)
fs.writeFileSync('/tmp/crop.pdf', await doc.save())
console.log(`wrote /tmp/crop.pdf p${p} [${x},${y},${w},${h}]`)
