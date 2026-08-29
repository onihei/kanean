# Kanean — 開発ガイド

個人事業主向けの確定申告/会計システム（青色申告・簡易課税・固定資産・家事按分）。
**ローカル単一ユーザー**のアプリ（認証なし）。アクセス境界は到達性そのもの＝デスクトップ版は
カスタムプロトコル＋unix socket で **TCP を開かない**、開発時のみ `127.0.0.1` 限定バインド。
設計は `docs/` を正とする（実装より docs が優先）。

## 構成（TSモノレポ / pnpm + turbo）

```
packages/
  shared/   型＋純粋ユーティリティ（金額 Yen 型・CSV・アプリリンク。Node 依存は ./node サブパスに隔離）
  core/     純関数の会計ドメイン（税・償却・残高）。ゴールデンテスト対象。I/Oなし
  server/   Hono + Drizzle + better-sqlite3。取込・仕訳・帳票
  web/      React + Vite
  acquisition/  巡回コア（sites/=巡回手順の唯一の実体 + playwright/electron の2実行殻）
  desktop/  Electron シェル。Hono を同一プロセスで動かしカスタムプロトコルで配信
  mcp/      MCP ブリッジ（.mcpb 同梱配布。unix socket 経由で server の API を呼ぶ）
```

## データ配置（重要）

- DBは **SQLite**。配置は `DATA_DIR` 環境変数で外出しする（コード配下に置かない）。
  - デスクトップ版（既定）: `<userData>/data` = `~/Library/Application Support/Kanean/data`
  - 開発: `DATA_DIR=./data`（`.gitignore` 済み）
  - `DATA_DIR` を明示すれば常にそちらが優先（検証・移行用）
- control plane = `$DATA_DIR/control.sqlite`（帳簿レジストリ `books` ＋ `backup_status` ＋ `app_settings`）
- data plane = `$DATA_DIR/books/{book_id}.sqlite`（帳簿ごとの会計データ。複数帳簿を持てる）
- 物理ファイル分離なのでクエリに帳簿条件は不要（[docs/architecture.md] §4）
- 対象帳簿は `X-Book-Id` ヘッダ →`?bookId=` →**アクティブが**1冊なら暗黙 →400 の順で解決（[docs/architecture.md] §5）
- 帳簿の**削除は無い**。使わない帳簿は `books.archived_at` でアーカイブ＝一覧から下げるだけで、
  データファイルは残り復帰できる（アーカイブ済みは参照可・更新は 409）
- アプリモード `app_settings.app_mode`（`personal`＝じぶんの帳簿 / `office`＝事務所）が起動導線と
  UI の露出範囲を決める。帳簿解決の規約は変えない

## コマンド

```
pnpm install
pnpm build        # turbo: shared → core → server/web
pnpm test         # vitest（各パッケージ）
pnpm lint         # eslint flat config
pnpm typecheck    # tsc --noEmit / tsc -b
pnpm --filter @kanean/server dev   # server 開発起動（--env-file=../../.env）
pnpm --filter @kanean/web dev      # web 開発起動（Vite）
pnpm dev:app                         # デスクトップ開発ループ（web/desktop build + MCP バンドル + electron）
```

## 規約

- 金額は**円整数**。`@kanean/shared` の `Yen` 型を使い、浮動小数点で持たない（[docs/architecture.md] §7）。
- 会計計算は `packages/core` の**純関数**に隔離し、I/Oを混ぜない。期待値（ゴールデン）テストで固定。
- import は `.js` 拡張子付き（NodeNext/bundler 解決）。
- ESLint flat config / Prettier（semi:false, singleQuote, printWidth:100）。
- テストは各パッケージ `src/__tests__/`。

## 配布（Electron デスクトップアプリ）

配布形態は **Electron**（`packages/desktop`）。Tauri は Rust 側に JS ランタイムが無く node をサイドカーで
生やす必要があり、「終了後に何も残さない」要件と噛み合わないため採用しない（[docs/architecture.md] §12.0）。

```
pnpm dev:app                              # 開発ループ（web/desktop build + MCP バンドル + electron）
pnpm --filter @kanean/desktop start     # 起動のみ（ビルド済み前提。web dist と MCP バンドルは更新されない）
pnpm --filter @kanean/desktop package   # dmg を作る（electron-builder）
```

- **アプリ起動中だけ生きる**。ウィンドウを閉じるとプロセスもソケットも消える（常駐しない）。
- **UI 経路に TCP は無い**。UI も `/api` も `kanean://local/` から配る（同一オリジン＝CORS 不要）。
- ローカル連携（取込スキル・MCP）は `$DATA_DIR/kanean.sock`（unix socket・0600・起動中のみ）。
- `DATA_DIR` 既定は `<userData>/data`（`~/Library/Application Support/Kanean/data`）。
- `better-sqlite3` は **13.x（Node-API）**。Node と Electron で同一バイナリが動くのでリビルド機構は持たない。

※ 旧 VPS 運用（さくらVPS / pm2。デプロイスクリプトは除去済み）の経緯は [docs/architecture.md] §12.1〜12.2 に残置。

## 実装の進め方

増分: ① 基盤足場（済） → ② core（money/tax/depreciation/ledger）+ゴールデンテスト → ③ Drizzleスキーマ(control/data)+DbRouter+migrate → ④ server(取込/仕訳) → ⑤ web。
検算基準: 参照データ「マツダ2」（償却439,919 / 経費219,960 / 残高1）。

## OpenSpec（仕様駆動）

**新機能・仕様変更は openspec の change を通す**（`openspec` CLI・schema=`spec-driven`）。

- `openspec/specs/<capability>/spec.md` … 現行仕様（capability ごとに1ファイル）。実装済みの振る舞いの正。
- `openspec/changes/<name>/` … 変更提案（proposal / design / delta spec / tasks）。
- 流れ: `/opsx:propose "…"` → 実装 `/opsx:apply` → `/opsx:archive`（delta を main spec へ反映）。
- 確認: `openspec list --specs` / `openspec show <spec>` / `openspec validate --specs --strict`。
- 設計の詳細（数値・様式・フォーマット）は引き続き `docs/` が正。spec は「システムが満たす振る舞い」を持ち、docs を参照する。
