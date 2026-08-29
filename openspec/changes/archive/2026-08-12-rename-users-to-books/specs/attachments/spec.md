## MODIFIED Requirements

### Requirement: 証憑のアップロード

システムは仕訳に対して証憑ファイルを添付し、内容ハッシュとメタを記録する SHALL。

#### Scenario: 生バイナリで受け取る

- **WHEN** `POST /api/entries/:id/attachments?fileName=...` に Content-Type ヘッダと生バイト列を送る
- **THEN** ファイルを帳簿ごとのディレクトリ（`$DATA_DIR/books/{bookId}/attachments/`）へ保存し、`fileName`・`contentType`・`fileSize`・`sha256`・`uploadedAt` を記録して返す

#### Scenario: 受理する形式を限定する

- **WHEN** PDF・JPEG・PNG・HEIC/HEIF 以外の Content-Type で送る
- **THEN** 400 を返し保存しない

#### Scenario: サイズ上限を超えるものを拒否する

- **WHEN** 1ファイルが 20MB を超える
- **THEN** 400 を返し保存しない（API 全体のボディ上限 25MB を超える場合は 413）

#### Scenario: 不正なパスを構造的に排除する

- **WHEN** ファイル名にディレクトリ区切りや相対パスが含まれる
- **THEN** 保存先は帳簿ごとのディレクトリ内に限定され、外部へ書き出さない

### Requirement: 証憑の参照とダウンロード

システムは仕訳に紐づく証憑を一覧し、内容をダウンロードできる SHALL。

#### Scenario: 添付を一覧する

- **WHEN** `GET /api/entries/:id/attachments` を呼ぶ
- **THEN** 当該仕訳の添付メタを返す（内部の保存パスは返さない）

#### Scenario: 添付を表示する

- **WHEN** `GET /api/attachments/:id/download`（2冊以上あるときは `?bookId=`）を呼ぶ
- **THEN** 記録された Content-Type と RFC5987 でエンコードしたファイル名を付けて `inline` で返す

#### Scenario: 実体が失われている場合

- **WHEN** メタは存在するがファイル実体が見つからない
- **THEN** 404 を返す

#### Scenario: 他の帳簿の証憑に到達できない

- **WHEN** 別の帳簿にしか存在しない添付 id を指定する
- **THEN** 物理的に別 DB・別ディレクトリであるため 404 を返す
