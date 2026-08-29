## Context

現状の起動は `pnpm --filter @kanean/server dev` ＋ `pnpm --filter @kanean/web dev` ＋ ブラウザ。
サーバ（Hono, `127.0.0.1:10140`）は**ホスト運用のために作られた**遺産であり、
デスクトップアプリでは SQLite をアプリ起動中だけ操作できれば足りる。

利用者からの要件は3つ。
1. **アイコンで起動したい**（今日の痛み）
2. **人に渡したい**（ホストをやめて失われた導線の代替。Apple Developer は取得済み）
3. **終了後に何も常駐していてほしくない**（Blender の MCP サーバのように、アプリが生きている間だけ）

要件3が技術選定を決めた。

## Goals / Non-Goals

**Goals**
- ターミナルなしの起動・終了
- 終了後にプロセス／リスナー／一時ファイルを残さない
- 既存の 136 ルート・core・drizzle・pdf-lib・better-sqlite3 を書き換えない
- 取込スキル（acquisition）を生かしたまま移行する
- 署名済み dmg を手渡しできる

**Non-Goals**
- MCP サーバ本体（次の change。本 change は接続口の socket まで）
- Windows / Linux 配布
- 自動更新
- `packages/web` の状態管理・画面構成の変更

## Decision 1: Tauri ではなく Electron

[[local-single-user-pivot]] では Tauri と決めていた。理由はバイナリサイズだった。**これを覆す。**

Tauri のバックエンドは Rust であり、**JS ランタイムを持たない**。したがって既存の
TypeScript サーバ（Hono + drizzle + better-sqlite3 + pdf-lib）を動かすには
**node をサイドカー子プロセスとして生やす以外に方法がない**。

```
Tauri                                  Electron
─────────────────────────────          ─────────────────────────────
[Rust プロセス] ──spawn──▶ [node]      [main プロセス = node]
   窓                        Hono        ├─ Hono を app.fetch() で直接呼ぶ
   │                          │          ├─ better-sqlite3
   └──── TCP :port ───────────┘          └─ BrowserWindow

プロセス2つ。クラッシュ・強制終了時の      プロセス1つ。窓を閉じれば全部消える
孤児 node を自分で面倒みる責任が残る
```

つまり **Tauri は「終了後に何も残さない」を構造的に難しくする**。要件3に真正面から反する。
Electron は main プロセスが Node そのものなので、アプリとサーバが1プロセスに畳まれ、
監視も後片付けも不要になる。

**Tauri を選ぶ動機だったサイズ優位も、この構成では大きく目減りする**（node を同梱する以上、
「Rust だけの Tauri」の軽さは得られず、差は WKWebView と Chromium の分に縮む）。

Electron の代償は RAM とバンドルサイズだが、**必要なときだけ開くローカル会計アプリ**では
最も影響の小さいコストである（Electron の評判の悪さは常駐型アプリの文脈のもの）。

**却下**: Rust への全面書き換え — core/server と pdf-lib エコシステムを失う。論外。

## Decision 2: Hono をプロセス内で呼ぶ（`app.fetch`）

Hono の本体は `Request → Response` の関数であり、HTTP サーバは入口の一形態にすぎない
（`@hono/node-server` の `serve()` は Node の http をそこへ繋ぐアダプタ）。
`packages/server/src/index.ts:88` は既に `export { app }` している。

したがって **UI 経路に TCP は不要**。ルートは1行も書き換えない。

必要な作業は「アプリの構築」と「`serve()` の起動」の分離だけ。現状 `index.ts` は
module 読み込み時に `serve()` を呼ぶので、構築部分を別モジュールへ切り出す。

## Decision 3: UI は手書き IPC ではなくカスタムプロトコル

当初は `ipcRenderer.invoke` によるブリッジを想定したが、**`packages/web` の API アクセスを
実測したところ3種類あり、素朴な IPC 化は退行になる**ことが分かった。

| | 実体 | 場所 | 素朴な IPC 化 |
|---|---|---|---|
| A. JSON | `req()` → `json<T>()` | `api.ts`（ほぼ全部） | ◎ |
| B. Blob DL | `downloadCsv()`（CSV も PDF も同経路） | `api.ts:1290` | ○ |
| C. ネイティブ GET | `<a href>` / pdf.js | **3箇所** | ✕ URL が要る |

