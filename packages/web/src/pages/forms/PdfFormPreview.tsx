/**
 * サーバ生成の様式PDF（官製様式オーバーレイ）を pdf.js で canvas 描画するプレビュー。
 * HTML 再現（IncomeTaxForm 等）と異なり「公式様式PDF」の出力と見た目が完全に一致する。
 * pdf.js 本体（約1MB）はプレビュー初回表示時に動的 import する。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react'
import { SegTabs, TaxAdvisorBanner, PdfButton } from '../../components/common.js'
import { apiFetch } from '../../api.js'
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url'

/** gov-page と同じシート表示幅（styles/forms.css）。 */
const SHEET_WIDTH = 760

/** pdf.js のデコード資材（vite.config.ts の pdfjsAssets で配信。BASE_URL 配下）。 */
const PDFJS_ASSET_BASE = `${import.meta.env.BASE_URL}pdfjs/`

let pdfjsLoader: Promise<typeof import('pdfjs-dist')> | null = null
function loadPdfjs() {
  pdfjsLoader ??= import('pdfjs-dist').then((pdfjs) => {
    pdfjs.GlobalWorkerOptions.workerSrc = pdfWorkerUrl
    return pdfjs
  })
  return pdfjsLoader
}

/** PDF ルート（http/api.ts）のエラーは JSON {error}。本文から表示用メッセージを取り出す。 */
function errorMessage(status: number, body: string): string {
  try {
    return (JSON.parse(body) as { error?: string }).error ?? `HTTP ${status}`
  } catch {
    return `HTTP ${status}`
  }
}

/** path の PDF を取得し、全ページを canvas でシート状に並べて描画する。 */
export function PdfFormPreview({ path }: { path: string }) {
  const holder = useRef<HTMLDivElement>(null)
  const [status, setStatus] = useState<'loading' | 'ready' | 'error'>('loading')
  const [errMsg, setErrMsg] = useState('')

  useEffect(() => {
    let cancelled = false
    setStatus('loading')
    setErrMsg('')
    ;(async () => {
      const res = await apiFetch(path)
      if (!res.ok) throw new Error(errorMessage(res.status, await res.text()))
      const data = await res.arrayBuffer()
      const pdfjs = await loadPdfjs()
      // cMap/wasm は官製テンプレートの CID フォント・CCITT/JBIG2 画像の描画に必要。
      // 未指定だとフォント読込失敗や画像脱落（ignoring XObject）が起きる。
      const task = pdfjs.getDocument({
        data,
        cMapUrl: `${PDFJS_ASSET_BASE}cmaps/`,
        cMapPacked: true,
        wasmUrl: `${PDFJS_ASSET_BASE}wasm/`,
        standardFontDataUrl: `${PDFJS_ASSET_BASE}standard_fonts/`,
        iccUrl: `${PDFJS_ASSET_BASE}iccs/`,
      })
      const doc = await task.promise
      try {
        const el = holder.current
        if (cancelled || !el) return
        el.replaceChildren()
        // 高解像度画面では実ピクセルで描く（上限2倍。それ以上は容量に見合わない）。
        const dpr = Math.min(window.devicePixelRatio || 1, 2)
        for (let n = 1; n <= doc.numPages; n++) {
          const page = await doc.getPage(n)
          if (cancelled) return
          const scale = (SHEET_WIDTH / page.getViewport({ scale: 1 }).width) * dpr
          const viewport = page.getViewport({ scale })
          const canvas = document.createElement('canvas')
          canvas.className = 'pdf-sheet'
          canvas.width = viewport.width
          canvas.height = viewport.height
          canvas.style.width = `${SHEET_WIDTH}px`
          await page.render({ canvas, viewport }).promise
          if (cancelled) return
          el.appendChild(canvas)
        }
      } finally {
        void task.destroy()
      }
      if (!cancelled) setStatus('ready')
    })().catch((e: unknown) => {
      if (cancelled) return
      holder.current?.replaceChildren()
      setErrMsg(e instanceof Error ? e.message : String(e))
      setStatus('error')
    })
    return () => {
      cancelled = true
    }
  }, [path])

  return (
    <div className="gov-wrap">
      {status === 'loading' && <p className="pdf-status">様式PDFを生成中…</p>}
      {status === 'error' && <p className="pdf-status error">プレビューを表示できません: {errMsg}</p>}
      <div ref={holder} className="pdf-sheets" />
    </div>
  )
}

/**
 * 様式プレビューの表示切替。既定は提出様式そのままの「様式PDF表示」、
 * 従来の HTML 再現（children）は「HTML簡易表示」として残す。
 */
export function FormPreviewSwitch({
  pdfPath,
  pdfFilename,
  htmlNote,
  children,
}: {
  /** 公式様式PDFの API パス（例: /api/tax-return/income-tax-official.pdf）。 */
  pdfPath: string
  /** ダウンロード時のファイル名。 */
  pdfFilename: string
  /** HTML簡易表示側のバナー注記（従来文言を踏襲）。 */
  htmlNote: string
  children: ReactNode
}) {
  const [mode, setMode] = useState<'pdf' | 'html'>('pdf')
  return (
    <>
      <SegTabs
        value={mode}
        onChange={setMode}
        options={[
          { value: 'pdf', label: '様式PDF表示' },
          { value: 'html', label: 'HTML簡易表示' },
        ]}
      />
      {mode === 'pdf' ? (
        <>
          <TaxAdvisorBanner note="官製様式PDF（「公式様式PDF」出力と同一）をそのまま画面に描画しています。" />
          <div className="gov-toolbar no-print">
            <PdfButton path={pdfPath} filename={pdfFilename} label="この様式PDFをダウンロード" />
          </div>
          <PdfFormPreview path={pdfPath} />
        </>
      ) : (
        <>
          <TaxAdvisorBanner note={htmlNote} />
          {children}
        </>
      )}
    </>
  )
}
