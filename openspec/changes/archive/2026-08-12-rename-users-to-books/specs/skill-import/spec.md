## MODIFIED Requirements

### Requirement: 巡回対象と差分起点の提示

システムは `GET /skill/linked-services` で、連携済みの EC・銀行・カードのチャネルと差分取得の起点を返す SHALL。
対象帳簿の解決は [[books]] の規約に従う。

#### Scenario: チャネルと fetchSince を返す

- **WHEN** 同一マシンの取込スキルが `GET /skill/linked-services` を呼ぶ
- **THEN** `services[]`（EC・未払金チャネル）・`bankAccounts[]`（普通預金）・`cards[]`（未払金カード）を返す
- **AND** 各要素に `source`・`accountRef`・`displayName`・`lastImportedAt`・`fetchSince` を含める
- **AND** `fetchSince` は `max(直近取得済みの取引日, openFiscalYear.startDate)` とする

#### Scenario: 会計年度が無くても 200 を返す

- **WHEN** open な会計年度が存在しない
- **THEN** `openFiscalYear: null` を含む 200 を返す（実際のゲートは投入 API が担う）

#### Scenario: 帳簿が複数あるときは指定を求める

- **WHEN** 帳簿が2冊以上あり、スキルが帳簿を指定せずに `/skill/*` を呼ぶ
- **THEN** 400 を返して取込を行わず、選択可能な帳簿の `id` と `name` を返す
- **AND** スキルはそれを人へ提示して指定を仰ぐ