C の内訳と、素朴な IPC 化で起きる退行:

- `pages/SettingsTab.tsx:94` — エクスポート zip。ソース中のコメントが
  **「fetch+blob だと zip 全体をメモリに載せてしまうため、`<a href>` のネイティブダウンロード」**
  と明記している。IPC に寄せると**この配慮が消える**。
- `pages/JournalTab.tsx:301` — 証憑を `target="_blank"` で別窓表示。URL が要る。
- `pages/forms/PdfFormPreview.tsx:45` — 様式 PDF を `fetch` → `arrayBuffer()` → pdf.js。

**採用**: Electron の `protocol.handle(scheme, handler)`。独自スキームのリクエストを
main プロセスの `Request → Response` 関数へそのまま渡せる。Hono はまさにその形をしている。

```js
protocol.handle('app', (request) => honoApp.fetch(request))
```

これで A / B / C のすべてが**従来のコードのまま**動く。`<a href download>` も
`target="_blank"` も pdf.js も、そして **zip のストリーミングも維持される**。
`packages/web` の変更は API パスの基点だけになり、手書きブリッジは不要。

前提となる設定:
- `protocol.registerSchemesAsPrivileged` で `standard` / `supportFetchAPI` / `stream` を立てる
  （どれか欠けると fetch かストリーミングが効かない）
- UI 自体も同一スキーム配下から配信すれば同一オリジンとなり、CORS は不要
- pdf.js の worker・cMap・wasm・standard_fonts も同一スキーム配下（`import.meta.env.BASE_URL` 経由）

**副次的な掃除**: `PdfFormPreview.tsx:45` の `credentials: 'include'` は認証廃止後に
意味を失っており、カスタムスキームでも無意味なので削除する。

**実装後の訂正（§5 実測）**: 当初は「`packages/web` の API パス基点を切り替える必要がある」と
見積もっていたが、**変更は不要だった**。UI 自体を同一スキーム（`kanean://local/`）から配るため、
`api.ts` の相対パス `/api/…` も `<a href="/api/export">` もそのまま解決される。
ブラウザ実行時は Vite の proxy（`/api`・`/health` → `127.0.0.1:10140`）が同じ相対パスを受けるので、
**両実行環境で同一のコードが動く**。web 側に実行環境の分岐を持ち込まずに済んだ。
実際に変更したのは上記 `credentials: 'include'` の削除 1 箇所のみ。

## Decision 4: ローカル連携は unix domain socket

UI 経路から TCP を消しても、**外部プロセスからの連携経路は依然として必要**である。

- **acquisition スキル**: `.claude/skills/acquisition/SKILL.md:42` が
  `BASE="${KANEAN_BASE_URL:-http://127.0.0.1:10140}"` で curl を叩いている
- **MCP**（次の change）: Blender-MCP の構造は「アプリ内でソケットが待ち受け、
  MCP クライアントが起動する stdio シムがそこへ繋ぐ」。**起動中のリスナーが要る**

TCP ポートではなく **unix domain socket** を選ぶ理由:

- ポート番号がない → 10140 の衝突も、開いているポートのスキャンも起きない
- `$DATA_DIR` 配下のファイルとして存在し、**アプリ終了で消える**
- **存在＝起動中**が目で確認でき、要件3を利用者が検証できる
- `curl --unix-socket <path> http://localhost/skill/...` で叩ける
  → acquisition スキルは `BASE` の定義まわりの変更で生き残る

```
Electron main プロセス ── アプリ起動中のみ存在
 │
 ├── Hono app（Request → Response）
 │     ├─◀── protocol.handle(...)                ← UI。TCP なし・ストリーム保持
 │     └─◀── unix socket $DATA_DIR/*.sock        ← acquisition / 将来の MCP
 │
 └── better-sqlite3 ──▶ books/{id}.sqlite

窓を閉じる → プロセス消滅 → ソケット消滅 → 何も残らない
```

**UI 経路と外部連携経路が分離される**のがこの設計の要点。UI はプロセス内で完結し、
外に口を開けるのは「Claude に触らせたい部分」だけになる。

実装上の注意:
- `@hono/node-server` の `serve()` がソケットパス待ち受けを直接受けない場合は、
  `getRequestListener()` を `http.createServer().listen(path)` に繋ぐ
