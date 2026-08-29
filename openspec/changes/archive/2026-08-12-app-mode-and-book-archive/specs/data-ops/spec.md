## MODIFIED Requirements

### Requirement: WAL 整合バックアップ

システムは control plane と全帳簿 DB を、稼働中でも整合するオンラインバックアップで取得する SHALL。
対象は data plane に存在する全帳簿であり、アーカイブ状態で絞り込まない。

#### Scenario: スナップショットを取得する

- **WHEN** `pnpm --filter @kanean/server backup [retention]` を実行する
- **THEN** better-sqlite3 の `.backup()` で `$DATA_DIR/backups/{timestamp}/` へ control.sqlite と全 `books/*.sqlite` を書き出す
- **AND** 各帳簿の証憑ディレクトリ（`books/{id}/attachments/`）を同梱する
- **AND** 帳簿ごとの結果を control plane の `backup_status` に記録する

#### Scenario: アーカイブ済み帳簿も対象に含める

- **WHEN** アーカイブ済みの帳簿が存在する状態でバックアップを取得する
- **THEN** アーカイブ済みの帳簿もアクティブな帳簿と同様に取得・検証・記録する（データ保全から漏らさない）

#### Scenario: 破損を検知して成功扱いしない

- **WHEN** スナップショットの `PRAGMA integrity_check` が `ok` を返さない
- **THEN** 当該帳簿を失敗として記録し、破損スナップショットを残さない

#### Scenario: DATA_DIR 誤設定を検知する

- **WHEN** `control.sqlite` が存在しない（DATA_DIR の設定ミス）
- **THEN** 非0終了で中断し、空DBの偽バックアップを作らない

#### Scenario: 帳簿0冊を成功扱いしない

- **WHEN** バックアップ対象の帳簿が1冊も見つからない（アーカイブ済みを含めて0冊）
- **THEN** 非0終了で中断し、中身のないバックアップセットを残さない

#### Scenario: 世代を種別ごとに保持する

- **WHEN** cron 実行と deploy 前実行が混在する
- **THEN** `cron` / `deploy` の種別ごとに世代（既定30）を数えて古いセットのみ削除する

#### Scenario: 全 DB 失敗の run を残さない

- **WHEN** その run のすべての DB がバックアップに失敗する
- **THEN** ディレクトリごと破棄し、正常な旧バックアップを世代保持で追い出さない

### Requirement: マイグレーションの適用

システムはスキーマ変更を control plane と全帳簿 DB に整合的に適用する SHALL。
対象は data plane に存在する全帳簿であり、アーカイブ状態で絞り込まない。

#### Scenario: デプロイ時に全 DB へ適用する

- **WHEN** `node packages/server/dist/migrate.js` を実行する
- **THEN** control plane と全 `books/*.sqlite` に冪等にマイグレーションを適用し、失敗時は非0終了する

#### Scenario: アーカイブ済み帳簿も追いつかせる

- **WHEN** アーカイブ済みの帳簿が存在する状態でマイグレーションを適用する
- **THEN** アーカイブ済みの帳簿にも適用する（復帰したときに古いスキーマのまま開けない状態を作らない）

#### Scenario: 起動時・オープン時にも追いつく

- **WHEN** 新しい帳簿の DB を初めて開く、または既存 DB を `DbRouter.bookDb()` が開く
- **THEN** 最新スキーマまで適用し、シードの不足分を冪等に補う

#### Scenario: 壊れた状態へ migrate をかけない

- **WHEN** デプロイ手順でバックアップが失敗する
- **THEN** マイグレーションと再起動を行わずデプロイを中断する
