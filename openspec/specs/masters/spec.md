# masters Specification

## Purpose

会計データの軸となるマスタ（勘定科目・補助科目・税区分・取引先・部門・品目・タグ）、
事業者設定（`business_settings`）、および連携サービスの登録カタログを管理する。
削除は原則として論理削除（`isActive`）とし、参照済みデータの整合を壊さない。
（[docs/data-model.md]・[docs/accounting-spec.md] §1.2/§2・[docs/roadmap.md] Phase 1）

## Requirements

### Requirement: 勘定科目と税区分の参照

システムは有効な勘定科目と税区分を、分類・表示区分つきで参照できる SHALL。

#### Scenario: 勘定科目を一覧する

- **WHEN** `GET /api/accounts` を呼ぶ
- **THEN** 有効な科目を `id`・`name`・`normalBalance`・`category`（分類名）・`reportType`（BS/PL）とともに返す

#### Scenario: 税区分を一覧する

- **WHEN** `GET /api/tax-categories` を呼ぶ
- **THEN** 有効な税区分を `code`・`label`・`taxability`・`direction`・`rate` とともに返す

### Requirement: 補助科目の管理

システムは勘定科目配下の補助科目を管理し、既定税区分・取引先・取込口座参照を保持する SHALL。

#### Scenario: 補助科目を作成・更新する

- **WHEN** `POST /api/sub-accounts` / `PUT /api/sub-accounts/:id` に `accountId`・`name`（＋ `defaultTaxCategoryId`・`counterpartyId`）を送る
- **THEN** 当該勘定科目配下に補助科目を作成・更新する

#### Scenario: 勘定科目で絞り込む

- **WHEN** `GET /api/sub-accounts?accountId=` を呼ぶ
- **THEN** 当該勘定配下の補助科目のみを返す（`includeInactive=1` で無効も含める）

#### Scenario: 取引先別の補助科目を get-or-create する

- **WHEN** `POST /api/sub-accounts/by-counterparty` に `accountId`・`counterpartyId` を送る
- **THEN** 既存があればその id を返し、無ければ作成して返す（開始残高と請求書起票が同一の補助科目に収束する）

### Requirement: 取引先・部門・品目・タグの管理

システムはこれらのマスタを CRUD で管理し、仕訳明細や書類から参照できる SHALL。

#### Scenario: 取引先を管理する

- **WHEN** `POST /api/counterparties` / `PUT /api/counterparties/:id` を呼ぶ
- **THEN** 名称と適格請求書登録番号（`invoice_reg_no`）等を保存する

#### Scenario: 論理削除で無効化する

- **WHEN** `POST /api/{counterparties|sub-accounts|departments|items}/:id/active` に `isActive:false` を送る
- **THEN** 当該マスタを無効化し、既定では一覧から除外する（`includeInactive=1` で表示）

#### Scenario: タグのみ物理削除する

- **WHEN** `DELETE /api/tags/:id` を呼ぶ
- **THEN** タグを物理削除する

#### Scenario: 名称必須を検証する

- **WHEN** `name` の無いリクエストを送る
- **THEN** 400 を返す

### Requirement: 事業者設定

システムは経理方式・端数処理・簡易課税の事業区分・償却の記帳方法などの事業者設定を単一行として保持し、更新できる SHALL。

#### Scenario: 設定を取得・更新する

- **WHEN** `GET /api/business-settings` / `PUT /api/business-settings` を呼ぶ
- **THEN** 現在の設定を返し、更新後は更新後の設定を返す

#### Scenario: 不正な値を拒否する

- **WHEN** 許容外の値（未知の経理方式・端数処理等）を送る
- **THEN** 400 を返し、設定を変更しない

### Requirement: 連携サービスの登録

システムはカタログ駆動で連携サービス（EC・銀行・カード）を登録し、対応する補助科目チャネルを自動作成する SHALL。

#### Scenario: カタログを参照する

- **WHEN** `GET /api/services/catalog` を呼ぶ
- **THEN** 登録可能なサービス（`kind`＝ec/bank/card と親勘定科目を含む）を返す

#### Scenario: サービスを登録する

- **WHEN** `POST /api/services` に `serviceKey` を送る
- **THEN** 親勘定科目（EC/カード＝未払金、銀行＝普通預金）配下に `linked_account_ref` と `import_source_type` を持つ補助科目を作成する
- **AND** 以後 `GET /api/services` と `/skill/linked-services` の巡回対象に現れる

#### Scenario: 未知のサービスキーを拒否する

- **WHEN** カタログに無い `serviceKey` を送る
- **THEN** 400 を返す