- 異常終了で残った socket ファイルは起動時に掃除する（spec の該当シナリオ）

**配置の決定（task 2.2・実測済み）**: `$DATA_DIR/kanean.sock`。

macOS の `sun_path` 上限を実測したところ **104 バイトちょうどまで bind 可、105 で `EINVAL`**。
候補となる配置はいずれも収まる:

| 配置 | 長さ | |
|---|---|---|
| dev `./data` | 58 | OK |
| `~/data/kanean` | 44 | OK |
| Electron `userData`（`~/Library/Application Support/Kanean`） | 67 | OK |

余裕はあるが無限ではない（利用者が深い `DATA_DIR` を指定しうる）ため、
**起動時にパス長を検証して超過なら明示的なエラーを出す**（黙って起動失敗させない）。

## Decision 5: 開発時の TCP は残す

`pnpm --filter @kanean/server dev` ＋ Vite(5173) の開発ループと、
既存のサーバテストを壊さないため、**開発時は従来どおり `127.0.0.1:10140` で待ち受ける**。

TCP を持つのは開発時のみ、パッケージ版は持たない、という2モードになる。
`local-access` の不変条件（TCP を開くならループバック限定・設定で覆せない）は
両モードで維持されるため、安全性の後退はない。

**却下した代案**: パッケージ版も ephemeral port で TCP 待ち受けし、ポート番号を
`$DATA_DIR/runtime.json` に書く。モードが1つで済むが、(a) ポートが開く、
(b) クライアントがポートファイルを読む手間、(c) 「存在＝起動中」の分かりやすさが失われる。

## Decision 6: better-sqlite3 を 13.x へ上げる（スパイク A の結論）

**スパイク A の実測により、当初想定していた `@electron/rebuild` は不要になった。** 経緯は
「Spike Results」に記す。結論だけ述べる。

- Node 24 の ABI は **137**、Electron 43 は **148**。better-sqlite3 **11.10.0 は Electron 43 で動かない**。
- pnpm は同一バージョンを**1つの物理コピー**に集約する（`node_modules/.pnpm/better-sqlite3@…/`）。
  server と desktop はそこへの symlink なので、`@electron/rebuild` で Electron ABI に焼き直すと
  **Node 側の開発ループ（vitest / tsx / CLI）が同時に壊れる**。2つの ABI を併存させる小細工が要る。
- しかし **better-sqlite3 13.0.0 が Node-API（node-addon-api ^8）へ移行した**。Node-API は
  ABI 安定なので、**同一バイナリが Node 24 と Electron 43 の両方で動く**。
  プレビルドは GitHub Release ではなく tarball 同梱（`prebuilds/darwin-arm64.node` のように
  **ABI 番号を持たない** 命名）に変わった。

したがって採用は「**better-sqlite3 を 11.10.0 → 13.0.3 に上げ、リビルド機構を一切持たない**」。
`@electron/rebuild` は依存から落とす。[[better-sqlite3-node-rebuild]] の「ABI 不一致なら
`pnpm rebuild`」という運用知識は、この upgrade 後は Electron に関しては不要になる。

**却下**: Electron を ABI ≤135（Electron 36 相当）に落として 11.10.0 のプレビルドを使う。
プレビルドは実在するが、配布する金銭データを扱うアプリでセキュリティ更新の切れた Electron に
固定するのは割に合わない。

## Spike Results

### スパイク A — better-sqlite3 × Electron ABI: **緑**（ただし upgrade が条件）

実測の順に記す。

1. **ベースライン**: Node 24.14.0 / ABI 137 で 11.10.0 は緑（open / WAL / write / read / `.backup()`）。
2. **Electron 43.4.0 / ABI 148 で 11.10.0 は失敗**:
   `NODE_MODULE_VERSION 137 ... requires 148`。エラーが指すのは `.pnpm` の**共有物理コピー**であり、
   「片方を直すと他方が壊れる」構造が実物で確認できた。
3. **プレビルドは存在しない**: `better-sqlite3-v11.10.0-electron-v148-darwin-arm64.tar.gz` は **404**。
   v11.10.0 が公開する Electron ABI は v116〜v135 まで。
4. **ソースビルドも通らない**: Electron 43 のヘッダに対して node-gyp が 14 エラー。
   V8 の API 変更（`External::Value()` が `ExternalPointerTypeTag` 必須化）による**非互換**であり、
   ツールチェーンの問題ではない。→ **11.x を Electron 43 で使う道は塞がっている**。
