## MODIFIED Requirements

### Requirement: フルデータエクスポート

システムは利用者自身が全データを1つの zip としてダウンロードできる SHALL。

#### Scenario: DB と証憑と manifest を zip で返す

- **WHEN** ローカルの利用者が `GET /api/export` を呼ぶ
- **THEN** `manifest.json`（exportedAt・DB の sha256・ファイル数）・`users/{userId}.sqlite`（WAL 整合スナップショット）・`users/{userId}/attachments/**` を含む zip を返す
- **AND** `Content-Type: application/zip` と RFC5987 でエンコードしたファイル名を付ける

#### Scenario: セルフホストへそのまま復元できる形にする

- **WHEN** zip を解凍して `users/` を別環境の `$DATA_DIR` に配置する
- **THEN** セルフホストの Kanean がそのデータを読める

#### Scenario: 一時ファイルを残さない

- **WHEN** 送出が完了する、またはクライアントが切断する
- **THEN** `$DATA_DIR/tmp/` に作った一時 zip を削除する

#### Scenario: 失敗しても内部詳細を返さない

- **WHEN** エクスポート処理が失敗する
- **THEN** 一時ファイルを削除し、500 で汎用エラーメッセージを返す
