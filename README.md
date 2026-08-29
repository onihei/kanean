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

## 免責事項

本ソフトウェアは**申告書の作成を支援する道具**であり、税務・会計上の助言を行うものではありません。

- 税額・償却費・消費税・各種控除などの**算出結果の正確性を保証しません**。税制は毎年改正され、
  実装が最新の様式・規定に追随している保証もありません。
- 申告内容の最終的な責任は**利用者本人**にあります。提出前に**税理士等の有資格者による確認**を
  受けることを強く推奨します。特に法的リスクの高い領域（確定申告書・消費税申告・源泉・控除判定・
  決算整理・電子帳簿保存・e-Tax）は、システムが自動算出した値であっても
  「提出可能」と判断してよいことを意味しません。
- 納税予測・what-if シミュレーションは**参考値**です。
- 作者および貢献者は、本ソフトウェアの使用によって生じたいかなる損害（過少申告加算税・延滞税・
  データの消失を含みますがこれらに限りません）についても責任を負いません。

これは AGPL-3.0 第15条・第16条（保証の否認・責任の制限）の趣旨を、本ソフトウェアの用途に即して
具体化したものです。

## ライセンス

Copyright (C) 2026 Yuichiro Hayashi

[GNU Affero General Public License v3.0](./LICENSE)（AGPL-3.0-only）で公開しています。

改変版を配布する場合、およびネットワーク越しにサービスとして提供する場合は、
同ライセンスの下でソースコードを公開する必要があります。
自分の帳簿を付けるためにローカルで実行するだけであれば、義務は生じません。
