# tax-return Specification

## Purpose

confirmed 仕訳と決算整理を入力源に、青色申告決算書（一般用・4ページ）・確定申告書（第一表・第二表）・
消費税及び地方消費税申告書（簡易課税）を組成し、PDF として出力する。
税額計算は `packages/core` の純関数に委譲し、ゴールデンテスト（簡易課税：税抜1000万@10% → 国390k／地方110k／合計500k）で固定する。
本機能の出力は **`legalRisk:high` の参考値**であり、システムが単独で「提出可能」を宣言しない（税理士サインオフが前提）。
（[docs/form-mapping.md]・[docs/accounting-spec.md] §3/§5・[docs/roadmap.md] Phase 4）

## Requirements

### Requirement: 青色申告決算書の組成

システムは青色申告決算書の損益ページ・貸借対照表・各内訳ページを、様式ボックスに対応づけた形で組成する SHALL。

#### Scenario: 損益ページを様式ボックスで返す

- **WHEN** `GET /api/reports/blue-statement` を呼ぶ
- **THEN** `statement_line_code` 集計に基づく損益の様式ボックス（code/label/box/amount）を返す

#### Scenario: 4ページ分をまとめて返す

- **WHEN** `GET /api/tax-return/blue-statement` を呼ぶ
- **THEN** 損益・貸借対照表（期首は `opening_balances`、期末は残高）・青色申告特別控除の計算・月別売上仕入・給料賃金・専従者給与・地代家賃・減価償却費・貸倒引当金の各内訳を一括で返す

#### Scenario: 内訳を個別に取得する

- **WHEN** `GET /api/reports/breakdown/{depreciation|salary|rent|senju|monthly-sales-purchase}` を呼ぶ
- **THEN** 各内訳ページのデータを返し、合計は損益の対応行と一致する

### Requirement: 青色申告特別控除の判定

システムは控除前所得（㊸）から青色申告特別控除額（㊹）と所得金額（㊺）を算出する SHALL。

#### Scenario: 電子要件の設定で限度額が変わる

- **WHEN** `POST /api/tax-return/blue-deduction/settings` に `qualifiesFor65` を設定して `GET /api/tax-return/blue-deduction` を呼ぶ
- **THEN** 複式簿記を前提に、電子要件（e-Tax 提出または優良な電子帳簿）を満たす設定なら 65 万円、満たさなければ 55 万円を限度額とする
- **AND** 既定は保守的に 55 万円（`qualifiesFor65=false`）とする

#### Scenario: 控除前所得を超えない

- **WHEN** 控除前所得が限度額を下回る
- **THEN** 控除額は控除前所得までとし、所得金額（㊺）が負にならない

#### Scenario: 判定根拠を返す

- **WHEN** 控除の計算結果を取得する
- **THEN** 限度額・控除額・所得金額に加え、申告区分と判定根拠（basis）を返す

### Requirement: 確定申告書（第一表・第二表）の組成

システムは事業所得と所得控除入力・源泉徴収税額から所得税額と申告納税額を算出する SHALL（事業所得単独前提）。

#### Scenario: 所得控除を入力・保存する

- **WHEN** `POST /api/tax-return/income-tax/inputs` に基礎控除・社会保険料・生命保険料・医療費・配偶者/扶養・その他・予定納税額を送る
- **THEN** open 年度の `tax_return_inputs` として保存する

#### Scenario: 税額を算出する

- **WHEN** `GET /api/tax-return/income-tax` を呼ぶ
- **THEN** 事業所得（㊺）と所得控除合計から課税所得（千円未満切捨て）を求め、累進税率と復興特別所得税を適用して所得税額を算出する
- **AND** 帳簿から集計した源泉徴収税額（事業主貸／源泉所得税）と予定納税額を控除し、納付または還付を分岐する

### Requirement: 消費税申告書（簡易課税）の組成

システムは税区分別の課税売上集計から、簡易課税による納付税額を算出する SHALL。

#### Scenario: 税率別に課税標準額を求める

- **WHEN** `GET /api/tax-return/consumption` を呼ぶ
- **THEN** 税区分別の税抜課税売上を税率（10%/8%）別に集計し、課税標準額を千円未満切捨てで確定する

#### Scenario: みなし仕入率で控除税額を求める

- **WHEN** 事業区分（`business_settings.tax_business_category`・既定 第5種＝50%）が設定されている
- **THEN** 売上に係る消費税額 × みなし仕入率を控除対象仕入税額とし、返還等対価・貸倒れに係る税額を控除する
- **AND** 国税・地方消費税・納付税額の合計を付表と第一表の欄構造に整形して返す

#### Scenario: 会計年度が無い場合

- **WHEN** open な会計年度が存在しない
- **THEN** `report: null` を返す

### Requirement: 申告書類の PDF 出力

システムは各様式について、自前レイアウト PDF と官製様式へのオーバーレイ PDF の双方を出力する SHALL。

#### Scenario: 自前レイアウトで出力する

- **WHEN** `GET /api/tax-return/{blue-statement|income-tax|consumption}.pdf` を呼ぶ
- **THEN** 日本語フォントを埋め込んだ PDF を `Content-Type: application/pdf`・`Content-Disposition: inline` で返す

#### Scenario: 官製様式に差し込む

- **WHEN** `GET /api/tax-return/{blue-statement|income-tax|consumption}-official.pdf` を呼ぶ
- **THEN** 公式様式 PDF テンプレートへ座標指定で数値を差し込んだ PDF を返す

#### Scenario: プレビューと PDF の金額が一致する

- **WHEN** 同一年度で画面プレビュー（JSON）と PDF を取得する
- **THEN** 同じ組成関数を用いるため金額は一致する

#### Scenario: 会計年度が無い場合

- **WHEN** open な会計年度が存在しない状態で PDF を要求する
- **THEN** 400 を返す

### Requirement: 参考値であることの明示

システムは申告関連の出力を税理士サインオフ前の参考値として扱う SHALL。

#### Scenario: 提出可能を宣言しない

- **WHEN** 決算書・申告書・消費税申告の値を提示する
- **THEN** 自動確定・自動提出は行わず、最終確認は人（税理士）に委ねる
