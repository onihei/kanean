## 1. スパイク（ゲート。ここが緑になるまで §2 以降に着手しない）

- [x] 1.1 スパイク A: Electron 上で `better-sqlite3` が SQLite を開いて読み書きできることを確認する
      → **11.10.0 は不可**（Node ABI 137 / Electron 43 ABI 148、プレビュー無し 404、V8 API 変更でソースビルドも不可）。
      **13.0.3 は同一バイナリで両ランタイム緑**（Node-API 移行のため）。design.md「Spike Results」参照
- [x] 1.2 スパイク A: `.backup()`（WAL 整合オンラインバックアップ）が Electron 上でも動くことを確認する（[[data-ops]] のバックアップ／エクスポートが依存しているため）
      → Node 24 / Electron 43 の**両方で緑**
- [x] 1.3 スパイク A: ABI の扱いを確定し design.md へ追記する
      → **リビルド機構は不要**という結論に変わった（Decision 6）。`@electron/rebuild` は採用しない
- [x] 1.3b `better-sqlite3` を 11.10.0 → 13.0.3、`@types/better-sqlite3` を 7.6 → 9.6 へ上げ、回帰を確認する
      → `pnpm build` / `pnpm test`（65ファイル 543テスト passed）/ `pnpm typecheck` / `pnpm lint` すべて緑
- [x] 1.4 スパイク B: `protocol.registerSchemesAsPrivileged` ＋ `protocol.handle` で Hono の `app.fetch` を配線し、JSON API が `fetch` で呼べることを確認する
      → 200 / Hono の Response がそのまま通る。`X-Book-Id` と `?bookId=` も両方到達
- [x] 1.5 スパイク B: `<a href download>` が保存され、**zip 全体をメモリに載せずに**書き出されることを確認する
      → `will-download` 発火・512MB `completed`・**RSS +71MB のみ**＝ストリーミング維持
- [x] 1.6 スパイク B: 送出完了時・中断時に一時 zip が削除されることを確認する
      → 完了時・`cancel()` 時とも残存 0
- [x] 1.7 スパイク B: `target="_blank"` の証憑表示と pdf.js プレビューが動くことを確認する
      → 子ウィンドウ生成 ✓（`setWindowOpenHandler` の許可が必須）・pdf.js 6.0.227 のモジュールワーカーが
      カスタムスキームから読め 3ページ実描画 ✓・cmap/standard_fonts の配信 ✓。
      **限界**: 官製様式PDFがリポジトリに無いため「実物が cMap を要求する」端から端までの確認は §7.4 へ送る
- [x] 1.8 **ゲート判定**: A・B とも**緑**。設計は差し戻さず続行する。
      A は設計を簡素化（`@electron/rebuild` 不要）、B は当初の想定どおり成立。design.md「Spike Results」に記録

## 2. 決めること（実装前に確定させる）

- [x] 2.1 ウィンドウを閉じたときの挙動を決める
      → **閉じたら終了**（Dock に残す例外を入れない）。HIG 違反ではない。design.md Decision 7。
      [[desktop-app]] に「ウィンドウを閉じると終了する」シナリオを追加済み。
      帰結（処理中の取込も切断される）を design に明記
- [x] 2.2 ローカルソケットの配置と命名を決める。macOS のパス長上限を満たすことを確認する
      → **`$DATA_DIR/kanean.sock`**。実測で上限は **104バイト（105 で EINVAL）**、候補配置は 44〜67 で収まる。
      起動時にパス長を検証してエラーを出す方針を design.md に記録

## 3. サーバの分離（Electron から呼べる形にする）

- [x] 3.1 `packages/server/src/app.ts` に Hono アプリの構築を切り出した（`createApp()`。`serve()` を module 読み込み時に呼ばない）
- [x] 3.2 `createApp()` が `migrateControlDb()` → `getRouter()` → `ensureAtLeastOneBook()` を含み `{ app, router }` を返すことを確認した
      （静的配信は Node 固有なので `index.ts` 側に残し、デスクトップはカスタムプロトコルで配る）
- [x] 3.3 `pnpm --filter @kanean/server start` が従来どおり `127.0.0.1:10140` で動くことを確認した
      → `/health` に `dataDir` 込みで応答・`マイ帳簿` 自動作成・**LAN アドレス(192.168.x)からは到達しない**（[[local-access]] の不変条件）
