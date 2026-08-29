# journal Specification

## Purpose

複式簿記の仕訳を唯一の真実源として管理する。取込明細からの自動仕訳（draft）生成、
レビュー・確定、手入力の複合仕訳、消費税区分の自動付与、確定後の訂正・削除と監査ログ、
自動仕訳ルールの管理を担う。帳簿・決算・申告はすべて `status='confirmed'` の仕訳のみを集計する。
（[docs/accounting-spec.md] §1/§4・[docs/csv-format.md] §5・[docs/PRD.md] F-JNL）

## Requirements

### Requirement: 複式簿記の不変条件

システムは1仕訳内で Σ借方金額 = Σ貸方金額 を満たす場合にのみ仕訳を永続化する SHALL。借方N:貸方M の複合仕訳を許容する。

#### Scenario: 貸借不一致を拒否する

- **WHEN** 借方合計と貸方合計が一致しない明細で起票する
- **THEN** 400 を返し、仕訳を作成しない

#### Scenario: 複合仕訳を起票する

- **WHEN** `POST /api/entries` に借方N行・貸方M行の明細を送る
- **THEN** 貸借一致を検証したうえで1件の仕訳として作成し、id を 201 で返す

#### Scenario: 金額は円整数のみ

- **WHEN** 明細金額に小数・非安全整数が含まれる
- **THEN** 400 を返す

### Requirement: 会計期間ゲート

システムは open 年度の `[start_date, end_date]` に含まれる `entry_date` の仕訳のみを起票・編集できる SHALL。

#### Scenario: 期間外の起票を拒否する

- **WHEN** open 年度の範囲外の日付で仕訳を起票する
- **THEN** 400 を返す

#### Scenario: closed 年度は変更できない

- **WHEN** closed 年度に属する仕訳の編集・確定取消・削除を試みる
- **THEN** 400 を返す

### Requirement: 取込明細からの自動仕訳

システムは取込バッチの `raw_transactions` から draft 仕訳を生成する SHALL。取込元口座の補助科目を一脚に置き、相手科目を推測する。
生成する仕訳の `entry_date` は、その仕訳が属する会計年度の `[start_date, end_date]` に入らなければならない
（手入力・編集と同じ会計期間ゲート）。範囲外になる明細は仕訳化しない。

#### Scenario: 方向から貸借を決める

- **WHEN** 入金（in）の明細を仕訳化する
- **THEN** 取込元口座科目を借方、相手科目を貸方に置く（出金は逆）

#### Scenario: 相手科目の推測順序に従う

- **WHEN** 相手科目を決定する
- **THEN** ユーザー定義ルール（`auto_journal_rules`・priority 昇順）→ 履歴学習（`mapping_history`・hit_count 降順）→ 金融機関既定（institution）→ `未確定勘定` の順に解決する

#### Scenario: 金融機関特有の既定仕訳を当てる

- **WHEN** 受取利息（税引前利息）・利息の源泉（同日に利息がある「国税」「地方税」）・消費税納付（`税金 シヨウヒゼイ`）が現れる
- **THEN** それぞれ 貸)事業主借 / 借)事業主貸 / 借)租税公課 を相手科目とする draft（`source='auto_institution'`）を生成する
- **AND** 摘要照合は NFKC 正規化して行い、保存値（`description`・`dedup_hash`・履歴 `pattern`）は変更しない

#### Scenario: 推測できない明細を未確定勘定に置く

- **WHEN** ルール・履歴・既定のいずれにも一致しない
- **THEN** 相手科目を `未確定勘定` として draft を生成する（黙って確定しない）

#### Scenario: 会計年度の範囲外の明細を仕訳化しない

- **WHEN** 明細の `txn_date` が開いている会計年度の `[start_date, end_date]` に入らない
- **THEN** 仕訳を生成せず、明細の状態も変えない

#### Scenario: 単発の仕訳化は範囲外を拒否する

- **WHEN** 1件を指定して仕訳化する（取込明細の復帰など）操作で、その明細が範囲外である
- **THEN** 400 を返し、日付と会計年度の範囲を示す

#### Scenario: バッチの仕訳化は範囲外だけを飛ばす

- **WHEN** バッチ単位で仕訳化し、範囲内と範囲外の明細が混在する
- **THEN** 範囲内をすべて仕訳化し、範囲外は仕訳化せず、その件数を結果に含めて返す（1件で全体を失敗させない）

#### Scenario: どの取込トラックでも同じゲートが効く

- **WHEN** 銀行・カード CSV、EC スキル、銀行スキルのいずれの経路で仕訳化する
- **THEN** 同一の会計期間ゲートが適用される

### Requirement: 消費税区分の自動付与

システムは明細の税区分を「明示指定 > 補助科目の既定 > 勘定科目の既定」の順に解決し、課税区分では税額を算出する SHALL。

#### Scenario: 既定税区分を継承する

- **WHEN** 税区分未指定の明細を起票する
- **THEN** 補助科目の `default_tax_category_id`、無ければ勘定科目の既定を採用する
- **AND** 補助科目が当該勘定科目に属さない場合はその既定を採用しない

