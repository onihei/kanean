import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { app, protocol, shell, BrowserWindow, dialog } from 'electron'
import { SCHEME, HOST, SCHEME_PRIVILEGES, createProtocolHandler } from './protocol.js'
import { screenLink } from '@kanean/shared'
import { deepLinkFromArgv, parseDeepLink, type OpenableTab } from './deepLink.js'
import { desktopRoutes } from './desktopRoutes.js'
import { bundledVersion } from './mcpBundle.js'
import { closeAcquisitionWindows, electronCrawler, forgetAcquisitionLogins } from './acquisitionCrawler.js'
import { startLocalSocket, defaultSocketPath, type LocalSocketServer } from './socket.js'

/**
 * Kanean デスクトップシェル（desktop-app spec / local-access spec）。
 *
 * 役割は3つだけ。
 *   1. アプリ起動中だけ生きるプロセスとして Hono を**同一プロセス内**に立てる
 *   2. UI と業務APIを**カスタムプロトコル**で配る（TCP ポートを一切開かない）
 *   3. ウィンドウを閉じたら終了する（常駐しない。design Decision 7）
 *
 * ローカル連携（取込スキル・MCP）用の unix domain socket は §6 で追加する。
 */

const here = path.dirname(fileURLToPath(import.meta.url))

/**
 * アプリ名を明示する。**`app.getPath('userData')` を読む前に呼ぶこと。**
 * 既定では package.json の `name`（`@kanean/desktop`）がそのまま使われ、
 * 会計データの置き場所が `~/Library/Application Support/@kanean/desktop/` という
 * スコープ名の漏れたパスになってしまう。
 */
app.setName('Kanean')

let localSocket: LocalSocketServer | null = null
let socketPath: string | null = null

protocol.registerSchemesAsPrivileged([SCHEME_PRIVILEGES])

/**
 * 会計データの置き場所。`DATA_DIR` が明示されていればそれに従い（開発・検証用）、
 * 無ければ OS 標準のアプリケーションデータ領域を使う。
 * ここで**必ず絶対パスに固定**する。server の既定は `./data` をリポジトリルート基準で
 * 解決する実装であり、パッケージ済みアプリには pnpm-workspace.yaml が無く cwd も不定なため。
 */
export function resolveDataDir(): string {
  const explicit = process.env.DATA_DIR
  if (explicit && explicit.trim() !== '') return path.resolve(explicit)
  // userData 直下は Electron/Chromium 自身の作業領域（Cache・GPUCache・Local Storage 等）でもある。
  // 会計データをその中に混ぜると、バックアップ・エクスポート・手動退避のときに
  // 「どれが自分のデータか」が判別できなくなるので、必ずサブディレクトリに隔離する。
  return path.join(app.getPath('userData'), 'data')
}

/** 配信する web のビルド成果物。開発時はリポジトリ内、パッケージ後は resources 配下。 */
export function webDistDir(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'web')
  return path.resolve(here, '../../web/dist')
}

/** 同梱した MCP バンドル。開発時はリポジトリ内、パッケージ後は resources 配下。 */
export function mcpBundlePath(): string {
  if (app.isPackaged) return path.join(process.resourcesPath, 'kanean.mcpb')
  return path.resolve(here, '../../mcp/build/kanean.mcpb')
}

/** 同梱バンドルの版を書いたファイル。バンドル生成が `.mcpb` と並べて出す（design D5）。 */
export function mcpBundleVersionPath(): string {
  return `${mcpBundlePath()}.version`
}

/**
 * 起動時に開く画面。OS からリンクで起動された場合だけ設定される。
 * `whenReady` より前に `open-url` が届きうるので、ここで受けておく。
 */
let pendingTab: OpenableTab | null = null

/**
 * 画面遷移。`loadURL` は別ナビゲーションによる打ち切り等で reject しうるため、必ずここで受ける。
 * 受けないと unhandledRejection（＝下の「起動に失敗しました」＋ `app.exit(1)`）へ流れ、
 * 稼働中のリンク遷移の失敗でアプリごと落ちてしまう（issue #243。#148 と同種の未捕捉 Promise）。
 * ERR_ABORTED は Playwright でも成功扱いの正常系（runtime/electron.mjs の goto と同じ規約）。
 */
function loadTab(win: BrowserWindow, tab: OpenableTab | null): void {
  const url = screenLink(tab)
  win.loadURL(url).catch((e: unknown) => {
    const code = String((e as { code?: unknown })?.code ?? (e as Error)?.message ?? e)
    if (!/ERR_ABORTED/.test(code)) console.error(`[desktop] 画面遷移に失敗: ${url}（${code}）`)
  })
}

/** リンクを受けて、該当画面を前面に出す。ウィンドウがまだ無ければ起動時に開く。 */
function openTab(tab: OpenableTab | null): void {
  const [win] = BrowserWindow.getAllWindows()
  if (!win) {
    pendingTab = tab
    return
  }
  if (win.isMinimized()) win.restore()
  win.focus()
  // 画面遷移だけを行う。リンクに更新系の意味は持たせない。
  loadTab(win, tab)
}