- [x] 3.4 既存のサーバテストが全て緑であることを確認した（65ファイル 543テスト。core 119 / web 17 / shared 14 も緑）

## 4. Electron シェルの骨格

- [x] 4.1 `packages/desktop` を作った（Electron main + `protocol.ts`）。turbo の build / typecheck / lint に載っている。
      **preload は不要**（IPC を使わずカスタムプロトコルで配るため。`contextIsolation: true` / `nodeIntegration: false`）
- [x] 4.2 main プロセスで `createApp()` を動的 import して Hono を同一プロセス内に構築する
      （`DATA_DIR` 確定後に読み込むため静的 import にしない）
- [x] 4.3 ウィンドウを開き、`window-all-closed` → `app.quit()` を実装した（Decision 7）。
      **実機確認済み**（利用者がウィンドウを閉じ、プロセスもソケットも残らないことを確認）
- [x] 4.4 単一インスタンス化した → 2つ目の起動が**1秒で終了**（ウィンドウを開かず）、1つ目は生存
- [x] 4.5 `DATA_DIR` は「環境変数があればそれ、無ければ **`<userData>/data`**」に決めた。
      必ず絶対パスへ固定する（パッケージ後は `pnpm-workspace.yaml` が無く cwd も不定で、server 既定の `./data` 解決が破綻するため）。
      実装中に2件の不具合を発見して修正: (a) `app.setName('Kanean')` を入れないと
      `~/Library/Application Support/@kanean/desktop/` になる（スコープ名の漏れ）、
      (b) `userData` 直下は Chromium の Cache/Local Storage と同居するので会計データは `data/` に隔離する
- [x] 4.6 `electron .` で起動し、帳簿の自動作成とUI描画まで到達することを確認した
      （`control.sqlite` + `books/{ulid}.sqlite` 生成・React マウント・console エラー 0）。
      **アイコンからの起動は §8.4（パッケージ後）で確認する**

## 5. カスタムプロトコルによる UI 配信

- [x] 5.1 `protocol.registerSchemesAsPrivileged` と `protocol.handle` を配線し、UI と `/api/*` を同一スキーム（`kanean://local/`）から配信する
- [x] 5.2 `packages/web` のビルド成果物を同一スキーム配下から配信する（SPA フォールバック付き・パストラバーサル遮断）
      → pdf.js のデコード資材も取得可（`cmaps/UniJIS-UCS2-H.bcmap` 25,439B）
- [x] 5.3 API パスの基点 → **変更不要だった**。UI を同一オリジンから配るため `api.ts` の相対パス（`/api/…`）が
      そのまま解決される。ブラウザ実行時は Vite の proxy が同じ相対パスを受ける。`packages/web` に基点の分岐は入れていない
- [x] 5.4 ネイティブ GET の3箇所 → **いずれも変更不要**。実測で確認:
      エクスポート zip は `<a href download>` から **`kanean-export-20260812.zip` 226,007B を `completed`**、
      証憑 URL は 404（未登録なので正しい応答）、様式PDF は 400「開いている会計年度がありません」（データ未整備なので正しい応答。経路自体は到達）
- [x] 5.5 `PdfFormPreview.tsx` の `credentials: 'include'` を削除した
- [x] 5.6 2冊の状態で検証 → 指定なしは **400 `book_required`（候補付き）**、`X-Book-Id` は 200、`?bookId=` は 200
- [x] 5.7 Vite 開発ループを実起動で確認 → `http://127.0.0.1:5173/` 200、proxy 経由の `/api/books`・`/health` とも正常
- [x] 5.8 アプリ起動中に **TCP 10140 が開いていない**ことを確認した（[[local-access]]「パッケージ版は TCP を開かない」）

## 6. ローカルソケットと取込スキルの移行

- [x] 6.1 `packages/desktop/src/socket.ts` を追加。`getRequestListener()` を `http.createServer().listen(socketPath)` に繋いだ。
      electron に依存しないモジュールにしてテスト可能にした。パーミッションは `0600`（所有者のみ接続可）
