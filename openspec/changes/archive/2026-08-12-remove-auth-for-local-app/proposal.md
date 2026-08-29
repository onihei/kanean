## Why

Kanean は「セルフホスト可能・マルチユーザー」を前提に GitHub OAuth ＋セッション＋取込トークンの
2系統認証を持つが、実際の利用形態は**自分1人が自分の Mac で使う**であり、複数人の同時利用は起きない。
さらに次の方向として **Tauri によるローカルデスクトップアプリ化**と **MCP サーバ提供**を進めたい。
GitHub OAuth はデスクトップアプリと構造的に相性が悪く（client_secret の同梱・外部ブラウザ往復・
**オフラインで起動できない**）、この撤去がローカルアプリ化の前提条件になる。

同時に、認証を消すことは防御を弱めることを意味しない。現状 `serve({ fetch, port })` は
hostname 未指定＝**0.0.0.0 バインド**であり、同一 LAN の第三者が到達できる。
本 change は**認証という境界を、ネットワーク境界（127.0.0.1 バインド）に置き換える**ものであり、
「アプリの入口を塞ぐパスワード」より強い保証を、入力ゼロで得ることを狙う。

VPS 運用（さくらVPS・pm2）は本 change をもって前提から外す。

## What Changes

- **BREAKING**: GitHub OAuth 一式を削除（`/auth/github`・`/auth/github/callback`・`/auth/logout`、
  `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL`）
- **BREAKING**: Cookie セッションを削除（`sessions` テーブル・`requireAuth` のセッション検証・
  `invalidate-sessions` スクリプト・web のログイン画面）
- **BREAKING**: import トークン一式を削除（`import_tokens` テーブル・`Authorization: Bearer` 認証・
  `/api/import-tokens` CRUD・`/skill/auth/*` の PKCE 同意フロー・web の取込トークン管理パネル）。
  ローカルに閉じた時点で「インターネット越しに叩くための Bearer トークン」の存在理由が消えるため
- **BREAKING**: 配布済みの取込スキル（Amazon / 楽天 / 銀行）はトークン取得・付与をやめ、
  `http://127.0.0.1:<port>` へ直接呼ぶ形に変更が必要
- **サーバを 127.0.0.1 に固定バインド**する（新しい防壁。ここが本 change の実質的な中身）
- 単一ユーザーを起動時に自動解決する（`users` の唯一行。無ければ作成し data plane を初期化）
- SaaS 前提の残骸を掃除：`identities` / `subscriptions` テーブル、`users.plan`、サイドバーの `free` 表示
- `users` テーブル自体は**残す**（data plane のファイル名を決める id を持つため。
  後続の `rename-users-to-books` で `books` として整理する）

### 非スコープ（後続 change）

- Tauri 化そのもの（sidecar 起動・パッケージング・DATA_DIR の置き場所・deploy.sh / pm2 の撤去）
- `users/{id}.sqlite` → `books/{id}.sqlite` のデータ層リネーム
- MCP サーバの提供と、その capability 設計（confirm 委任・自動確定ポリシー）
- SQLCipher による保存時暗号化

## Capabilities

### New Capabilities

- `local-access`: ローカル単一ユーザーのアクセス境界。127.0.0.1 固定バインド、単一ユーザーの自動解決、
  data plane の初期化とシード自己修復、`/api` へのアクセス可否を定める。
  従来の `auth-session` を置き換える（認証もセッションも持たないため名前を変える）。

### Modified Capabilities

- `auth-session`: capability ごと廃止。GitHub OAuth・セッション発行・ログイン後復帰先・
  セッション一括失効の全要件を削除し、data plane 初期化とデータ隔離の要件は `local-access` へ移す。
- `import-token-auth`: capability ごと廃止。トークン発行/失効/検証・PKCE ブラウザ認証フロー・
  リダイレクト先制限の全要件を削除。
- `skill-import`: `/skill` 配下の呼び出し前提から import トークンを外す（ローカル呼び出しのみ）。
  API の契約・検証・冪等性・学習の書き戻しは変更しない。
- `web-app`: ログイン画面と取込トークン管理パネルを削除。SPA フォールバックの除外パスから `/auth` を外す。
- `data-ops`: `GET /api/export` の前提を「認証済み利用者」から「ローカルからの呼び出し」に改める。
  バックアップ・リストア・マイグレーションの要件は変更しない。

## Impact

**削除されるコード**

- `packages/server/src/auth/github.ts` / `session.ts` / `importToken.ts` / `importAuthCode.ts`
- `packages/server/src/http/auth.ts` / `skillAuth.ts` / `importTokens.ts`
- `packages/server/src/scripts/invalidate-sessions.*`
- `packages/web/src/pages/ImportTokensPanel.tsx`、`App.tsx` のログイン分岐

**変更されるコード**

- `packages/server/src/index.ts`: `serve()` に `hostname: '127.0.0.1'`、`/auth` マウント削除、
  `/skill` の認証ミドルウェア除去
- `packages/server/src/auth/middleware.ts`: セッション検証を単一ユーザー解決に置き換え
- `packages/server/src/auth/provision.ts`: `upsertUserFromGithub` → 起動時のオーナー解決
- `packages/server/src/config.ts`: `githubOauthConfig` / `postLoginRedirect` 削除
- `packages/server/src/db/control/schema.ts`: `sessions` / `identities` / `import_tokens` /
  `subscriptions` を DROP、`users.plan` を削除（control plane のマイグレーション1本）

**スキル（別リポジトリ／配布物）**

- Amazon / 楽天 / 銀行スキルの認証部分。トークン取得フロー（ループバック＋PKCE）を廃し、
  `http://127.0.0.1:<port>/skill/*` を直接呼ぶ

**ドキュメント**

- `docs/architecture.md` §5（認証）・§12（デプロイ）・§14（セキュリティ）
- `docs/PRD.md` F-AUTH
- `docs/import-auth-flow.md`（廃止）
- `docs/ec-import-api.md` §0（認証）・`docs/acquisition-skill-spec.md`

**運用**

- `.env` から GitHub OAuth と `POST_LOGIN_REDIRECT` が消える
- `deploy.sh` / pm2 / VPS は後続の Tauri change で撤去（本 change では触らない）
