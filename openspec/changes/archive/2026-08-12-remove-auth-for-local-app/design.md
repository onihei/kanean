# Design — remove-auth-for-local-app

## Context

動機は proposal.md「Why」を参照。設計上効く現状は次の3点：

- **認証の入口だけが GitHub 依存で、その先は provider 非依存**。`session.ts` / `middleware.ts` /
  `DbRouter` / 全 API は `userId` を受け取るだけで、認証方式を知らない。差し替え点は `http/auth.ts` と
  `auth/middleware.ts` の 2 ファイルに閉じている。
- **`index.ts:94` の `serve({ fetch, port })` は hostname 未指定＝ 0.0.0.0 バインド**。
  現在は認証があるため 401 で止まるが、認証を消した瞬間に同一 LAN から素通しになる。
  つまり本 change は「防壁を外す」のではなく「防壁を認証からバインドアドレスへ移す」変更であり、
  この 1 行が実装の中心にある。
- **`/skill/auth` の同意画面は Web セッションに依存**（`skillAuth.ts` が `validateSession` を呼ぶ）。
  セッション廃止は取込トークン系の廃止を強制する。両者を分けて実施することはできない。

## Goals / Non-Goals

**Goals**

- 認証・セッション・トークンの全廃と、それに代わるループバック境界の確立
- SaaS 前提のスキーマ残骸（`identities` / `subscriptions` / `users.plan`）の除去
- 後続の Tauri 化・MCP 提供・`books` リネームを妨げない形に着地させる

**Non-Goals**

- `users` → `books` のリネーム。本 change では `users` テーブルと `users/{id}.sqlite` を維持する
- Tauri の sidecar 設計・パッケージング・`deploy.sh` / pm2 の撤去
- 保存時暗号化（SQLCipher）
- MCP の capability 設計。ただし後述の「後続への申し送り」に前提条件だけ記録する

## Decisions

### D1. 認証の代替は「パスワード」ではなく「バインドアドレス」

**採用**: `serve({ fetch, port, hostname: '127.0.0.1' })` を固定。設定で変更できないようにする。

**却下した案**:

- *ローカルパスワード認証*: アプリの入口しか塞がない。`sqlite3 $DATA_DIR/users/*.sqlite` で
  同じデータが平文で読めるため、脅威モデル上ほぼ無意味。入力コストだけが増える。
- *バインドアドレスを環境変数で可変にする*: 「外部公開できる口」が残ると、認証がないことと組み合わさって
  事故が致命的になる。可変にする実利がない以上、選択肢自体を消すほうが安全。

**帰結**: 「同一マシンで実行できること」＝「全権限」。この線引きを spec に明文化した
（[[local-access]] 「ループバック限定の待ち受け」）。センシティブさへの追加防御が必要になった場合、
正しい打ち手は認証ではなく保存時暗号化であり、それは別 change とする。

### D2. `requireAuth` は消さず、「オーナー解決ミドルウェア」に転生させる

**採用**: ミドルウェアの構造（`c.set('userId', ...)` して次へ）を維持し、解決元だけ
「Cookie → セッション」から「control plane の唯一の users 行」に差し替える。

**却下した案**: ミドルウェアを削除し、各ハンドラで直接オーナーを引く。
→ 全ハンドラ（`api.ts` / `forecast.ts` / `export.ts` / `ec.ts` …）に変更が波及し、
後続で MCP 用のアクター識別（`actor` の伝播）を入れるときに再び全ハンドラを触ることになる。
1 箇所に集約したままにする。

**帰結**: `AuthVariables` 型と `c.get('userId')` の呼び出し側は一切変更不要。差分が小さく保たれる。

### D3. オーナー解決はプロセス起動時に1回、結果をメモリに保持

**採用**: 起動時に `users` を読み、0 行なら作成、1 行ならそれを採用、2 行以上ならエラーで起動中断。
以降のリクエストでは DB を引かない。

**理由**: リクエスト毎の control plane 参照は無駄。またオーナーは実行中に変わらない。
2 行以上での起動中断は、`books` リネーム前に誤った帳簿を開く事故を防ぐための安全装置
（開発機に過去の複数 ULID が残っている可能性がある）。

### D4. control plane のテーブル削除は 1 本のマイグレーションで

`sessions` / `identities` / `import_tokens` / `subscriptions` を DROP し、`users.plan` を削除する。
SQLite の列削除は Drizzle が新テーブル作成＋コピー＋差し替えを生成するため、`users` は再作成される。
`backup_status` が `users.id` を参照しているため、外部キー制約の扱いを migration 生成後に確認する。

**残すもの**: `users`（id が data plane のファイル名を決める）、`backup_status`（[[data-ops]] が使用中）。

### D5. スキル側は「トークン取得フローの削除」だけ

スキルは `/skill/*` を呼ぶ部分をそのまま維持し、`Authorization` ヘッダの付与と
ループバック＋PKCE のトークン取得手順を削除する。API の契約（リクエスト形状・検証・冪等性）は
変更しないため、[[skill-import]] の要件は「呼び出しの前提」の 1 行以外そのまま。