- [x] 6.2 起動時に残存ソケットを掃除する（接続を試して ECONNREFUSED なら残骸と判定してから削除。生きていれば `SocketInUseError`）
- [x] 6.3 終了時にソケットが削除されることを実機で確認した（`before-quit` で close、`will-quit` で同期 unlink）
- [x] 6.4 5MB 超の `/skill/*` が socket 経路でも `413 {"error":{"code":"validation_error",...}}` になることを実機で確認した
- [x] 6.5 TCP 経路と socket 経路の一致をテストで固定した（`src/__tests__/socket.test.ts` 全7件緑）
- [x] 6.6 `.claude/skills/acquisition/SKILL.md` の接続先を socket 優先＋TCP フォールバックにした。
      **SKILL.md の bash ブロックをそのまま抽出して3状態（未起動 / デスクトップ / 開発 server）で実行し、文書と実挙動の一致を確認済み**
- [x] 6.7 `$BASE` を使う呼び出しを `"${CURL[@]}"` に移行（mufg / shinsei / ufjvisa の6箇所＋オーケストレータ4箇所）。
      amazon / rakuten は API を直接叩かない（オーケストレータ経由）ため変更不要だった
- [x] 6.8 実際の取込を1サイト以上で通し、draft が投入されることを確認した
      → **楽天で実取込に成功**（人がブラウザでログイン）。socket 経由で `POST /skill/ec/journal-candidates` → HTTP 200、
      `acceptedLines: 2` / `draftEntries: 2` / `skippedDup: 0` / `warnings: []`。
      帳簿に 借)事業主貸 8,778 / 貸)未払金(楽天) 8,778 と ポイント利用 借)未払金 237 / 貸)事業主借 237 が入り、
      **未払金の純額 8,541 が請求額と一致**（クリアリング連鎖・貸借 9,015 一致）

## 7. 回帰確認

- [x] 7.1 `pnpm build` / `pnpm test` / `pnpm lint` / `pnpm typecheck` すべて緑（**700テスト**: server 543 / core 119 / web 17 / shared 14 / desktop 7）
- [x] 7.2 **両ゴールデンをデスクトップ版の API 経由で検算し完全一致**（実帳簿に触れず別 DATA_DIR で実施）:
      マツダ2 = `{year:2023, depreciationAmount:439919, businessAmount:219960, closingBookValue:1}`、
      簡易課税 = `{taxBaseTotal:10000000, salesTaxNational:780000, deemedDeduction:390000, national:390000, local:110000, payable:500000}`
- [x] 7.3 帳票 CSV は既定 UTF-8+BOM（`charset=utf-8`）で lossy 警告は出ないのが正。
      Shift_JIS 変換は CSV エクスポートのみで、`charset=Shift_JIS` ＋ `x-export-lossy-chars: %F0%A0%AE%B7`（**𠮷**＝BMP外）を確認。
      CP932 で復号でき、当該文字だけ `?` に置換されている（髙 は CP932 にあるため変換成功）
- [x] 7.4 様式 PDF 6本すべて `%PDF` で生成（`blue-statement` 46KB / **`blue-statement-official` 2.28MB** /
      `consumption` 29KB / `consumption-official` 106KB / `income-tax` 38KB / `income-tax-official` 239KB）。
      **官製様式テンプレートが実在して描画できたので、§1.7(c) に残していた「実物での cMap 要求」の宿題もここで解消**
- [x] 7.5 フルデータエクスポート zip を別環境の `$DATA_DIR` に置いて読めることを**確認した結果、復元できないことが判明**。
      修正は別 change **`restorable-export`** へ切り出した（本 change のスコープ外）。
      → **⚠️ 仕様どおりに動かない（本 change の変更とは無関係の既存ギャップ）**。
      zip の中身は `manifest.json` ＋ `books/{id}.sqlite` のみで **control plane を含まない**。
      `books/` を別 `$DATA_DIR` に置いても control の帳簿レジストリに載らないため、
      `ensureAtLeastOneBook` が**新しい空帳簿を作り、エクスポートした帳簿は不可視**になる。
      孤児 `books/*.sqlite` を拾う仕組みは存在しない（`listBookDbFiles` は migrate と backup のみが使用）。
      [[data-ops]]「セルフホストへそのまま復元できる形にする」を満たしていない。**別 change で扱うか要判断**
