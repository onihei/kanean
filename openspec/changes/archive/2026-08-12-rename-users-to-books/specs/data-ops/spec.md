## MODIFIED Requirements

### Requirement: WAL 整合バックアップ

システムは control plane と全帳簿 DB を、稼働中でも整合するオンラインバックアップで取得する SHALL。

#### Scenario: スナップショットを取得する

- **WHEN** `pnpm --filter @kanean/server backup [retention]` を実行する
- **THEN** better-sqlite3 の `.backup()` で `$DATA_DIR/backups/{timestamp}/` へ control.sqlite と全 `books/*.sqlite` を書き出す
- **AND** 各帳簿の証憑ディレクトリ（`books/{id}/attachments/`）を同梱する
- **AND** 帳簿ごとの結果を control plane の `backup_status` に記録する

#### Scenario: 破損を検知して成功扱いしない

- **WHEN** スナップショットの `PRAGMA integrity_check` が `ok` を返さない
- **THEN** 当該帳簿を失敗として記録し、破損スナップショットを残さない

#### Scenario: DATA_DIR 誤設定を検知する

- **WHEN** `control.sqlite` が存在しない（DATA_DIR の設定ミス）
- **THEN** 非0終了で中断し、空DBの偽バックアップを作らない

#### Scenario: 帳簿0冊を成功扱いしない

- **WHEN** バックアップ対象の帳簿が1冊も見つからない
- **THEN** 非0終了で中断し、中身のないバックアップセットを残さない

#### Scenario: 世代を種別ごとに保持する

- **WHEN** cron 実行と deploy 前実行が混在する
- **THEN** `cron` / `deploy` の種別ごとに世代（既定30）を数えて古いセットのみ削除する

#### Scenario: 全 DB 失敗の run を残さない

- **WHEN** その run のすべての DB がバックアップに失敗する
- **THEN** ディレクトリごと破棄し、正常な旧バックアップを世代保持で追い出さない

### Requirement: スナップショットからの復元

システムは復元をサーバ停止中の明示操作として提供し、現行データを退避してから配置する SHALL。

#### Scenario: スナップショットを一覧・検証する

- **WHEN** `pnpm --filter @kanean/server restore` を引数なしで実行する
- **THEN** timestamp・帳簿数・integrity 検証結果を一覧する

#### Scenario: dry-run で内容を確認する

- **WHEN** `restore <timestamp>` を `--apply` なしで実行する
- **THEN** 復元内容を表示するだけで、現行データを一切変更しない

#### Scenario: 適用時に現行データを退避する

- **WHEN** `restore <timestamp> --apply` を実行する
- **THEN** 現行の control.sqlite・books（DB・WAL/SHM・attachments）を `$DATA_DIR/pre-restore-{now}/` へ退避する
- **AND** スナップショットを**コピー**で配置し、バックアップセット自体は温存する（やり直し可能）

#### Scenario: 破損スナップショットの適用を拒否する

- **WHEN** 適用対象のスナップショットが integrity_check に失敗する
- **THEN** 適用前に拒否し、現行データには一切触れない

#### Scenario: スナップショットに無い帳簿も時点復元に含める

- **WHEN** スナップショット取得後に作成された帳簿が存在する
- **THEN** その DB・証憑も退避し、スナップショット時点の状態へ戻す

### Requirement: フルデータエクスポート

システムは利用者が対象帳簿の全データを1つの zip としてダウンロードできる SHALL。

#### Scenario: DB と証憑と manifest を zip で返す

- **WHEN** ローカルの利用者が `GET /api/export`（2冊以上あるときは `?bookId=`）を呼ぶ
- **THEN** `manifest.json`（exportedAt・bookId・bookName・DB の sha256・ファイル数）・`books/{bookId}.sqlite`（WAL 整合スナップショット）・`books/{bookId}/attachments/**` を含む zip を返す
- **AND** `Content-Type: application/zip` と RFC5987 でエンコードしたファイル名を付ける

#### Scenario: セルフホストへそのまま復元できる形にする

- **WHEN** zip を解凍して `books/` を別環境の `$DATA_DIR` に配置する
- **THEN** その環境の Kanean がそのデータを読める

#### Scenario: 一時ファイルを残さない

- **WHEN** 送出が完了する、またはクライアントが切断する
- **THEN** `$DATA_DIR/tmp/` に作った一時 zip を削除する

#### Scenario: 失敗しても内部詳細を返さない

- **WHEN** エクスポート処理が失敗する
- **THEN** 一時ファイルを削除し、500 で汎用エラーメッセージを返す

### Requirement: マイグレーションの適用

システムはスキーマ変更を control plane と全帳簿 DB に整合的に適用する SHALL。

#### Scenario: デプロイ時に全 DB へ適用する

- **WHEN** `node packages/server/dist/migrate.js` を実行する
- **THEN** control plane と全 `books/*.sqlite` に冪等にマイグレーションを適用し、失敗時は非0終了する

#### Scenario: 起動時・オープン時にも追いつく

- **WHEN** 新しい帳簿の DB を初めて開く、または既存 DB を `DbRouter.bookDb()` が開く
- **THEN** 最新スキーマまで適用し、シードの不足分を冪等に補う

#### Scenario: 壊れた状態へ migrate をかけない

- **WHEN** デプロイ手順でバックアップが失敗する
- **THEN** マイグレーションと再起動を行わずデプロイを中断する
