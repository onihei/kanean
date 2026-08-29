#!/usr/bin/env node
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { execFileSync, spawn } from 'node:child_process'
import * as esbuild from 'esbuild'

/**
 * 配布用の MCP バンドル（`.mcpb`）を作る。
 *
 * 利用者は**このファイル1つをドラッグする**だけで導入できる。設定ファイルの手書きは無い
 * （mcp-server spec「1クリックで導入できる配布形態」）。
 *
 * 依存は esbuild で1ファイルへ畳む。`node_modules` を丸ごと同梱するより桁違いに小さく、
 * pnpm の symlink を実ファイルへ展開する手間も要らない。
 *
 * **Node ランタイムは同梱しない**。Claude Desktop が macOS/Windows 向けに同梱しており、
 * 利用者側に Node は要らない（design D8）。`manifest.json` の `compatibility.platforms` を
 * `darwin` だけにしてあるのは、未起動時の起動が `open -a`（macOS）に依存するため
 * ＝動く範囲だけを名乗る。
 *
 * `manifest.json` のスキーマは厳格で `//` 付きのコメントキーを受け付けない。
 * 判断の根拠はこのファイルに置く。
 */

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgRoot = path.resolve(here, '..')

// 版は Claude Desktop の一覧に出る。**入れ替えたのに同じ版**だと、利用者も自分も
// 「新しい方が入っているのか」を確かめられない。package.json と manifest.json のずれをここで止める。
const pkgVersion = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'package.json'), 'utf8')).version
const manifest = JSON.parse(fs.readFileSync(path.join(pkgRoot, 'manifest.json'), 'utf8'))
const manifestVersion = manifest.version
if (pkgVersion !== manifestVersion) {
  console.error(`✖ 版が食い違っています: package.json=${pkgVersion} / manifest.json=${manifestVersion}`)
  process.exit(1)
}
const stage = path.join(pkgRoot, 'build', 'bundle')
const outFile = path.join(pkgRoot, 'build', 'kanean.mcpb')

fs.rmSync(path.join(pkgRoot, 'build'), { recursive: true, force: true })
fs.mkdirSync(path.join(stage, 'server'), { recursive: true })

await esbuild.build({
  entryPoints: [path.join(pkgRoot, 'src', 'index.ts')],
  // **拡張子は .mjs**。`.js` だと同梱先に package.json が無いため Node が CommonJS として
  // 読み、ESM の import で落ちる（パック済みを実際に起動して判明）。
  outfile: path.join(stage, 'server', 'index.mjs'),
  bundle: true,
  platform: 'node',
  target: 'node20',
  format: 'esm',
  // シバンは src/index.ts が既に持っている。banner で足すと2行目にもう1つ出て構文エラーになる。
  minify: true,
  sourcemap: false,
})

fs.copyFileSync(path.join(pkgRoot, 'manifest.json'), path.join(stage, 'manifest.json'))

/**
 * 畳んだ成果物を実際に起動して、MCP の初期化まで通ることを確かめる。
 *
 * 型検査もテストも**ソースに対して**しか働かない。バンドル固有の壊れ方
 * （シバンの重複・`.js` が CommonJS として読まれる・依存の畳み損ね）は
 * ここで起動してみるまで分からない。実際にこの検証で2件見つかっている。
 */
