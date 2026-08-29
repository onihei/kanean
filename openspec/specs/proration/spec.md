# proration Specification

## Purpose

家事按分（事業と私用が混在する支出の按分）を担う。対象科目ごとの事業使用割合を設定し、
期末に家事分を事業主貸へ振り替える仕訳を生成する。按分は申告項目ではなく**仕訳結果**として損益に反映する。
（[docs/accounting-spec.md] §7・[docs/PRD.md] F-JNL-4）

## Requirements

### Requirement: 按分設定の管理

システムは open 年度における「対象勘定科目（＋任意の補助科目）× 事業使用割合」の設定を管理する SHALL。

#### Scenario: 設定を登録・更新する

- **WHEN** `POST /api/proration-settings` に `accountId`（＋ `subAccountId`・`businessRatio`・`method`・`note`）を送る
- **THEN** 当該年度の設定を作成または更新して id を返す
- **AND** `businessRatio` は 0〜100（%）で保持する

#### Scenario: 補助科目未指定は全補助科目を対象にする

- **WHEN** `subAccountId` を指定せずに設定する
- **THEN** 当該勘定科目の全明細（補助科目を問わず）を按分対象とする

#### Scenario: 設定を一覧・削除する

- **WHEN** `GET /api/proration-settings` / `DELETE /api/proration-settings/:id` を呼ぶ
- **THEN** open 年度の設定を科目名付きで返し、削除は当該設定のみを除去する

#### Scenario: 会計年度が無い場合

- **WHEN** open な会計年度が存在しない
- **THEN** 一覧は空配列を返し、登録・起票は 400 を返す

### Requirement: 期末按分仕訳の起票

システムは設定に基づき家事分を算出し、期末一括の振替仕訳を洗い替えで起票する SHALL。

#### Scenario: 家事分を事業主貸へ振り替える

- **WHEN** `POST /api/proration/post` を呼ぶ
- **THEN** 対象科目の当期経費計上額に対し 家事分 = 計上額 ×(1 − businessRatio/100)（円未満切捨て）を算出する
- **AND** 借)事業主貸 家事分 / 貸)対象経費科目 家事分 の仕訳を `source='proration'` で起票する

#### Scenario: 再実行で洗い替える

- **WHEN** 同一年度で再度起票する
- **THEN** 当年度の `source='proration'` 仕訳を作り直し、二重計上しない

#### Scenario: 按分結果が損益に反映される

- **WHEN** 按分仕訳を起票した後に損益計算書を取得する
- **THEN** 対象経費は按分後（事業分のみ）の金額で集計される