function createWindow(tab: OpenableTab | null = null): BrowserWindow {
  const win = new BrowserWindow({
    width: 1280,
    height: 860,
    show: false,
    title: 'Kanean',
    webPreferences: { contextIsolation: true, nodeIntegration: false },
  })

  // 証憑の別窓表示（JournalTab の `target="_blank"`）。Electron は既定で拒否するため
  // 明示的に許可する。許可するのは**自スキームのみ**とし、外部 URL は既定の拒否のままにする。
  win.webContents.setWindowOpenHandler(({ url }) =>
    url.startsWith(`${SCHEME}://${HOST}/`) ? { action: 'allow' } : { action: 'deny' },
  )

  win.once('ready-to-show', () => win.show())
  // 業務ウィンドウを閉じたら巡回窓も畳む。巡回窓だけが残ると
  // 「最後のウィンドウを閉じたのに終了しない」ように見えてしまう（desktop-app spec）。
  win.on('closed', () => closeAcquisitionWindows())
  loadTab(win, tab)
  return win
}

// 二重起動しない（desktop-app spec）。ロックを取れなければ既存ウィンドウを前面に出して終了する。
if (!app.requestSingleInstanceLock()) {
  app.quit()
} else {
  // `kanean://` リンクの取り扱い先として自分を登録する（OS からのリンク受理）。
  // これは `protocol.handle`（アプリ内配信）とは別の仕組みで、解釈は deepLink.ts に閉じる。
  app.setAsDefaultProtocolClient(SCHEME)

  // macOS はリンクを `open-url` で渡す。`whenReady` より早く届くことがある。
  app.on('open-url', (event, url) => {
    event.preventDefault()
    openTab(parseDeepLink(url))
  })

  // 起動中に再度リンクを開かれた場合（Windows/Linux は引数、macOS は上の open-url）。
  app.on('second-instance', (_event, argv) => {
    const link = deepLinkFromArgv(argv)
    if (link) {
      openTab(parseDeepLink(link))
      return
    }
    const [win] = BrowserWindow.getAllWindows()
    if (!win) return
    if (win.isMinimized()) win.restore()
    win.focus()
  })

  app.whenReady().then(async () => {
    const dataDir = resolveDataDir()
    fs.mkdirSync(dataDir, { recursive: true })
    // server の config は process.env.DATA_DIR を都度読むので、**createApp より前に**確定させる。
    process.env.DATA_DIR = dataDir

    // DATA_DIR 確定後に読み込む（module 読み込み時に DB パスを解決させないための動的 import）。
    const { createApp, tagSocketEntry } = await import('@kanean/server/app')
    // 同梱版を渡す＝一致しない MCP クライアントを拒否できるようになる（mcp-server spec）。
    // 開発時（同梱物が無い）は null になり、検査そのものが行われない（design D7）。
    const { app: honoApp } = createApp({ mcpBundleVersion: () => bundledVersion(mcpBundleVersionPath()) })

    // 巡回の実行殻を差し込む。サーバ本体は実装を持たない＝**デスクトップでしか巡回できない**
    // （ブラウザの窓を開く操作なので、開発時の server 単体や MCP ブリッジからは行えない）。
    const { setCrawler } = await import('@kanean/server/acquisition')
    setCrawler(electronCrawler())

    // デスクトップ版だけが持つ操作（Finder での提示など）を同じ HTTP 経路に足す（design D9）。
    honoApp.route(
      '/api',
      desktopRoutes({
        sourcePath: mcpBundlePath(),
        destinationDir: app.getPath('downloads'),
        reveal: (filePath) => shell.showItemInFolder(filePath),
        forgetAcquisitionLogins,
      }),
    )

    protocol.handle(SCHEME, createProtocolHandler(honoApp, webDistDir()))

    // ローカル連携（取込スキル・将来の MCP）の受け口。アプリ起動中だけ存在する。
    socketPath = defaultSocketPath(dataDir)
    // **入口の印を付ける**。ここへ届く要求はローカル連携（＝ MCP クライアント）からのもので、
    // UI（kanean:// のプロトコルハンドラ）とは経路が違う。版の検査はこの印を見て対象を決める
    // ので、名乗る前の版のバンドルも捕まえられる。クライアント側が詐称できないよう、
    // 送られてきた同名ヘッダは**上書きする**。
    localSocket = await startLocalSocket((request) => honoApp.fetch(tagSocketEntry(request)), socketPath)
    console.log(`[desktop] local socket: ${localSocket.path}`)

    // 未起動の状態でリンクから起動された場合は、その画面で開く。
    const launchLink = deepLinkFromArgv(process.argv)
    createWindow(pendingTab ?? (launchLink ? parseDeepLink(launchLink) : null))
    pendingTab = null
  })

  // 終了時にソケットを消す。プロセスが消えてもソケット**ファイル**は残るため、明示的に削除する。
  // 非同期の close を待てない経路（強制終了）に備えて同期の unlink も併用する。
  app.on('will-quit', () => {
    if (socketPath) fs.rmSync(socketPath, { force: true })
  })
  app.on('before-quit', () => {
    void localSocket?.close()
    // 巡回窓はアプリの寿命に閉じる。終了後に「銀行にログインしたままの窓」を残さない。
    closeAcquisitionWindows()
  })

  // ウィンドウを閉じたら終了する（design Decision 7）。macOS の「Dock に残す」例外は入れない。
  // ウィンドウが無いのにプロセスとローカルソケットが生き続ける状態を作らないため。
  app.on('window-all-closed', () => app.quit())

  // 起動シーケンスの失敗を黙って飲み込まない（スパイクで「例外を投げると無言で固まる」ことを確認済み）。
  process.on('unhandledRejection', (reason) => {
    const message = reason instanceof Error ? (reason.stack ?? reason.message) : String(reason)
    console.error('[desktop] 起動に失敗しました\n' + message)
    dialog.showErrorBox('Kanean を起動できませんでした', message)
    app.exit(1)
  })
}
