## Why

取込は現在 Claude Code のスキル前提で、`.claude/skills/` と `playwright-core` を持つ
リポジトリのチェックアウトが要る。**DMG を受け取った人にはどれも無い**ため、実質エンジニア専用の機能に
なっている。会計データへの問い合わせ（「7月末の売掛金は？」）も、画面を辿るしか手段がない。

Claude Desktop は MCP サーバをローカルプロセスとして起動でき、`.mcpb`（MCP Bundle）形式なら
**ドラッグ＆ドロップの1クリックで導入**できる。ソケット（[[local-access]]）は既に実装済みなので、
薄いブリッジを1本足すだけで「アプリを入れた人が Claude から会計データを引ける」状態に到達する。

なお Claude Desktop の**スキルは採用できない**。スキルのコード実行は Anthropic 側のサンドボックスで
行われ、利用者のマシンの `kanean.sock` に到達できないため。**手順知識も MCP 側に畳み、
利用者が入れるものは `.mcpb` 1つだけ**にする。

## What Changes

- **新パッケージ `packages/mcp`** — stdio ⇄ unix socket の薄いブリッジ。MCP クライアント（Claude Desktop）
  から見た Kanean の窓口。会計計算もデータアクセスも持たず、既存 API を呼ぶだけ。
- **ツールは読み取り中心に絞る**（12本程度）。128 ある HTTP ルートを機械的に露出しない。
  現在地・試算表/PL/BS・元帳/補助元帳・仕訳検索・科目残高・税額予測・連携サービス一覧＋追加。
- **アプリ未起動時は確認してから起動して再試行**。ソケットの不在＝アプリ未起動という既存の性質を使う。
  黙って起動はしない（GUI が勝手に立ち上がるのは驚きになる）。
- **`.mcpb` の配布と導線** — 配布物に同梱し、設定画面の「Claude Desktop と連携」から書き出して
  Finder で提示する。`claude_desktop_config.json` を利用者にもアプリにも手書きさせない。
- **手順知識の担い手を MCP に置く** — MCP prompts（定型の入口）とツール返り値の `nextActions`
  （次の一手・エラー時の選択肢）。ツール説明だけでは「何をすべきか」は伝わらないため。
- **承認は UI に残す**。ツールは draft を確定しない。返り値に `kanean://` の深いリンクを添えて
  アプリの該当画面へ戻す（アプリをプロトコルハンドラとして登録する）。
- **取込の実行は含めない**。巡回の Electron 移設は次の change（`acquisition-in-app`）で扱う。
  本 change では連携サービスの**登録**までを対象とする。

### Non-goals

- draft の自動承認・自動確定（[[skill-import]] の「黙って確定しない」を維持）
- 期首残高・勘定科目・税区分の編集（一覧を見比べる作業であり UI が優れる）
- ブラウザ巡回の実行（次 change）
- リモート/ネットワーク越しの MCP 接続（[[local-access]] の到達性境界を変えない）

## Capabilities

### New Capabilities

- `mcp-server`: MCP クライアントへ露出するツール・prompts の範囲と粒度、ローカルソケットへの接続と
  アプリ未起動時の扱い、`.mcpb` としての配布と導入、返り値による誘導（`nextActions`・深いリンク）。

### Modified Capabilities

- `local-access`: ローカルソケットが受け付ける範囲を `/skill/*` に限らずアプリ API 全体と定め、
  MCP ブリッジをその到達性境界の内側に位置づける。
- `desktop-app`: 配布物に MCP バンドルを同梱する。アプリを `kanean://` のプロトコルハンドラとして
  登録し、外部から該当画面を開けるようにする。
- `web-app`: 設定画面に「Claude Desktop と連携」導線を追加し、バンドルの書き出しと手順を提示する。

## Impact

- **新規**: `packages/mcp`（ブリッジ本体・ツール定義・`manifest.json`・`.mcpb` のパッケージング）
- **変更**: `packages/desktop`（プロトコルハンドラ登録、electron-builder への `.mcpb` 同梱）、
  `packages/web`（設定画面の導線）、`packages/server`（`nextActions` を返すための応答整形が要る箇所のみ）
- **依存追加**: `@modelcontextprotocol/sdk`、パッケージングに `mcpb` CLI
- **docs**: `architecture.md` §12.0 の図に MCP 経路を追記、`roadmap.md` の「次の change の MCP サーバ」を更新
- **既存 API は変更しない**（`/skill/*` の契約はそのまま。Claude Code のスキル経路は併存する）
- **未検証**: Claude Desktop のプラン要件（Pro 以上で使う前提は確認済み）、MCP prompts の UI 露出、
  `.mcpb` に Node ランタイムを同梱するか（アプリ側の node を使えるか）
