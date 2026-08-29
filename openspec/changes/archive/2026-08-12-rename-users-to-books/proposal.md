## Why

`users` という名前が実態と合っていない。認証は既に全廃され（[[local-access]]）、ログインする人は1人しかいない。
それでも `$DATA_DIR/users/{id}.sqlite` という per-file 構造が残っているのは、これが本来
**「ユーザーごと」ではなく「帳簿ごと」の分離**だからである。

そして帳簿は 1 冊とは限らない。想定している税理士連携では、**税理士は自分のインスタンスで顧問先の帳簿を N 冊持つ**
（ログインする人は税理士1人のまま）。つまり必要なのは multi-user ではなく **multi-book** であり、
現行の per-file data plane はすでにその骨格になっている。キーが `userId` になっているだけ。

いま実施する理由は**移行コストがゼロだから**。実運用データが存在しないので、テーブル名・
ディレクトリ名・エクスポート zip の構造をまとめて改められる。1年後に同じことをやると
移行スクリプトとエクスポート後方互換が必要になる。

## What Changes

- **BREAKING**: control plane の `users` テーブルを **`books`** に置き換える
  （`id` / `name` / `createdAt` / `updatedAt`。`displayName`・`email`・`status` は廃止）
- **BREAKING**: data plane の配置を `$DATA_DIR/users/{id}.sqlite` → **`$DATA_DIR/books/{id}.sqlite`**、
  証憑を `users/{id}/attachments/` → **`books/{id}/attachments/`** に変更
- **BREAKING**: エクスポート zip の内部構造が `users/{id}.sqlite` → `books/{id}.sqlite` に変わる
- **BREAKING**: `backup_status.user_id` → `book_id`
- **BREAKING**: `GET /api/me` を廃止し、`GET /api/books`（一覧）に置き換える
- **複数帳簿の土台**を入れる:
  - 帳簿の作成・一覧・改名 API（`/api/books`）と、web の帳簿切替 UI
  - リクエストが対象帳簿を指定する手段＝**`X-Book-Id` ヘッダ**。
    未指定かつ 1 冊なら暗黙にその帳簿、未指定かつ 2 冊以上なら 400（design.md D1）
  - 起動時の挙動を「0冊なら1冊作る／2冊以上はエラー」から「0冊なら1冊作る／**N冊はそのまま**」へ
- **既存の開発データは破棄**する（移行スクリプトを書かない）。`$DATA_DIR` を作り直す
- `packages/server/src/auth/` を廃止し、`books/`（解決・ミドルウェア）へ移す

### 非スコープ

- **帳簿の削除**。税務データの消失は不可逆なので API では提供せず、ファイルを手で消す運用とする
- 税理士連携そのもの（コード提示 → エクスポート → チェックアウト/チェックイン・編集中ロック）。
  本 change は「N 冊持てる」までで、帳簿の受け渡しは別 change
- 帳簿ごとの暗号化・アクセス制御（ローカル単一ユーザーのため不要）
- Tauri 化・MCP サーバ

## Capabilities

### New Capabilities

- `books`: 帳簿（1つの会計データファイル）の作成・一覧・改名と、リクエストが対象帳簿を選ぶ規約。
  複数帳簿を持てることと、その選択が曖昧なまま処理されないことを保証する。

### Modified Capabilities

- `local-access`: 「単一オーナーの自動解決」を「帳簿の解決」に置き換える。
  2冊以上で起動中断していた要件を撤回し、N 冊を許す。`GET /api/me` の要件を削除。
  ループバック限定バインドの要件は変更しない。
- `data-ops`: バックアップ・リストア・エクスポート・マイグレーションが走査する対象を
  `users/*.sqlite` から `books/*.sqlite` に、記録先を `backup_status.book_id` に改める。
  エクスポート zip の内部構造も変わる。
- `attachments`: 証憑の保存先を `$DATA_DIR/books/{bookId}/attachments/` に改め、
  「他ユーザーの証憑に到達できない」を「他帳簿の証憑に到達できない」に読み替える。
- `web-app`: サイドバーに帳簿の表示と切替を追加し、帳簿の作成・改名を設定画面に置く。
- `skill-import`: 取込スキルが対象帳簿を `X-Book-Id` で指定できるようにする（未指定は 1 冊のときのみ有効）。

## Impact

**control plane マイグレーション（1本）**

- `users` → `books`（列の入替を伴うため新規作成＋旧テーブル DROP）
- `backup_status.user_id` → `book_id`（外部キーの張り替え）

**server**

- `src/auth/` を削除し `src/books/{resolve,middleware}.ts` を新設
- `src/http/books.ts` を新設（一覧・作成・改名）
- `config.ts`: `usersDir` / `userDbPath` / `attachmentDir` → books 版（36 箇所が参照）
- `db/router.ts`: `userDb()` → `bookDb()`、`listUserDbFiles()` → `listBookDbFiles()`（93 箇所が参照）
- `AuthVariables { userId }` → `BookVariables { bookId }`（`c.get('userId')` 14 箇所）
- `ops/exportUser.ts` → `exportBook.ts`（zip 構造と manifest）
- `scripts/{backup,restore}.ts`・`migrate.ts` の走査対象と記録先
- **ULID ガード**（`attachments/storage.ts`・`ops/export*.ts`）は bookId に対して維持する

**web**

- `api.ts`: `User` 型 → `Book`、`me()` → `books()`、全リクエストに `X-Book-Id` を付与
- `App.tsx`: 起動時に帳簿一覧を取得。0冊は起こらない（サーバが作る）。
  複数あれば直近選択（localStorage）を復元
- `nav/Sidebar.tsx`: 帳簿名の表示と切替
- 設定画面: 帳簿の作成・改名

**docs**

- `architecture.md` §4（データ配置図）・§5（起動時の解決）・§12.1（ディレクトリ）
- `data-model.md` §1（control plane）
- `PRD.md` F-AUTH-2/F-AUTH-4
- `CLAUDE.md` / `openspec/config.yaml` のデータ配置の記述

**運用**

- 開発用 `$DATA_DIR` は作り直す（既存の `data/users/` は破棄）
- 既存のエクスポート zip は新レイアウトへそのままリストアできない（実運用データがないため許容）
