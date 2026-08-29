# Tasks — rename-users-to-books

design.md D6「境界から型で押し出す」に従い、1→2→3 の順で改名すると `tsc` が残りを全部指す。

## 1. 開発データを作り直す

- [x] 1.1 現在の `$DATA_DIR` の中身（帳簿数・仕訳件数）を提示してから `data/` を削除する
      → 39仕訳/78明細を確認、`~/kanean-data-backup-2026-08-12/` に退避してから削除
- [x] 1.2 削除後に旧レイアウトを参照するコードが残っていないことを確認する（`users/` の文字列検索）

## 2. control plane のスキーマを books にする

- [x] 2.1 `db/control/schema.ts`: `users` を `books`（`id` / `name` / `createdAt` / `updatedAt`）に置き換える
- [x] 2.2 `backup_status.user_id` を `book_id` に変更（外部キーを `books.id` へ張り替え）
- [x] 2.3 Drizzle マイグレーションを生成し、生成 SQL を確認する（列入替のためテーブル再作成になる想定）
      → 対話回避のため2段階生成（0004=旧テーブル DROP / 0005=books＋backup_status 作成）

## 3. パスと DbRouter を books にする

- [x] 3.1 `config.ts`: `usersDir` → `booksDir`、`userDbPath` → `bookDbPath`、`attachmentDir(bookId)`
- [x] 3.2 `db/router.ts`: `userDb()` → `bookDb()`、`listUserDbFiles()` → `listBookDbFiles()`
- [x] 3.3 `tsc --noEmit` が指すまで全呼び出し側を追従（`userDb(` 93 箇所・パス関数 36 箇所）
- [x] 3.4 ULID ガード（`attachments/storage.ts`・`ops/export*.ts`）を `bookId` に対して維持する

## 4. 帳簿の解決とミドルウェア

- [x] 4.1 `src/auth/provision.ts` → `src/books/resolve.ts`（0冊なら `マイ帳簿` を作成、N冊はそのまま）
- [x] 4.2 `src/auth/middleware.ts` → `src/books/middleware.ts`。解決順は ヘッダ → クエリ → 1冊なら暗黙 → 400（design.md D1）
- [x] 4.3 曖昧時の 400 応答に、選択可能な帳簿の `id` と `name` を含める
- [x] 4.4 存在しない bookId は 404 を返す
- [x] 4.5 `AuthVariables { userId }` → `BookVariables { bookId }`（`c.get('userId')` 14 箇所）
- [x] 4.6 `src/auth/` ディレクトリを削除する
- [x] 4.7 解決順のテストを書く（ヘッダ / クエリ / 1冊暗黙 / 2冊で400 / 不在で404）

## 5. 帳簿 API

- [x] 5.1 `src/http/books.ts`: `GET /api/books`・`POST /api/books`・`PATCH /api/books/:id`
- [x] 5.2 `GET /api/me` を廃止する
- [x] 5.3 帳簿作成時に data plane を作成・マイグレート・シードすることを確認する
- [x] 5.4 削除エンドポイントを**作らない**（design.md D4）

## 6. エクスポート・バックアップ・リストア

- [x] 6.1 `ops/exportUser.ts` → `exportBook.ts`。zip 内を `books/{bookId}.sqlite`・`books/{bookId}/attachments/**` に
- [x] 6.2 manifest に `bookId` と `bookName` を含める
- [x] 6.3 `scripts/backup.ts`: 走査対象を `books/*.sqlite`、記録先を `backup_status.book_id` に
- [x] 6.4 **帳簿0冊のバックアップを失敗として扱う**（偽の成功を作らない）
- [x] 6.5 `scripts/restore.ts`: 退避・配置の対象を `books/` に、一覧表示を「帳簿数」に
- [x] 6.6 `migrate.ts`: 走査対象を `books/*.sqlite` に

## 7. web

- [x] 7.1 `api.ts` に共通リクエストラッパを導入し、`X-Book-Id` を一元的に付与する
- [x] 7.2 全 77 箇所の `fetch(..., { credentials: 'include' })` をラッパへ置換（Cookie は廃止済みで無意味）
- [x] 7.3 `api.ts` に生の `fetch(` が残っていないことを確認する
- [x] 7.4 ネイティブ GET 2箇所に `?bookId=` を付ける（`SettingsTab` の `<a href="/api/export">`・`attachmentUrl()`）
- [x] 7.5 `User` 型 → `Book`、`me()` → `books()`
- [x] 7.6 `App.tsx`: 起動時に帳簿一覧を取得し、選択中の帳簿を localStorage から復元する
- [x] 7.7 `nav/Sidebar.tsx`: 帳簿名の表示と切替（2冊以上のときのみ切替を出す）
- [x] 7.8 設定画面に帳簿パネル（一覧・作成・改名）を追加する
- [x] 7.9 帳簿切替時に画面状態（選択年度・開いている元帳・絞り込み）をリセットする（design.md Open Questions）

## 8. 取込スキル

- [x] 8.1 `.claude/skills/acquisition/SKILL.md`: 400 が返ったら帳簿を人に確認し `X-Book-Id` を付けて再試行する手順を追加
- [x] 8.2 サブスキル（mufg / ufjvisa / shinsei）の curl にヘッダを渡せるようにする

## 9. ドキュメント

- [x] 9.1 `docs/architecture.md` §4（データ配置図）・§5（起動時の解決）・§12.1（ディレクトリ）
- [x] 9.2 `docs/data-model.md` §1（control plane の users → books）
      → 前 change で残っていた identities / sessions / subscriptions の記述もここで除去
- [x] 9.3 `docs/PRD.md` F-AUTH-2 / F-AUTH-4
- [x] 9.4 `CLAUDE.md` と `openspec/config.yaml` のデータ配置の記述
- [x] 9.5 `docs/ec-import-api.md` §0 に帳簿指定の記述を追加

## 10. 仕上げ

- [x] 10.1 `pnpm lint` / `pnpm typecheck` / `pnpm test` が通る
      → lint/typecheck 6/6、テスト 668 passed（server 518 / core 119 / web 17 / shared 14）
- [x] 10.2 クリーンな `$DATA_DIR` で起動 → 1冊目が自動作成される
      → クリーンな DATA_DIR で `books/{ULID}.sqlite` と「マイ帳簿」が自動生成
- [x] 10.3 **2冊目を作成**し、切替・暗黙解決の失効（400）・帳簿間の隔離を確認する
      → 1冊は指定不要で 200 / 2冊目作成後は 400 `book_required`＋選択肢 / ヘッダ指定 200 / 不在 404 /
        帳簿Bから帳簿Aの仕訳 id を引くと 404（隔離）
- [x] 10.4 2冊ある状態でエクスポートと証憑表示（ネイティブ GET）が正しい帳簿を返す
      → `?bookId=` のみでエクスポート 200、zip 内は `books/{bookId}.sqlite`、manifest に bookId/bookName。指定なしは 400
- [x] 10.5 backup → restore を2冊で通す
      → backup `books: 2/2 ✓` → 帳簿Bを削除 → `--apply` で復元、pre-restore へ退避。0冊 backup は exit 1
- [x] 10.6 `openspec validate rename-users-to-books --strict` が通る
