import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, loadEnv, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'

/** pdfjs-dist パッケージのルート（pnpm の symlink を辿った実体）。 */
const PDFJS_DIST_DIR = path.dirname(
  fs.realpathSync(fileURLToPath(new URL('./node_modules/pdfjs-dist/package.json', import.meta.url))),
)

/** 配信する資材ディレクトリ（いずれも平坦。cmaps=CIDフォント、wasm=JBIG2/CCITT等のデコーダ）。 */
const PDFJS_ASSET_DIRS = ['cmaps', 'wasm', 'standard_fonts', 'iccs']

const PDFJS_CONTENT_TYPES: Record<string, string> = {
  '.wasm': 'application/wasm', // WebAssembly streaming compile に必要
  '.js': 'text/javascript',
}

/**
 * pdf.js のデコード資材（CIDフォント cMap・JBIG2/CCITT 等の wasm・標準フォント・ICC）を
 * `{base}pdfjs/` 配下で配信する。官製様式テンプレートのフォント/画像の描画に必要
 * （PdfFormPreview が getDocument の cMapUrl/wasmUrl 等で参照）。
 * dev はミドルウェア配信・build は dist へコピー。
 */
export function pdfjsAssets(): Plugin {
  let outDir = ''
  let base = '/'
  let isBuild = false
  return {
    name: 'kanean:pdfjs-assets',
    configResolved(config) {
      outDir = path.resolve(config.root, config.build.outDir)
      base = config.base
      isBuild = config.command === 'build'
    },
    configureServer(server) {
      server.middlewares.use((req, res, next) => {
        const url = (req.url ?? '').replace(/[?#].*$/, '')
        const prefix = `${base}pdfjs/`
        if (!url.startsWith(prefix)) return next()
        const m = /^(cmaps|wasm|standard_fonts|iccs)\/([\w.+-]+)$/.exec(url.slice(prefix.length))
        if (!m) return next()
        fs.readFile(path.join(PDFJS_DIST_DIR, m[1], m[2]), (err, data) => {
          if (err) {
            res.statusCode = 404
            res.end()
            return
          }
          res.setHeader('Content-Type', PDFJS_CONTENT_TYPES[path.extname(m[2])] ?? 'application/octet-stream')
          res.end(data)
        })
      })
    },
    async closeBundle() {
      if (!isBuild) return
      for (const dir of PDFJS_ASSET_DIRS) {
        await fs.promises.cp(path.join(PDFJS_DIST_DIR, dir), path.join(outDir, 'pdfjs', dir), {
          recursive: true,
          dereference: true,
        })
      }
    },
  }
}

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, '../../')
  const serverPort = env.PORT || '10140'
  return {
    plugins: [react(), pdfjsAssets()],
    base: env.VITE_BASE_PATH || '/',
    envDir: '../../',
    server: {
      port: 5173,
      // サーバは 127.0.0.1 のみで待ち受ける（IPv4）。`localhost` は環境により ::1 を先に解決するため、
      // プロキシ先は 127.0.0.1 を明示する。
      proxy: {
        '/api': { target: `http://127.0.0.1:${serverPort}` },
        '/health': { target: `http://127.0.0.1:${serverPort}` },
      },
    },
  }
})