**注意**: スキルは本リポジトリ外の配布物であり、本体の deploy とタイミングが揃わない。
サーバ側が先にトークンを受け付けなくなっても、`Authorization` ヘッダは**無視**されるだけで
エラーにはならないため、スキルの更新は後追いでよい（順序依存がない）。

## Risks / Trade-offs

- **[認証削除とバインド変更がずれると全データが LAN に露出する]**
  → 同一コミットで行う。`hostname` 指定を先に入れ、認証削除を後に行う順序でタスクを組む
  （逆順にすると、その間だけ無防備な状態が生まれる）。
- **[`127.0.0.1` 固定が Docker 配布と噛み合わない]**
  → コンテナ内で `127.0.0.1` にバインドするとポートマッピングが機能しない。
  architecture §12 の「Docker イメージも用意可」は本 change で撤回する。配布形態は Tauri に一本化する。
- **[同一マシンで動く任意のプロセスが全権限を持つ]**
  → 受容する。ただしこれは「認証を消したから」ではなく、SQLite ファイルが平文である以上
  もともと成立していた事実である（パスワード認証でも変わらない）。
  対処が必要になった時点で SQLCipher を別 change として検討する。
- **[開発機の `$DATA_DIR/users/` に複数の ULID が残っている可能性]**
  → D3 の「2 行以上で起動中断」で検出する。実データは未運用のため、不要な DB ファイルは手動削除でよい。
- **[`invalidate-sessions` を運用手順から消し忘れる]**
  → architecture §5.1 とスクリプトを同時に削除する。

## Migration Plan

データ移行は不要（実運用ユーザーが存在しない）。手順は次の通り。

1. `hostname: '127.0.0.1'` を入れる（防壁を先に立てる）
2. オーナー解決ミドルウェアへ差し替え、`/auth` マウントと web のログイン画面を削除
3. `/skill/auth` と `/api/import-tokens` と取込トークンパネルを削除
4. control plane マイグレーション（テーブル DROP・`users.plan` 削除）を生成・適用
5. docs 更新（architecture §5/§12/§14・PRD F-AUTH・ec-import-api §0・acquisition-skill-spec）、
   `docs/import-auth-flow.md` は削除
6. `.env` / `.env.example` から GitHub OAuth と `POST_LOGIN_REDIRECT` を除去
7. スキル側の認証コードを削除（後追い可）

**ロールバック**: 認証系のコード削除はコミット単位で revert 可能。control plane のテーブル DROP のみ
不可逆だが、削除対象はいずれも実データを持たない（`identities` 1 行 / `sessions` 数行 /
`import_tokens` は失効させれば足りる / `subscriptions` は空）。

**deploy.sh / VPS**: 本 change では touch しない。`hostname: '127.0.0.1'` を入れた時点で
VPS 上のブラウザ利用は成立しなくなるが、VPS 運用は本 change をもって前提から外すという合意済みの判断。
実際の撤去は Tauri change で行う。

## 後続への申し送り

### MCP から仕訳を confirm できるようにするための前提条件

MCP サーバ（後続 change）では、`status='confirmed'` への遷移を LLM に委任することを想定している。
現行原則「黙って確定しない」の主語は**「黙って」**であり、確定の記録・絞り込み・一括取消が
揃うならゲートを前（確定前の人手クリック）から後ろ（確定後の集計レビュー）へ移してよい、という整理。

そのために MCP change で必要になるものを、ここに前提条件として記録しておく：

- `audit_logs` に **`actor`** を追加（`human` / `mcp:*` / `rule:auto` / `import`）。
  現在の `audit_logs` は誰が実施したかを持たない。`journal_entries.source` は**取込元**であって
  実行者ではないため、兼用しない。
- `audit_logs.action` に **`confirm`** を追加（現在は `update` / `unconfirm` / `delete` のみ）。
- **actor で絞った一括 unconfirm**（「先週 MCP が確定したぶんを全部 draft に戻す」）。
- 委任の境界は**可逆性**で引く。決算確定・「提出可能」の宣言・全データエクスポート・物理削除は
  取り消せない、または外部に出るため委任しない。
- **dedup 判定を LLM に override させない**。二重計上は検出が難しく過少申告方向のリスクであり、
  `raw_txn_dedup_uq` と `dedup_hash` による決定論的判定を機械側に残す（`force` 引数を生やさない）。
- 自動確定ポリシーは二値モードではなく条件式にできる。`mapping_history.hit_count` /
  `last_used_at` が既に学習基盤として存在するため、「過去 N 回同じ判断が確定している」を条件にできる。

本 change ではこれらを実装しない。ここに書く理由は、認証を消したことで
「誰がやったか」を記録する主体が一時的に不在になるため、その穴を後続で塞ぐことを明示するため。

## Open Questions

- control plane 側の外部キー（`backup_status.user_id → users.id`）が `users` 再作成時に
  どう扱われるかは、Drizzle のマイグレーション生成結果を見てから確定する。
- Tauri の sidecar がポートをどう決めるか（固定 10140 か、空きポート＋アプリへの通知か）は
  Tauri change で決める。本 change は `127.0.0.1` 固定のみを保証し、ポート番号には踏み込まない。