async function verifyBundle(entry) {
  const child = spawn('node', [entry], { stdio: ['pipe', 'pipe', 'pipe'] })
  const stderr = []
  child.stderr.on('data', (chunk) => stderr.push(chunk))

  // 応答を id で拾う簡易 JSON-RPC リーダ（stdio 越しの改行区切り）。
  const pending = new Map()
  let buffered = ''
  child.stdout.on('data', (chunk) => {
    buffered += String(chunk)
    const lines = buffered.split('\n')
    buffered = lines.pop() ?? ''
    for (const line of lines) {
      if (!line.trim().startsWith('{')) continue
      const msg = JSON.parse(line)
      if (msg.id != null && pending.has(msg.id)) {
        pending.get(msg.id)(msg)
        pending.delete(msg.id)
      }
    }
  })
  child.once('exit', (code) => {
    const err = new Error(`起動できませんでした（終了コード ${code}）\n${Buffer.concat(stderr)}`)
    for (const resolve of pending.values()) resolve({ __exit: err })
    pending.clear()
  })
  const rpc = (id, method, params) => {
    const p = new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`${method} の応答がありません（5秒）`)), 5_000)
      pending.set(id, (msg) => {
        clearTimeout(timer)
        if (msg.__exit) reject(msg.__exit)
        else resolve(msg)
      })
    })
    child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', id, method, params })}\n`)
    return p
  }

  const response = await rpc(1, 'initialize', {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'bundle-verify', version: '0' },
  })
  const name = response?.result?.serverInfo?.name
  if (name !== 'kanean') {
    child.kill()
    throw new Error(`想定外の応答: ${JSON.stringify(response)}`)
  }

  // **畳んだあとのレイアウトで manifest.json を読めるか**を、ここで確かめる。
  // 版は `server/index.mjs` から見た `../manifest.json` から取る。畳み方や配置が変われば
  // 静かに読めなくなり、名乗らないクライアント＝常に拒否されるバンドルが出来上がる。
  // ソースに対する型検査もテストも、この壊れ方は捕まえられない。
  const version = response?.result?.serverInfo?.version
  if (version !== manifestVersion) {
    child.kill()
    throw new Error(`版を名乗れていません: serverInfo.version=${version} / manifest=${manifestVersion}`)
  }

  // **manifest のツール/プロンプト一覧が実装と集合一致するか**（issue #168）。
  // manifest は Claude Desktop の一覧表示にだけ使われるため、実装にツールを1本足して
  // manifest を忘れてもビルドもテストも通ってしまう。実際に tools/list / prompts/list を
  // 叩いて、名前の集合で突き合わせる（過不足の両方向を検査）。
  child.stdin.write(`${JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' })}\n`)
  const compare = (label, actualNames, declared) => {
    const actual = new Set(actualNames)
    const listed = new Set((declared ?? []).map((t) => t.name))
    const missing = [...actual].filter((n) => !listed.has(n)) // 実装にあるが manifest に無い
    const stale = [...listed].filter((n) => !actual.has(n)) // manifest にあるが実装に無い
    if (missing.length || stale.length) {
      throw new Error(
        `manifest.json の ${label} が実装と食い違っています\n` +
          (missing.length ? `  manifest に無い: ${missing.join(', ')}\n` : '') +
          (stale.length ? `  実装に無い: ${stale.join(', ')}\n` : '')
      )
    }
    return actual.size
  }
  const tools = await rpc(2, 'tools/list', {})
  const toolCount = compare('tools', (tools?.result?.tools ?? []).map((t) => t.name), manifest.tools)
  const prompts = await rpc(3, 'prompts/list', {})
  const promptCount = compare('prompts', (prompts?.result?.prompts ?? []).map((p) => p.name), manifest.prompts)

  child.kill()
  return { toolCount, promptCount }
}

const { toolCount, promptCount } = await verifyBundle(path.join(stage, 'server', 'index.mjs'))
console.log(`起動確認: OK（initialize に応答・manifest と一致: ツール${toolCount}・プロンプト${promptCount}）`)

execFileSync('npx', ['mcpb', 'pack', stage, outFile], { stdio: 'inherit', cwd: pkgRoot })

/**
 * 同梱版を**バンドルの外へも**書き出す（design D5）。
 *
 * アプリは「配布物に入っている版」と「クライアントが名乗った版」を突き合わせて、
 * 一致しないクライアントを拒否する。`.mcpb` は zip なので、その1つの数字のために
 * 実行時に展開したくない。版の出所は `manifest.json` のままで、ここでは写すだけ。
 */
fs.writeFileSync(`${outFile}.version`, `${manifestVersion}\n`, 'utf8')

const bytes = fs.statSync(outFile).size
console.log(`\n${path.relative(process.cwd(), outFile)}: ${(bytes / 1024).toFixed(0)} KB`)
console.log(`${path.relative(process.cwd(), `${outFile}.version`)}: ${manifestVersion}`)
