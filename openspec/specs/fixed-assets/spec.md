# fixed-assets Specification

## Purpose

固定資産台帳と減価償却を担う。資産登録、償却スケジュールの算定（定額法・定率法・一括償却・少額特例）、
期末の償却仕訳起票、除却・売却の処理、中古資産の見積耐用年数の算定を提供する。
償却計算そのものは `packages/core` の純関数に隔離し、ゴールデンテスト（マツダ2＝償却 439,919／必要経費 219,960／残高 1）で固定する。
（[docs/depreciation-spec.md]・[docs/accounting-spec.md] §8）

## Requirements

### Requirement: 固定資産の登録と償却方式

システムは取得価額・取得日・事業供用開始日・耐用年数・償却方法・事業利用比率を持つ資産を登録する SHALL。

#### Scenario: 資産を登録する

- **WHEN** `POST /api/fixed-assets` に資産情報を送る
- **THEN** 資産を作成して id を 201 で返す

#### Scenario: 償却方式を選べる

- **WHEN** `depreciation_method` に `straight_line` / `declining_balance` / `lump_sum` / `minor_special` を指定する
- **THEN** それぞれ 定額法 / 200%定率法 / 一括償却（3年均等） / 少額減価償却資産特例（即時経費）として扱う

#### Scenario: 不正な入力を拒否する

- **WHEN** 必須項目の欠落や解釈不能な値を送る
- **THEN** 400 を返し、資産を作成しない

### Requirement: 償却スケジュールの算定

システムは資産ごとの年次償却スケジュール（期首残高・本年分償却費・必要経費算入額・期末残高）を算定する SHALL。

#### Scenario: 定額法で償却する

- **WHEN** 定額法の資産のスケジュールを `GET /api/fixed-assets/:id/schedule` で取得する
- **THEN** 各年の償却費を「取得価額 × 定額法償却率」で算定する

#### Scenario: 初年度は月割し円未満を切り上げる

- **WHEN** 年の途中で事業供用を開始した資産を償却する
- **THEN** 供用月数（端数日は1月に切上げ）で按分し、円未満を切り上げる

#### Scenario: 最終年に備忘価額1円を残す

- **WHEN** 未償却残高が「取得価額 × 償却率」を下回る最終年に達する
- **THEN** 償却費 = 期首未償却残高 − 1 とし、残高を1円で保持する

#### Scenario: 定率法は保証率で改定償却へ切り替える

- **WHEN** 定率法の償却費が償却保証額（取得価額 × 保証率）を下回る年に達する
- **THEN** 以後は改定取得価額 × 改定償却率で均等償却し、1円まで償却する

#### Scenario: 一括償却は月割しない

- **WHEN** `lump_sum` の資産を償却する
- **THEN** 供用月に関わらず取得価額の 1/3 を3年均等で償却し、備忘価額を残さず全額償却する

#### Scenario: 事業利用比率は必要経費にのみ効く

- **WHEN** 事業利用比率 100% 未満の資産を償却する
- **THEN** 家事分 = 本年分償却費 ×(1 − 比率/100) を円未満切捨てで算出し、必要経費算入額 = 償却費 − 家事分 とする
- **AND** 期末未償却残高は按分前の全額で減額する

### Requirement: 期末償却仕訳の起票

システムは open 年度の償却仕訳を洗い替えで起票する SHALL。

#### Scenario: 記帳方法に従って起票する

- **WHEN** `POST /api/fixed-assets/post-depreciation` を呼ぶ
- **THEN** 借)減価償却費（必要経費算入額）・借)事業主貸（家事分がある場合）・貸)減価償却累計額（間接法）または対象資産科目（直接法）の confirmed 仕訳を `source='depreciation'` で起票する
- **AND** `depreciation_entries` に本年分償却費・必要経費算入額・期末残高を永続化する

#### Scenario: 再実行で当年度分を洗い替える

- **WHEN** 同一年度で再度起票を実行する
- **THEN** 当年度の `source='depreciation'` 仕訳を作り直し、二重計上しない

#### Scenario: 起票できない資産を報告する

- **WHEN** 直接法で対象資産科目が未設定などの理由で起票できない資産がある
- **THEN** 当該資産を `skipped`（資産 id・名称・理由）として結果に含める

#### Scenario: 少額特例の年間上限を判定する

- **WHEN** `minor_special` の資産合計が年間 300 万円を超える
- **THEN** 管理番号順に枠を埋め、超過分は特例を適用しない

### Requirement: 除却と売却

システムは除却と売却を区別して処理し、それぞれの会計処理を仕訳へ反映する SHALL。

#### Scenario: 除却損を計上する

- **WHEN** `POST /api/fixed-assets/:id/retire` に `retiredDate` を送る
- **THEN** 期首から除却月までを月割償却（円未満切上げ）した後の残高を除却損として計上し、`status='retired'` にする

#### Scenario: 一括償却資産は除却損を計上しない

- **WHEN** `lump_sum` の資産を除却する
- **THEN** 除却仕訳を起票せず `status='retired'` と `retired_date` のみ記録し、期末償却は3年枠内で継続する

#### Scenario: 売却は未償却残高を事業主貸へ振り替える

- **WHEN** `POST /api/fixed-assets/:id/sell` に `soldDate` を送る
- **THEN** 期中売却は供用月数で当期償却したうえで、未償却残高を全額 事業主貸へ振り替え（`source='sale'`）、`status='sold'` にする
- **AND** 譲渡所得の計算は行わない（スコープ外）

### Requirement: 中古資産の見積耐用年数

システムは簡便法による見積耐用年数を算定する SHALL。

#### Scenario: 一部経過の中古資産を算定する

- **WHEN** `GET /api/fixed-assets/used-useful-life?legalYears=&elapsedMonths=` を呼ぶ
- **THEN** 「(法定耐用年数 − 経過年数) + 経過年数 × 20%」を月数で計算し、1年未満を切り捨てて返す

#### Scenario: 全部経過・下限を扱う

- **WHEN** 経過月数が法定耐用年数以上、または算定結果が2年未満になる
- **THEN** 「法定耐用年数 × 20%」で算定し、下限 2 年を返す

#### Scenario: 不正なパラメータを拒否する

- **WHEN** `legalYears` / `elapsedMonths` が数値でない、または範囲外である
- **THEN** 400 を返す
