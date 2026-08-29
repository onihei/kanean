# Kanean（カネアン）

個人事業主向けの確定申告 / 会計システム（青色申告・簡易課税・固定資産・家事按分）。
**ローカル単一ユーザー**の Electron デスクトップアプリ（認証なし・UI 経路に TCP を開かない）。

- 設計ドキュメント: [`docs/`](./docs)（PRD・アーキテクチャ・データモデル・会計/減価償却仕様 ほか）
- 開発ガイド: [`CLAUDE.md`](./CLAUDE.md)

## クイックスタート

```sh
pnpm install
cp .env.example .env   # DATA_DIR などを設定
pnpm build
pnpm test
```

ブラウザで使う開発ループ（server + web を同時起動）:

```sh
pnpm dev          # @kanean/server（API 既定 :10140）+ @kanean/web（Vite :5173）
```

デスクトップアプリ（配布形態はこちら）:

```sh
pnpm dev:app      # web/desktop build + MCP バンドル + Electron 起動
pnpm --filter @kanean/desktop package   # dmg を作る（electron-builder）
```

個別に起動する場合:

```sh
pnpm --filter @kanean/server dev
pnpm --filter @kanean/web dev
```

## 構成

TypeScript モノレポ（pnpm + turbo）。`packages/{shared, core, server, web, acquisition, desktop, mcp}`。
データは SQLite（`DATA_DIR` で配置を外出し。control plane `control.sqlite` + 帳簿ごとの data plane `books/{book_id}.sqlite`）。
