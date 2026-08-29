/** 較正用ルーラー: 指定ページに水平/垂直の目盛線（pt・ラベル付）を重ねて /tmp/ruler.pdf に出力。
 * 使い方: pnpm --filter @kanean/server exec tsx scripts/ruler.mts <page> [ymin] [ymax]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { PDFDocument, rgb } from 'pdf-lib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, '..', 'assets', 'forms', 'aoiro_r05.pdf')
const pageArg = Number(process.argv[2] ?? '3')
const ymin = Number(process.argv[3] ?? '60')
const ymax = Number(process.argv[4] ?? '260')

const src = await PDFDocument.load(fs.readFileSync(TEMPLATE))
const doc = await PDFDocument.create()
const font = await doc.embedFont('Helvetica')
const eps = await doc.embedPages(src.getPages())
const pages = eps.map((ep) => {
  const p = doc.addPage([ep.width, ep.height])
  p.drawPage(ep)
  return p
})
const page = pages[pageArg - 1]
const { width } = page.getSize()
const red = rgb(1, 0, 0)
for (let y = ymin; y <= ymax; y += 5) {
  const major = y % 20 === 0
  page.drawLine({ start: { x: 55, y }, end: { x: width - 20, y }, thickness: major ? 0.5 : 0.2, color: red, opacity: major ? 0.6 : 0.3 })
  page.drawText(String(y), { x: 30, y: y - 2, size: 6, font, color: red })
}
// 確認用マーカー: expense 列(x=690 右寄せ)に y を明記したサンプル数値を置く
for (const y of [90, 100, 110, 117, 120, 124, 130]) {
  const t = `<<${y}>>`
  page.drawText(t, { x: 690 - font.widthOfTextAtSize(t, 8), y, size: 8, font, color: rgb(0, 0, 1) })
}
fs.writeFileSync('/tmp/ruler.pdf', await doc.save())
console.log(`wrote /tmp/ruler.pdf page ${pageArg} y=${ymin}..${ymax}`)
