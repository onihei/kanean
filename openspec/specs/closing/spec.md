# closing Specification

## Purpose

会計年度のライフサイクルと決算整理を担う。初回年度の作成、開始残高（`opening_balances`）の登録、
期末の元入金振替の計算、年度繰越（当期を closed にして翌期を open で作成し繰越残高を生成）、
および繰越の取消を提供する。取込・仕訳・帳票はすべて open 年度を前提に動作する。
（[docs/accounting-spec.md] §1.3・[docs/csv-format.md] C-8・[docs/roadmap.md] Phase 4）

## Requirements

### Requirement: 会計年度の作成

システムは暦年（1/1〜12/31）の会計年度を明示操作で作成する SHALL。CSV の先頭行等から暗黙に確定してはならない。

#### Scenario: 推奨年度を提示する

- **WHEN** `GET /api/fiscal-years/suggested` を呼ぶ
- **THEN** サーバ時刻を基準に、1〜4月は前年、それ以外は当年を推奨年として返す

#### Scenario: 初回年度を作成する

- **WHEN** `POST /api/fiscal-years` に `year`（西暦）を送る
- **THEN** 当該暦年の会計年度を `status='open'` で作成する

#### Scenario: 既存があれば拒否する

- **WHEN** すでに会計年度が存在する状態で作成を試みる
- **THEN** 400 を返す

#### Scenario: 年度を一覧する

- **WHEN** `GET /api/fiscal-years` を呼ぶ
- **THEN** 開始日昇順ですべての会計年度を返す

### Requirement: 開始残高の登録

システムは BS 科目（＋補助科目）の期首残高を登録し、決算書の期首列と貸借対照表の駆動に用いる SHALL。

#### Scenario: 開始残高を登録する

- **WHEN** `POST /api/opening-balances` に `accountId`（＋ `subAccountId`・金額）を送る
- **THEN** open 年度の開始残高を作成または更新する

#### Scenario: 入力候補と合計を返す

- **WHEN** `GET /api/opening-balances` を呼ぶ
- **THEN** 登録済み残高に加え、入力対象となる BS 勘定科目・補助科目の一覧と、借方／貸方の合計を返す

#### Scenario: 開始残高を削除する

- **WHEN** `DELETE /api/opening-balances/:id` を呼ぶ
- **THEN** 当該行を削除する

### Requirement: 期末元入金振替の計算

システムは翌期首の元入金を計算し、read-only のプレビューとして提示する SHALL。この操作は仕訳を起票しない。

#### Scenario: 元入金の繰越額を計算する

- **WHEN** `GET /api/closing/capital-transfer/preview` を呼ぶ
- **THEN** 翌期首元入金 = 前期末元入金 + 当期所得（控除前所得㊸）+ 事業主借 − 事業主貸 を、内訳（各期末残高・純増減）とともに返す

#### Scenario: 起票も残高書込みもしない

- **WHEN** プレビューを何度呼び出しても
- **THEN** 仕訳・残高は変化しない（実反映は年度繰越が行う）

### Requirement: 年度繰越

システムは明示確認を伴う確定操作として年度繰越を実行し、当期を closed、翌期を open として繰越残高を生成する SHALL。
繰越の確認前に、当期に未処理（`pending` / `ignored`）のまま残っている取込明細の件数を提示する。
これは警告であり、繰越を拒否しない（`ignored` は利用者が意図して残す状態であり、これを阻却条件にすると繰越が詰まる）。

#### Scenario: 明示確認を要求する

- **WHEN** `POST /api/closing/rollover` が `confirm:true` を伴わない
- **THEN** 400 を返し、繰越を行わない

#### Scenario: 繰越を原子的に実行する

- **WHEN** `confirm:true` で繰越を実行する
- **THEN** 当期の貸借一致を確認し、翌期（当期末日の翌日〜同暦年12/31）を `open` で作成する
- **AND** 資産・負債の期末残高を翌期の `opening_balances` へ繰り越し、元入金は翌期首元入金の計算値を設定する
- **AND** 事業主貸・事業主借・控除前所得は元入金へ吸収し繰り越さない
- **AND** 当期を `closed` にする。全体をトランザクションで原子化し、途中失敗時は中途半端な繰越を残さない

#### Scenario: 未処理の取込明細を繰越前に知らせる

- **WHEN** 繰越の確認前に当期の状態を照会する
- **THEN** 当期に属する未処理の取込明細の件数を `pending` / `ignored` の内訳とともに返す

#### Scenario: 未処理があっても繰越を止めない

- **WHEN** 未処理の取込明細が残った状態で `confirm:true` の繰越を実行する
- **THEN** 警告の有無に関わらず繰越を実行する

#### Scenario: 繰越後は前年度の明細を仕訳化できない

- **WHEN** 繰越の完了後に、前年度に属する未処理の取込明細を仕訳化しようとする
- **THEN** 会計期間ゲート（[[journal]]）により拒否される

#### Scenario: 翌期が open になって初めて翌期取引を取り込める

- **WHEN** 繰越の完了後に翌期の取引を取り込む
- **THEN** 会計期間ゲートを通過して取り込める（繰越前は期間外として除外される）

#### Scenario: closed 年度の変更を拒否する

- **WHEN** closed になった年度の仕訳を編集・確定取消・削除しようとする
- **THEN** 400 を返す

### Requirement: 繰越の取消

システムは翌期に仕訳が1件も無い場合に限り、繰越を取り消して当期を open に戻す SHALL。

#### Scenario: 仕訳ゼロなら取り消せる

- **WHEN** 翌期の仕訳が0件の状態で `POST /api/closing/reopen/:id` を呼ぶ
- **THEN** 当該年度を `open` に戻す

#### Scenario: 仕訳があれば拒否する

- **WHEN** 翌期にすでに仕訳が存在する
- **THEN** 400 を返し、状態を変更しない