- [x] 7.6 証憑のライフサイクルを確認（アップロード → SHA-256 記録 → `inline` + RFC5987 ファイル名で配信 → 削除で
      DB 行と `books/{bookId}/attachments/` の実体が**両方**消える）
- [x] 7.7 バックアップ CLI 動作確認（`control: ✓` / `books: 1/1 ✓` → `backups/2026-08-12T06-47-57-084`）

## 8. 配布

- [x] 8.1 サンプル帳簿は**用意しない**と決定（利用者判断）。渡す相手は身内で、最初から自分で操作させれば足りる。
      初回起動はアプリモード選択 → 空の帳簿から始まる導線をそのまま使う
- [x] 8.2 `electron-builder` で macOS 向けにパッケージした（`Kanean-0.0.0-arm64.dmg` 145MB / arm64）。
      **パッケージ版を実起動して検証済み**: migrations 適用・帳簿生成・マツダ2 ゴールデン一致
      （439,919 / 219,960 / 残高1）・官製様式PDF 2,280,334B 生成・**TCP 未使用**・終了でソケット消滅。
      同梱の要点: `extraResources` で `web/dist` → `resources/web`、
      `@kanean/server` の `migrations/`(51) と `assets/`（官製様式PDF3本＋ipaexg.ttf）が
      `import.meta.url` の相対位置を保って収まること、`asarUnpack` で better-sqlite3 を展開すること
- [ ] 8.2b 配布物の贅肉を落とす（electron-builder は依存の `files` フィールドを尊重せず、
      `@kanean/server` の `src/` `scripts/` `.turbo/` や better-sqlite3 の win32/linux prebuilds まで同梱される）
- [x] 8.3 署名と notarize を通した。
      証明書: `Developer ID Application: yuichiro hayashi (4SJP92TW4Y)`（利用者が Xcode で発行。
      **App Store Connect API キーでは発行できない** — Admin ロールでは 403
      `This operation can only be performed by the Account Holder.`）。
      notarize は **API キー**で実施（Apple ID＋App用パスワードは不要）。
      検証: `codesign --verify --deep --strict` OK / `spctl -a -t exec` → **accepted, Notarized Developer ID** /
      .app は staple 済み。**dmg 自体は electron-builder が staple しない**ので `notarytool submit` →
      `stapler staple` を別途実施（オフラインで開かれても検証できるようにするため）
- [x] 8.4 配布物の成立を確認した。
      隔離属性（`com.apple.quarantine`）を付けた dmg が**警告なくマウント**し、中の .app が
      `accepted / Notarized Developer ID`。dmg から取り出したアプリを **`env -i`（node も pnpm も PATH に無い）**で
      起動し、帳簿自動作成・会計年度作成・**手入力仕訳**・試算表・官製様式PDF(2.28MB) まで動作。
      TCP 未使用・終了でソケット消滅。※ 物理的に別マシンでの確認は未実施（自己完結性は env -i で担保）

## 9. ドキュメントと方針の反映

- [x] 9.1 `CLAUDE.md` を更新（デプロイ節 →「配布（Electron）」・冒頭のアクセス境界・DATA_DIR 既定・
      構成に `desktop/` 追加・起動コマンド追加）
- [x] 9.2 `openspec/config.yaml` の context を Electron に改め、`packages/desktop` を構成へ追記
- [x] 9.3 `docs/architecture.md` に **§12.0 デスクトップアプリ（現行）** を新設。
      旧 VPS 構成は §12.1〜12.2 に残置と明示。同梱が要る資産（migrations / assets / asarUnpack）と
      `Developer ID Application` の要件も記載
- [x] 9.4 `docs/roadmap.md` Phase 6 に本 change の位置づけを記録。
      **MCP サーバの接続点＝ローカルソケット**、および派生した `restorable-export` を明記
- [x] 9.5 記憶を更新: [[local-single-user-pivot]] に Tauri→Electron の逆転理由（要件3との構造的な不整合・
      「Rust 書き直しが要る」は誤解だった点）を追記。[[better-sqlite3-node-rebuild]] に
      Node-API 化で Electron 向けリビルドが不要になったことを追記。MEMORY.md の索引も更新
