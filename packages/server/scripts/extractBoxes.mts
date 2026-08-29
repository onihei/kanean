/**
 * 官製様式テンプレ（assets/forms/aoiro_r05.pdf）の各ページから矩形(`re`)を抽出し、
 * ページ座標（左下原点・pt）に正規化して JSON 出力する較正補助スクリプト。
 *
 * 目的: オーバーレイの金額差込位置を目視推定ではなくベクター内容から確定するため。
 * 使い方: pnpm --filter @kanean/server exec tsx scripts/extractBoxes.mts <page1-based> [outJson]
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import {
  PDFDocument,
  PDFName,
  PDFArray,
  PDFRef,
  PDFRawStream,
  decodePDFRawStream,
} from 'pdf-lib'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const TEMPLATE = path.join(HERE, '..', 'assets', 'forms', 'aoiro_r05.pdf')

type Mat = [number, number, number, number, number, number]
const I: Mat = [1, 0, 0, 1, 0, 0]
// m2 applied after m1 (m1 is the inner/current CTM, m2 the new cm). PDF: new = cm * CTM
function mul(m1: Mat, m2: Mat): Mat {
  // returns m2 ∘ m1 with m1 as existing CTM, m2 as the cm operand (point' = point * m2 * m1)
  const [a1, b1, c1, d1, e1, f1] = m1
  const [a2, b2, c2, d2, e2, f2] = m2
  return [
    a2 * a1 + b2 * c1,
    a2 * b1 + b2 * d1,
    c2 * a1 + d2 * c1,
    c2 * b1 + d2 * d1,
    e2 * a1 + f2 * c1 + e1,
    e2 * b1 + f2 * d1 + f1,
  ]
}
function apply(m: Mat, x: number, y: number): [number, number] {
  return [m[0] * x + m[2] * y + m[4], m[1] * x + m[3] * y + m[5]]
}

function streamText(doc: PDFDocument, pageIdx: number): string {
  const page = doc.getPage(pageIdx).node
  const contents = page.get(PDFName.of('Contents'))
  const refs: PDFRef[] = []
  if (contents instanceof PDFRef) refs.push(contents)
  else if (contents instanceof PDFArray) {
    for (let i = 0; i < contents.size(); i++) {
      const e = contents.get(i)
      if (e instanceof PDFRef) refs.push(e)
    }
  }
  let out = ''
  for (const ref of refs) {
    const s = doc.context.lookup(ref)
    if (s instanceof PDFRawStream) {
      out += new TextDecoder('latin1').decode(decodePDFRawStream(s).decode()) + '\n'
    }
  }
  return out
}

interface Rect {
  x: number
  y: number
  w: number
  h: number
}

interface Seg {
  x0: number
  y0: number
  x1: number
  y1: number
}

/** Extract axis-aligned grid lines (from re edges + m/l segments), CTM-applied. */
function extractGrid(content: string): { vx: { x: number; y0: number; y1: number; n: number }[]; hy: { y: number; x0: number; x1: number; n: number }[] } {
  const toks = content.match(/-?\d+\.?\d*|[A-Za-z'"*]+|[qQ]/g) ?? []
  const stack: Mat[] = []
  let ctm: Mat = I
  const nums: number[] = []
  const segs: Seg[] = []
  let cx = 0
  let cy = 0
  const addSeg = (x0: number, y0: number, x1: number, y1: number) => {
    const [ax, ay] = apply(ctm, x0, y0)
    const [bx, by] = apply(ctm, x1, y1)
    segs.push({ x0: ax, y0: ay, x1: bx, y1: by })
  }
  for (const t of toks) {
    if (/^-?\d+\.?\d*$/.test(t)) {
      nums.push(parseFloat(t))
      continue
    }
    switch (t) {
      case 'q':
        stack.push(ctm)
        break
      case 'Q':
        ctm = stack.pop() ?? I
        break
      case 'cm':
        if (nums.length >= 6) ctm = mul(ctm, nums.slice(-6) as unknown as Mat)
        break
      case 'm':
        if (nums.length >= 2) [cx, cy] = nums.slice(-2)
        break
      case 'l':
        if (nums.length >= 2) {
          const [nx, ny] = nums.slice(-2)
          addSeg(cx, cy, nx, ny)
          cx = nx
          cy = ny
        }
        break
      case 're':
        if (nums.length >= 4) {
          const [x, y, w, h] = nums.slice(-4)
          addSeg(x, y, x + w, y)
          addSeg(x + w, y, x + w, y + h)
          addSeg(x + w, y + h, x, y + h)
          addSeg(x, y + h, x, y)
        }
        break
    }
    nums.length = 0
  }
  // classify
  const vsegs = segs.filter((s) => Math.abs(s.x1 - s.x0) < 0.6 && Math.abs(s.y1 - s.y0) > 2)
  const hsegs = segs.filter((s) => Math.abs(s.y1 - s.y0) < 0.6 && Math.abs(s.x1 - s.x0) > 2)
  const clusterV = new Map<number, { x: number; y0: number; y1: number; n: number }>()
  for (const s of vsegs) {
    const key = Math.round(s.x0)
    const lo = Math.min(s.y0, s.y1)
    const hi = Math.max(s.y0, s.y1)
    const c = clusterV.get(key)
    if (c) {
      c.y0 = Math.min(c.y0, lo)
      c.y1 = Math.max(c.y1, hi)
      c.n++
    } else clusterV.set(key, { x: s.x0, y0: lo, y1: hi, n: 1 })
  }
  const clusterH = new Map<number, { y: number; x0: number; x1: number; n: number }>()
  for (const s of hsegs) {
    const key = Math.round(s.y0)
    const lo = Math.min(s.x0, s.x1)
    const hi = Math.max(s.x0, s.x1)
    const c = clusterH.get(key)
    if (c) {
      c.x0 = Math.min(c.x0, lo)
      c.x1 = Math.max(c.x1, hi)
      c.n++
    } else clusterH.set(key, { y: s.y0, x0: lo, x1: hi, n: 1 })
  }
  return {
    vx: [...clusterV.values()].sort((a, b) => a.x - b.x),
    hy: [...clusterH.values()].sort((a, b) => b.y - a.y),
  }
}

function extractRects(content: string): Rect[] {
  // Tokenize numbers/operators (ignore strings/dicts roughly; form line-art has none).
  const toks = content.match(/-?\d+\.?\d*|[A-Za-z'"*]+|[qQ]/g) ?? []
  const stack: Mat[] = []
  let ctm: Mat = I
  const nums: number[] = []
  const rects: Rect[] = []
  for (const t of toks) {
    if (/^-?\d+\.?\d*$/.test(t)) {
      nums.push(parseFloat(t))
      continue
    }
    switch (t) {
      case 'q':
        stack.push(ctm)
        break
      case 'Q':
        ctm = stack.pop() ?? I
        break
      case 'cm':
        if (nums.length >= 6) {
          const m = nums.slice(-6) as unknown as Mat
          ctm = mul(ctm, m)
        }
        break
      case 're':
        if (nums.length >= 4) {
          const [x, y, w, h] = nums.slice(-4)
          // transform the rect's two opposite corners by CTM, re-derive axis-aligned box
          const [x0, y0] = apply(ctm, x, y)
          const [x1, y1] = apply(ctm, x + w, y + h)
          rects.push({
            x: Math.min(x0, x1),
            y: Math.min(y0, y1),
            w: Math.abs(x1 - x0),
            h: Math.abs(y1 - y0),
          })
        }
        break
    }
    nums.length = 0 // operands consumed by any operator token
  }
  return rects
}

const pageArg = Number(process.argv[2] ?? '1')
const mode = process.argv[3] // 'grid' | undefined
const outArg = process.argv[4] ?? process.argv[3]
const bytes = fs.readFileSync(TEMPLATE)
const doc = await PDFDocument.load(bytes)
const idx = pageArg - 1
const page = doc.getPage(idx)
const { width, height } = page.getSize()
const content = streamText(doc, idx)

if (mode === 'grid') {
  const { vx, hy } = extractGrid(content)
  // significant grid lines only (length > 30pt, seen >= 1)
  const v = vx.filter((l) => l.y1 - l.y0 > 20)
  const h = hy.filter((l) => l.x1 - l.x0 > 20)
  console.log(`page ${pageArg} size ${width}x${height}`)
  console.log(`V lines (x | yspan | n): ${v.length}`)
  console.log(v.map((l) => `${l.x.toFixed(1)}[${l.y0.toFixed(0)}-${l.y1.toFixed(0)}]`).join('  '))
  console.log(`H lines (y | xspan | n): ${h.length}`)
  console.log(h.map((l) => `${l.y.toFixed(1)}[${l.x0.toFixed(0)}-${l.x1.toFixed(0)}]`).join('  '))
  if (outArg && outArg !== 'grid') fs.writeFileSync(outArg, JSON.stringify({ width, height, v, h }, null, 0))
  process.exit(0)
}

const allRects = extractRects(content)
// keep cell-like rectangles (filter hairlines/huge frames noise)
const cells = allRects.filter((r) => r.w >= 6 && r.h >= 6 && r.w < width && r.h < height)
const opCounts: Record<string, number> = {}
for (const m of content.match(/[A-Za-z'"*]+/g) ?? []) opCounts[m] = (opCounts[m] ?? 0) + 1
const summary = {
  page: pageArg,
  size: { width, height },
  contentLen: content.length,
  ops: { re: opCounts['re'] ?? 0, l: opCounts['l'] ?? 0, m: opCounts['m'] ?? 0, cm: opCounts['cm'] ?? 0 },
  rectsRaw: allRects.length,
  cells: cells.length,
}
console.log(JSON.stringify(summary, null, 2))
if (outArg) {
  fs.writeFileSync(
    outArg,
    JSON.stringify(
      cells.map((r, i) => ({ i, ...r, xr: +(r.x + r.w).toFixed(1), yb: +r.y.toFixed(1) })),
      null,
      0,
    ),
  )
  console.log(`wrote ${cells.length} cells -> ${outArg}`)
}
