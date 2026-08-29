# reports Specification

## Purpose

confirmed 仕訳を入力源として、帳簿・集計帳票を組成する。仕訳帳・総勘定元帳・補助元帳・
合計残高試算表・損益計算書・貸借対照表・月次推移・前期比較・部門別集計・消費税区分別集計・
税抜損益を提供し、いずれも CSV で出力できる。
（[docs/accounting-spec.md] §9・[docs/roadmap.md] Phase 2・[docs/PRD.md] F-BOK）

## Requirements

### Requirement: confirmed 仕訳のみの集計

システムは帳簿・集計帳票を `journal_entries.status='confirmed'` のみから算出する SHALL。

#### Scenario: draft を集計に含めない

- **WHEN** draft 仕訳が存在する状態で試算表・PL・BS を取得する
- **THEN** draft は集計に含めない

#### Scenario: 会計年度が無い場合

- **WHEN** open な会計年度が存在しない状態で帳票 API を呼ぶ
- **THEN** `report: null` を返す（CSV 出力は 400 を返す）

### Requirement: 帳簿の生成

システムは仕訳帳・総勘定元帳・補助元帳を生成する SHALL。

#### Scenario: 仕訳帳を時系列で出す

- **WHEN** `GET /api/reports/journal.csv?status=&from=&to=&q=&accountId=` を呼ぶ
- **THEN** 条件に一致する仕訳を時系列で CSV 出力する

#### Scenario: 総勘定元帳を出す

- **WHEN** `GET /api/reports/ledger/:accountId` を呼ぶ
- **THEN** 当該科目の明細を時系列に並べ、相手科目を解決し、`normal_balance` 方向に累積残高を算出する
- **AND** 相手科目が複数ある場合は「諸口」に丸める

#### Scenario: 補助元帳を出す

- **WHEN** `GET /api/reports/sub-ledger/:subAccountId` を呼ぶ
- **THEN** 当該補助科目の明細と累積残高を返す

### Requirement: 集計帳票

システムは試算表・損益計算書・貸借対照表を算出する SHALL。

#### Scenario: 期間指定の試算表を出す

- **WHEN** `GET /api/reports/trial-balance?from=&to=` を呼ぶ
- **THEN** 期間内の借方合計・貸方合計・残高を科目別に返す（期間未指定は年度全体）

#### Scenario: 損益計算書を出す

- **WHEN** `GET /api/reports/pl` を呼ぶ
- **THEN** PL 科目を区分（売上／売上原価／経費）で集計し、当期所得を算出する

#### Scenario: 貸借対照表を出す

- **WHEN** `GET /api/reports/bs` を呼ぶ
- **THEN** BS 科目を区分で集計し、資本の部に控除前所得金額を連結する

### Requirement: 分析帳票

システムは月次推移・前期比較・部門別集計・消費税区分別集計・税抜損益を提供する SHALL。

#### Scenario: 月次推移を出す

- **WHEN** `GET /api/reports/monthly-trend` を呼ぶ
- **THEN** 月×科目の推移表を返す

#### Scenario: 前期と比較する

- **WHEN** `GET /api/reports/comparison/{trial-balance|pl|bs}?fiscalYearId=&compareTo=` を呼ぶ
- **THEN** 当期（省略時 open 年度）と比較対象（省略時は前期を自動解決）を並べた比較表を返す
- **AND** 実在しない年度 id が指定された場合は当期＝年度なし、比較＝前期なしとして扱う

#### Scenario: 部門別に集計する

- **WHEN** `GET /api/reports/department-trial-balance` / `department-pl` を呼ぶ
- **THEN** 明細の `department_id` 別に集計した表を返す

#### Scenario: 消費税区分別の課税売上を集計する

- **WHEN** `GET /api/reports/tax-sales` を呼ぶ
- **THEN** confirmed 仕訳の税区分別に課税売上と税額を集計する（消費税申告の入力源）

#### Scenario: 税抜損益を出す

- **WHEN** `GET /api/reports/tax-excluded-pl` を呼ぶ
- **THEN** 明細の税額を控除した税抜ベースの損益を返す

### Requirement: CSV 出力の形式

システムはすべての帳票 CSV を RFC4180 準拠で出力し、ファイル名を Content-Disposition で指定する SHALL。

#### Scenario: Excel で文字化けさせない

- **WHEN** 帳票 CSV をダウンロードする
- **THEN** UTF-8 BOM を付与し、`Content-Type: text/csv; charset=utf-8` を返す

#### Scenario: 日本語ファイル名を安全に渡す

- **WHEN** ファイル名に日本語や記号が含まれる
- **THEN** RFC5987 の `filename*=UTF-8''` 形式でエンコードして返す

