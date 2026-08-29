## Why

起動にターミナルが要る。`pnpm --filter @kanean/server dev` と `pnpm --filter @kanean/web dev` を
手で叩かないと使えないのは、日常の会計アプリとして無理がある。**アイコンで起動したい。**

もう一つ、ホスト運用をやめた（[[local-single-user-pivot]]・VPS 終了）ことで、
「この URL 見てみて」と人に渡す手段が消えた。デスクトップアプリにすれば渡せる。

そして重要な前提の変更がある。ホストするために HTTP サーバを作ったが、**デスクトップアプリなら
SQLite はアプリの起動中だけ触れれば足りる**。アプリを終了したあとに常駐プロセスやリスナーが
残っているのは、このアプリの性格（ローカル・単一利用者・認証なし）に照らして正しくない。

配布形態は [[local-single-user-pivot]] で Tauri と決めていたが、本 change で **Electron に変更する**
（理由は design.md。要約: Tauri のバックエンド Rust には JS ランタイムが無く node の子プロセスが
構造的に不可避で、「終了後に何も残さない」という要件に真正面から反する）。

## What Changes

- **`packages/desktop` を新設**（Electron）。アイコン起動、単一プロセス、ウィンドウを閉じれば全部消える。
- **Hono を Electron main プロセス内で動かす**。`app.fetch(request)` を直接呼ぶ。
  Hono は `Request → Response` の関数であり、HTTP サーバは入口の一形態にすぎない。
  **既存の 136 ルート・drizzle・better-sqlite3・pdf-lib は一切変更しない。**
- **UI はカスタムプロトコル経由**（Electron `protocol.handle`）。TCP を一切開かずに
  `fetch` / `<a href download>` / `<a target="_blank">` / pdf.js のすべてが従来どおり動く。
  エクスポート zip の**ストリーミング（メモリに載せない）配慮を維持する**。
- **ローカル連携は unix domain socket**（`$DATA_DIR` 配下）。**アプリ起動中だけ存在する**。
  ポート番号を持たないので衝突せず、ソケットファイルの有無で「起動中か」が判別できる。
  取込スキル（acquisition）はここへ繋ぎ、将来の MCP サーバも同じ口を使う。
- **BREAKING**: パッケージ版デスクトップアプリは `127.0.0.1:10140` の **TCP 待ち受けを持たない**。
  acquisition スキルの接続先を socket へ変更する（`.claude/skills/acquisition/SKILL.md`）。
  開発時（`pnpm --filter @kanean/server dev`）は従来どおり TCP を使う。
- **macOS 向けの署名・notarize・dmg 配布**（Apple Developer アカウントは取得済み）。
- 方針転換の反映: `CLAUDE.md` / `openspec/config.yaml` / `docs/architecture.md` §12 の
  「Tauri デスクトップ化」「VPS デプロイ」記述を実態に合わせる。

### Non-goals

- **MCP サーバ本体**（次の change）。本 change はその接続口となる socket を用意するところまで。
- **Windows / Linux 配布**。socket は Windows では named pipe になるため、対応時に別途扱う。
- **帳簿受け渡しプロトコル**（roadmap Phase 6）。配布が成立してから。
- **自動更新**。まず手渡しで配れることを優先する。

## Capabilities

### New Capabilities

- `desktop-app` — デスクトップアプリとしての起動・寿命・配布の振る舞い

### Modified Capabilities

- `local-access` — アクセス境界の再定義。「127.0.0.1 への TCP 待ち受け」から
  「プロセス内配信 ＋ アプリ寿命に縛られたローカルソケット」へ。防壁の性質が変わるため、
  既存の3要件のうち2件（ループバック限定の待ち受け／取込スキルの呼び出し境界）を改訂する。

## Impact

**新規**
- `packages/desktop/` — Electron main / preload / ビルド設定（electron-builder）

**変更**
- `packages/server/src/index.ts` — Hono アプリの構築と `serve()` の起動を分離する
  （現状は module 読み込み時に `serve()` を呼ぶ。既に `export { app }` はしている）
- `packages/web/src/api.ts` — API のパス基点。`req()` と `bookQuery()` に集約済みなので影響は局所
- `packages/web/src/pages/SettingsTab.tsx` / `pages/JournalTab.tsx` / `pages/forms/PdfFormPreview.tsx`
  — ブラウザネイティブ GET の3箇所（zip・証憑・様式PDF）
- `.claude/skills/acquisition/SKILL.md` — 接続先（`KANEAN_BASE_URL` の既定）
- `CLAUDE.md` / `openspec/config.yaml` / `docs/architecture.md`

**依存**
- 追加: `electron`, `electron-builder`, `@electron/rebuild`
- `better-sqlite3` はネイティブアドオンのため **Electron ABI 向けの再ビルドが必須**（スパイク対象）

**リスク**
- 本 change は**2つのスパイクの結果に依存する**（tasks.md §1）。
  スパイクが赤なら設計を差し戻す。実装タスクはゲート通過後に着手する。