5. **13.0.3 は両方で緑**: 同一の物理モジュールで
   - Node 24 (ABI 137): open / WAL / write / read=659,880 / **`.backup()` ok**
   - Electron 43 (ABI 148): open / WAL / write / read=659,880 / **`.backup()` ok**
6. **リポジトリ全体の回帰も緑**: 11.10.0 → 13.0.3 に上げて
   `pnpm build` / `pnpm test`（**65ファイル 543テスト全passed**）/ `pnpm typecheck` / `pnpm lint`。
   `@types/better-sqlite3` は 7.6 → 9.6 に追随。drizzle-orm 0.38.4 の peer は `better-sqlite3 >=7` で充足。
7. **破壊的変更の影響なし**: 12.0.0 は EOL の Node 18・Electron 26/27/28 を落としただけ（本リポジトリは Node 24）。
   13.0.0 は N-API 移行と**追加 API のみ**（`db.explain()` / `stmt.toString()`）。
   本リポジトリが使う `new Database(file, {readonly, fileMustExist})` / `.pragma()` / `.exec()` /
   `.prepare()` / `.transaction()` / `.backup()` / `.close()` はすべて健在。

**結論**: ゲート通過。かつ設計を**簡素化**する（リビルド機構が丸ごと不要になった）。

### スパイク B — `protocol.handle` × 3クラスの API アクセス: **緑**

`registerSchemesAsPrivileged({ standard, secure, supportFetchAPI, stream, corsEnabled })` ＋
`protocol.handle(SCHEME, (request) => app.fetch(request))` に **本物の Hono** を繋いで実測した。

| 検証 | 結果 |
|---|---|
| **1.4** JSON API を `fetch` | `200` / `{ok:true, from:"hono"}`。Hono の `Response` がそのまま通る |
| 帳簿解決 | `X-Book-Id: h456` と `?bookId=q123` が**両方**ハンドラに到達（[[books]] の解決順が壊れない） |
| クラス B のヘッダ読取 | `X-Export-Lossy-Chars` を `res.headers.get()` で取得可（`downloadCsv` の Shift_JIS 警告が維持できる） |
| **1.5** `<a href download>` | `will-download` 発火。`filename*=UTF-8''` を解釈して `kanean-export.zip`。`completed` |
| **1.5 ストリーミング（心臓）** | **512MB を送出して RSS 130MB → 201MB**（+71MB）。全展開なら +512MB になるはずで、**バッファリングされていない** |
| **1.6** 完了時の掃除 | 一時ファイル残存 **0** |
| **1.6** 中断時の掃除 | レンダラが `body.cancel()` した際に `ReadableStream.cancel()` が発火し掃除される。残存 **0** |
| **1.7(a)** `target="_blank"` | 子ウィンドウが実際に生成され `kanean://local/api/…` を読み込んだ |
| **1.7(b)** pdf.js | `/pdfjs-lib/pdf.mjs` を動的 import 成功（6.0.227）。**モジュールワーカーがカスタムスキームから読める**（fake worker 警告なし）。3ページとも実描画（非白ピクセル 3238/3352/2466） |
| **1.7(c)** デコード資材 | `cmaps/UniJIS-UCS2-H.bcmap`(25,439B)・`standard_fonts/LiberationSans-Regular.ttf`(139,512B) をカスタムスキーム経由で取得可 |

**実装上の注意（スパイクで判明）**
- `target="_blank"` は Electron が**既定で拒否する**。`webContents.setWindowOpenHandler` で
  明示的に `{ action: 'allow' }` を返す必要がある（証憑の別窓表示がこれに該当）。
- `protocol.handle` のハンドラ内で例外を投げると**黙って固まる**（ウィンドウも出ない）。
  main 側に `unhandledRejection` の受けを必ず置く。

**証明できていないこと（正直な限界）**
- 1.7(c) は「**カスタムスキームがその資材を配れる**」ことの確認であって、
  「官製様式 PDF が実際に cMap/wasm を要求し、それが解決される」ことの端から端までの確認ではない。
  合成 PDF（埋め込みサブセット TrueType ＋ base-14）では pdf.js が資材を要求しなかったため。
  **官製様式 PDF はリポジトリに無い**ので、この端から端までの確認は §7.4（実物での回帰）で行う。