#### Scenario: 税込金額から内税を逆算する

- **WHEN** 税込経理で課税区分（税率あり）の明細を起票する
- **THEN** `tax_amount = 金額 − 金額 ÷ (1 + rate/100)` を算出する
- **AND** 端数処理は売上=`rounding_sales` / 仕入=`rounding_purchase`（既定 floor）に従う

#### Scenario: 非課税・対象外は税額を持たない

- **WHEN** 非課税・対象外、または税率を持たない税区分である
- **THEN** `tax_amount` を null とする

### Requirement: draft のレビューと確定

システムは取込由来の draft を根拠付きで一覧し、明細の科目修正と確定を提供する SHALL。

#### Scenario: 根拠を添えて draft を一覧する

- **WHEN** `GET /api/drafts` を呼ぶ
- **THEN** open 年度の draft を明細・科目名とともに返し、各件に由来（`origin`: source / reason / confidence / evidence）を添える

#### Scenario: レビュー用に絞り込む

- **WHEN** `subAccountId` / `from` / `to` / `q` / `confidence` を指定する
- **THEN** 該当条件で絞り込む
- **AND** 日付が `YYYY-MM-DD` 形式でない、または `confidence` が high/medium/low 以外なら 400 を返す（黙って全件表示に化けさせない）

#### Scenario: 明細の科目を修正する

- **WHEN** `PATCH /api/lines/:lineId` に `accountId` / `subAccountId` / `taxCategoryId` を送る
- **THEN** 当該明細を更新する（確定済み仕訳は直接編集させない）

#### Scenario: 1件を確定する

- **WHEN** `POST /api/entries/:id/confirm` を呼ぶ
- **THEN** 貸借一致を検証して `confirmed` にし、対応する取込明細を `journalized` にする
- **AND** 学習対象であれば `mapping_history` に書き戻す

#### Scenario: 一括確定は部分成功を許す

- **WHEN** `POST /api/entries/confirm-batch` に最大500件の id 配列を送る
- **THEN** 1件ずつ独立に確定し、失敗した件はエラーを記録して続行し、`confirmed` / `failed` 件数と結果配列を返す

### Requirement: 確定済み仕訳の検索・訂正・削除

システムは確定済み仕訳を検索でき、訂正は「確定取消 → 編集 → 確定」の経路のみを許す SHALL。

#### Scenario: 仕訳を検索する

- **WHEN** `GET /api/entries?status=&from=&to=&q=&accountId=&limit=` を呼ぶ
- **THEN** 条件に一致する仕訳を明細付きで返す（`status` 既定は `confirmed`）

#### Scenario: 確定済みは直接編集できない

- **WHEN** `PUT /api/entries/:id` で確定済み仕訳の編集を試みる
- **THEN** 400 を返す

#### Scenario: 確定取消してから編集する

- **WHEN** `POST /api/entries/:id/unconfirm` の後に `PUT /api/entries/:id` を呼ぶ
- **THEN** draft に戻したうえで明細を差し替え、貸借一致と期間ゲートを再検証する

#### Scenario: 仕訳を削除する

- **WHEN** `DELETE /api/entries/:id` を呼ぶ
- **THEN** 物理削除する

### Requirement: 訂正・削除の監査ログ

システムは仕訳の編集・確定取消・削除を before/after スナップショット付きで `audit_logs` に記録する SHALL。

#### Scenario: 変更履歴を残す

- **WHEN** 編集・確定取消・削除のいずれかを実行する
- **THEN** 操作種別・対象 id・変更前後のスナップショット・任意の note を記録する

#### Scenario: 削除後も原状を追える

- **WHEN** 削除された仕訳の履歴を `GET /api/audit-logs?targetId=` で参照する
- **THEN** 削除前のスナップショットを含む履歴を返す

### Requirement: 自動仕訳ルールの管理

システムは摘要・金額・方向の条件から相手科目を決めるルールを CRUD で管理する SHALL。

#### Scenario: ルールを作成する

- **WHEN** `POST /api/rules` に `name`・`matchValue`・`resultAccountId`（＋ `matchField`/`matchOp`/`direction`/`priority`）を送る
- **THEN** ルールを作成し、以後の仕訳化で priority 昇順に評価する

#### Scenario: ルールを無効化・削除する

- **WHEN** `POST /api/rules/:id/active` に `isActive:false`、または `DELETE /api/rules/:id` を呼ぶ
- **THEN** 当該ルールを以後のサジェストから除外する

### Requirement: 源泉徴収された報酬売上の起票

システムは源泉徴収された報酬の売上を複合仕訳として起票する SHALL。

#### Scenario: 源泉税額を事業主貸で計上する

- **WHEN** `POST /api/tax-return/withholding-sale` に `entryDate` と `gross` を送る
- **THEN** 借)入金科目（総額−源泉）／借)事業主貸（源泉所得税）／貸)売上（総額）の複合仕訳を生成する
- **AND** 源泉税額は 100万円以下の部分に 10.21%、超過部分に 20.42% を適用し円未満を切り捨てる
