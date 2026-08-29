## Purpose

帳簿（1つの会計データファイル＝`$DATA_DIR/books/{id}.sqlite`）の作成・一覧・改名と、
リクエストがどの帳簿を対象とするかを決める規約を定める。1インスタンスで複数の帳簿を持てること
（税理士が顧問先を N 冊持つ想定）と、その選択が曖昧なまま処理されないことを保証する。
（[docs/architecture.md] §4/§5）

## ADDED Requirements

### Requirement: 帳簿の一覧と作成

システムは帳簿の一覧を返し、新しい帳簿を作成できる SHALL。作成時に data plane を初期化する。

#### Scenario: 帳簿を一覧する

- **WHEN** `GET /api/books` を呼ぶ
- **THEN** 各帳簿の `id`・`name`・`createdAt` を返す

#### Scenario: 帳簿を作成する

- **WHEN** `POST /api/books` に `name` を送る
- **THEN** ULID を採番して `books` に行を作成する
- **AND** `$DATA_DIR/books/{id}.sqlite` を作成し、最新スキーマへマイグレーションして標準シードを投入する
- **AND** 作成した帳簿の `id` と `name` を返す

#### Scenario: 起動時に最初の帳簿を用意する

- **WHEN** `books` が空の状態でサーバが起動する
- **THEN** `マイ帳簿` という名前の帳簿を1冊作成し、その data plane を初期化する

#### Scenario: 帳簿を改名する

- **WHEN** `PATCH /api/books/:id` に `name` を送る
- **THEN** 当該帳簿の `name` を更新する
- **AND** data plane のファイル名は変更しない（id とファイル名は不変）

#### Scenario: 帳簿の削除は提供しない

- **WHEN** 帳簿を削除する API を探す
- **THEN** そのようなエンドポイントは存在しない（税務データの消失は不可逆なため、ファイルの手動削除に委ねる）

### Requirement: 対象帳簿の解決

システムは各リクエストの対象帳簿を、ヘッダ・クエリ・暗黙の順で解決する SHALL。
いずれでも一意に定まらない場合は、推測せずエラーとする。

#### Scenario: ヘッダで指定する

- **WHEN** `X-Book-Id` ヘッダを伴うリクエストが到達する
- **THEN** その帳簿の data plane に対して処理する

#### Scenario: クエリで指定する

- **WHEN** `X-Book-Id` が無く `?bookId=` が指定されている
- **THEN** その帳簿の data plane に対して処理する
- **AND** これによりブラウザネイティブの GET（エクスポート zip・証憑ダウンロード）も帳簿を指定できる

#### Scenario: 1冊しか無ければ指定を省略できる

- **WHEN** ヘッダもクエリも無く、帳簿が1冊しか存在しない
- **THEN** その帳簿を対象として処理する

#### Scenario: 曖昧なら拒否する

- **WHEN** ヘッダもクエリも無く、帳簿が2冊以上存在する
- **THEN** 400 を返し、いずれの帳簿にも書き込まない
- **AND** 応答に選択可能な帳簿の `id` と `name` を含める（呼び出し側が人へ提示できるようにする）

#### Scenario: 存在しない帳簿を指定する

- **WHEN** `books` に存在しない id を指定する
- **THEN** 404 を返す

### Requirement: 帳簿間のデータ隔離

システムは帳簿ごとに物理ファイルを分離し、ある帳簿の操作が別の帳簿に到達しないことを構造的に保証する SHALL。

#### Scenario: 解決した帳簿のファイルのみを参照する

- **WHEN** 任意の会計 API を呼ぶ
- **THEN** 解決した `bookId` の `$DATA_DIR/books/{bookId}.sqlite` のみを開く
- **AND** クエリに帳簿の条件を必要としない

#### Scenario: 他の帳簿の行 id を指定しても届かない

- **WHEN** ある帳簿の文脈で、別の帳簿にしか存在しない行 id を指定する
- **THEN** 別ファイルであるため 404 相当となる

#### Scenario: 帳簿 id の形式を検証する

- **WHEN** ULID 形式でない `bookId` でファイルパスを組み立てようとする
- **THEN** 拒否し、`$DATA_DIR` の外へ到達させない