## Decision 7: ウィンドウを閉じたら終了する（task 2.1）

`window-all-closed` で `app.quit()` する。macOS 慣習の「Dock に残す」例外は**入れない**。

- 要件3（終了後に何も残っていてほしくない）を厳格に読むとこちらが素直。
  ウィンドウが無いのにプロセスとソケットが生きている状態を作らない。
- macOS HIG 上も違反ではない。ドキュメントベースでない単一ウィンドウのアプリが
  ウィンドウを閉じて終了するのは許容されるパターンである
  （`darwin` 例外は Electron のボイラープレートであって規約ではない）。

**帰結（受け入れる）**: ウィンドウを閉じるとローカルソケットも即座に消えるため、
**取込スキルや MCP のリクエストが処理中でも切断される**。「ウィンドウは閉じたいが
Claude の取込は続けたい」は成立しない。要件3と引き換えの仕様である。

処理中の切断をどう扱うか（警告を出す／完了まで終了を遅らせる）は §6 の実装時に判断する。
現時点では **黙って切る**のではなく、少なくとも取込側が「アプリが起動していない」と
判別できること（[[local-access]] の該当シナリオ）を満たせばよいとする。

## Risks

| リスク | 影響 | 扱い |
|---|---|---|
| ~~**better-sqlite3 の Electron ABI**~~ | ~~全体が成立しない~~ | **解消**（スパイク A）。13.x の Node-API 移行によりリビルド不要。Decision 6 |
| better-sqlite3 11→13 の後退 | 会計データの読み書き | 回帰スイート 543 テスト緑で確認済み。以後の変更でも `pnpm test` を通す |
| **`protocol.handle` のストリーミングと `<a download>`** | export zip がメモリ載せに退行／保存ダイアログが出ない | **スパイク B**。設計の心臓。確信が持てていないので実測が先 |
| export の切断時クリーンアップ | `$DATA_DIR/tmp/` に zip が残る | スパイク B で併せて確認（[[data-ops]] の該当シナリオ） |
| socket パス長上限（macOS） | 深い `$DATA_DIR` で起動不能 | 起動時に検証してエラーを出す |
| acquisition スキルの移行漏れ | 取込が黙って動かなくなる | 5サイト分の SKILL.md を一括で移行し、実接続で確認 |

**スパイク A・B が両方緑になるまで実装タスクに着手しない**（tasks.md §1 がゲート）。
赤なら設計を差し戻す（B が赤の場合の退避先は「パッケージ版も ephemeral port の TCP」）。

## Open Questions

- ~~サンプル帳簿の要否~~ → **不要と決定**（2026-08-12）。渡す相手は身内であり、最初から自分で
  操作してもらえば足りる。初回起動のアプリモード選択 → 空の帳簿という既存導線をそのまま使う。
- ウィンドウを閉じたときアプリを終了するか、macOS 慣習どおり Dock に残すか。
  要件3（常駐が気持ち悪い）を厳格に読むなら**閉じたら終了**が素直。

## 実装中に見つかった不具合（記録）

### `app.getName()` がスコープ名を漏らす

`app.getPath('userData')` は `app.getName()` に依存し、既定では package.json の `name` が使われる。
本パッケージ名は `@kanean/desktop` なので、**会計データの置き場所が
`~/Library/Application Support/@kanean/desktop/` になっていた**（`@kanean` という
ディレクトリがユーザーの Application Support 直下に作られる）。

対策: `app.setName('Kanean')` を **`getPath('userData')` を読む前に**呼ぶ。
package.json にも `productName: "Kanean"` を置く（electron-builder 用）。

### userData 直下は Chromium の作業領域と同居する

`userData` 直下には Electron/Chromium 自身が `Cache` / `GPUCache` / `Local Storage` /
`Session Storage` / `Preferences` などを作る。ここに `control.sqlite` と `books/` を
並べると、バックアップ・エクスポート・手動退避のときに**どれが自分のデータか判別できない**。

対策: 会計データは必ずサブディレクトリへ隔離する → 既定 `DATA_DIR` は
**`<userData>/data`**（= `~/Library/Application Support/Kanean/data`）。
ローカルソケットはその配下の `kanean.sock`（72 バイト。上限 104 に収まる）。
