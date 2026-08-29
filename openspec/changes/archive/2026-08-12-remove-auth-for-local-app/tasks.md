# Tasks — remove-auth-for-local-app

順序は design.md「Migration Plan」に従う。**1 を最初に行う**（認証を消す前に防壁を立てる）。

## 1. ループバック境界を立てる

- [x] 1.1 `packages/server/src/index.ts` の `serve()` に `hostname: '127.0.0.1'` を追加し、起動ログの表示を実態に合わせる
- [x] 1.2 バインドアドレスを環境変数で変更できないことを確認する（`config.ts` に該当設定を作らない）
- [x] 1.3 LAN の別ホストから接続できないことを手で確認する（`nc -vz <LAN IP> 10140` が失敗する）
      → `192.168.10.141:10140` Connection refused / `127.0.0.1:10140` succeeded を確認済み

## 2. オーナー解決へ差し替える

- [x] 2.1 `auth/provision.ts` の `upsertUserFromGithub` を、起動時にオーナーを解決する関数へ置き換える（0行→ULID採番＋作成、1行→採用、2行以上→エラー）
- [x] 2.2 オーナー作成時に data plane の作成・マイグレート・`seedDataPlane` が走ることを確認する
- [x] 2.3 `auth/middleware.ts` の `requireAuth` を、セッション検証なしで解決済み `userId` を `c.set` するミドルウェアへ差し替える（`AuthVariables` 型と呼び出し側は変更しない）
- [x] 2.4 `requireImportToken` を削除し、`/skill` のマウントから外す（5MB ボディ上限は維持）
- [x] 2.5 `GET /api/me` がオーナーの `users` 行を返すことを確認する
- [x] 2.6 `auth/__tests__/auth.test.ts` を新しい解決規則に合わせて書き換える（0行/1行/2行以上の3ケース）

## 3. 認証系のコードを削除する

- [x] 3.1 `packages/server/src/auth/github.ts` を削除
- [x] 3.2 `packages/server/src/auth/session.ts` を削除
- [x] 3.3 `packages/server/src/http/auth.ts` を削除し、`index.ts` の `/auth` マウントを外す
- [x] 3.4 `config.ts` から `githubOauthConfig` / `postLoginRedirect` を削除
- [x] 3.5 `invalidate-sessions` スクリプトと package.json のスクリプト定義を削除
- [x] 3.6 `.env` / `.env.example` から `GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` / `POST_LOGIN_REDIRECT` を削除

## 4. 取込トークン系を削除する

- [x] 4.1 `packages/server/src/http/skillAuth.ts` と `auth/importAuthCode.ts` を削除し、`index.ts` の `/skill/auth` マウントを外す
- [x] 4.2 `packages/server/src/auth/importToken.ts` と `http/importTokens.ts` を削除し、`/api/import-tokens` を外す
- [x] 4.3 対応するテスト（`importToken.test.ts` / `importAuthCode.test.ts` / `http/__tests__/skillAuth.test.ts`）を削除
- [x] 4.4 `/skill/*` が `Authorization` ヘッダの有無にかかわらず動作することを確認する（旧スキルからの呼び出しが壊れない）
      → `http/__tests__/ec.test.ts`「旧スキルが送る Authorization ヘッダは無視され、エラーにならない」で担保

## 5. web からログインと取込トークンを外す

- [x] 5.1 `App.tsx` のログイン分岐（`/auth/github` へのリンク）を削除し、`api.me()` の結果に関わらず業務画面へ入るようにする
- [x] 5.2 `nav/Sidebar.tsx` から `user.plan` の表示を削除
- [x] 5.3 `pages/ImportTokensPanel.tsx` を削除し、設定画面のタブ構成から取り除く
- [x] 5.4 `web/src/api.ts` の `User` 型から `plan` を削除し、取込トークン関連の API 呼び出しを削除
- [x] 5.5 `index.ts` の SPA フォールバック除外パスから `/auth` を外す（`/api` `/skill` のみ）

## 6. control plane のスキーマを掃除する

- [x] 6.1 `db/control/schema.ts` から `sessions` / `identities` / `importTokens` / `subscriptions` を削除し、`users.plan` を削除
- [x] 6.2 Drizzle マイグレーションを生成し、`users` 再作成時の `backup_status.user_id` 外部キーの扱いを確認する（design.md Open Questions）
      → `0003_icy_chimera.sql` は 4×DROP TABLE ＋ `ALTER TABLE users DROP COLUMN plan`。**users は再作成されない**ため FK は無傷。Open Question 解消
- [x] 6.3 開発用 `$DATA_DIR` に対してマイグレーションを適用し、既存データが読めることを確認する
      → control は users/backup_status のみ、既存オーナー1行保持、`integrity_check = ok`
- [x] 6.4 `db/__tests__/router.test.ts` の users 挿入から `plan` を外す

## 7. ドキュメントを更新する

- [x] 7.1 `docs/architecture.md` §5 を「ローカル単一ユーザーのアクセス境界」に書き換え（図ごと差し替え）、§5.1 のセッション失効ポリシーを削除
- [x] 7.2 `docs/architecture.md` §12 から Docker 配布の記述を撤回、§14 セキュリティ表を更新（通信/セッション行 → ループバック境界・保存時暗号化は将来課題として残す）
- [x] 7.3 `docs/PRD.md` F-AUTH の各行を更新
- [x] 7.4 `docs/import-auth-flow.md` を削除
- [x] 7.5 `docs/ec-import-api.md` §0（認証）と `docs/acquisition-skill-spec.md` の認証記述を更新
- [x] 7.6 `CLAUDE.md` の「セルフホスト可能・マルチユーザー」と `openspec/config.yaml` の context を実態に合わせる

## 8. 取込スキルを追従させる（後追い可）

- [x] 8.1 Amazon / 楽天 / 銀行スキルからトークン取得フロー（ループバック＋PKCE）を削除
- [x] 8.2 `Authorization: Bearer` の付与を削除し、`http://127.0.0.1:<port>/skill/*` を直接呼ぶ
- [x] 8.3 スキルのセットアップ手順（トークン発行の案内）を更新

## 9. 仕上げ

- [x] 9.1 `pnpm lint` / `pnpm typecheck` / `pnpm test` が通る
      → lint/typecheck 6/6 successful、テスト 658 passed（server 509 / core 118 / web 17 / shared 14）
- [x] 9.2 起動 → 業務画面表示 → 取込 → 仕訳確定 → 帳簿表示 → エクスポートを一通り手で確認する
      → クリーンな DATA_DIR で本番起動: オーナー(ULID)＋data plane 自動生成 / `/api/me` 200 / 年度作成 /
        仕訳 confirmed 作成 → 試算表 借貸 50,000 一致 / PL 生成 / `/api/export` zip 220KB /
        `/skill/*` は認証なし 200・旧 `Authorization` 付きでも 200 / `/api/import-tokens`・`/skill/auth/*` は 404 /
        本番モードでも LAN から Connection refused
- [x] 9.3 E2E のセッションシード手順が不要になったことを確認し、テスト側の迂回コードを削除する
      → リポジトリ内に session 関連コードは皆無（手順は個人メモのみだったため更新）。
        起動時 `resolveOwner` がオーナーを自動作成するので事前の DB 準備自体が不要になった
- [x] 9.4 `openspec validate remove-auth-for-local-app --strict` が通る
