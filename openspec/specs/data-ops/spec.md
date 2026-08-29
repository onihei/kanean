# data-ops Specification

## Purpose

データ保全と可搬性の運用基盤。control plane と全 data plane の WAL 整合スナップショット取得（バックアップ）、
スナップショットからの復元（リストア）、帳簿単位の全データ zip エクスポートとその取り込み、
帳簿ごとの DB へのマイグレーション適用を担う。「解約＝データ人質」にしないことを構造的な要件とする。
持ち出し（エクスポート／取り込み・帳簿1冊・別環境向け）と巻き戻し（バックアップ／リストア・環境まるごと・同一環境向け）は
用途の異なる別系統であり、互いに代替しない。
（[docs/architecture.md] §11/§11.1/§12.3・[docs/roadmap.md] Phase 5 slice10/slice11）

## Requirements

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
エクスポートは**単なる控えではなく復元可能な持ち出し**であり、同システムの取り込み経路
（下記「エクスポートの取り込み」）で帳簿として復帰できることをもって成立する。

#### Scenario: DB と証憑と manifest を zip で返す

- **WHEN** ローカルの利用者が `GET /api/export`（2冊以上あるときは `?bookId=`）を呼ぶ
- **THEN** `manifest.json`（exportedAt・bookId・bookName・DB の sha256・ファイル数）・`books/{bookId}.sqlite`（WAL 整合スナップショット）・`books/{bookId}/attachments/**` を含む zip を返す
- **AND** `Content-Type: application/zip` と RFC5987 でエンコードしたファイル名を付ける

#### Scenario: 一時ファイルを残さない

- **WHEN** 送出が完了する、またはクライアントが切断する
- **THEN** `$DATA_DIR/tmp/` に作った一時 zip を削除する

#### Scenario: 失敗しても内部詳細を返さない

- **WHEN** エクスポート処理が失敗する
- **THEN** 一時ファイルを削除し、500 で汎用エラーメッセージを返す

### Requirement: エクスポートの取り込み

システムはエクスポート zip を取り込み、**その帳簿を開ける状態に復帰させる** SHALL。
帳簿は control plane の帳簿レジストリへ登録されなければならず、data plane のファイルを
配置しただけの状態（レジストリに載らず画面から不可視）で終わってはならない。

#### Scenario: 別環境へ持ち出して開ける

- **WHEN** ある環境でエクスポートした zip を、別環境の Kanean に取り込む
- **THEN** その帳簿が帳簿一覧に現れ、仕訳・帳票・固定資産が元の環境と同じ内容で参照できる

#### Scenario: 取り込んだ帳簿がレジストリに登録される

- **WHEN** zip を取り込む
- **THEN** 帳簿は control plane に登録され、以後の起動でも一覧に残る
- **AND** 「帳簿が0冊」と誤判定して空の帳簿が新規作成されることはない

#### Scenario: 壊れた zip を黙って取り込まない

- **WHEN** `manifest.json` の `sha256` と実データが一致しない、または `manifest.json` を欠く zip を取り込む
- **THEN** 取り込みを中止し、理由を提示する
- **AND** 既存の帳簿をいっさい変更しない

#### Scenario: 既存の帳簿を黙って上書きしない

- **WHEN** 取り込もうとする `bookId` が既に登録済みである
- **THEN** 黙って置換せず、利用者に扱い（別帳簿として取り込む／明示的に置換する）を選ばせる

#### Scenario: 置換しても直前のデータを失わない

- **WHEN** 利用者が既存の帳簿を明示的に置換して取り込む
- **THEN** 置換前の DB と証憑を `$DATA_DIR/pre-import-{now}/` へ退避してから配置し、退避先を利用者に提示する
- **AND** 退避したデータは自動削除しない（取り違えに気づいた利用者が取り戻せる）

#### Scenario: 配置の途中で失敗しても中途半端な状態を残さない

- **WHEN** 置換の配置中に失敗する
- **THEN** 退避したデータを元の位置へ戻し、取り込む前の状態に復帰させる
- **AND** 復帰できなかった場合は退避先の場所を提示する（黙って失わない）

#### Scenario: 証憑を含めて復帰する

- **WHEN** 証憑を含む zip を取り込む
- **THEN** 各仕訳の証憑が取り込み後も参照・ダウンロードできる

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

