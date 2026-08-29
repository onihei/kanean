# csv-import Specification

## Purpose

銀行・カードの CSV を手動アップロードで取り込み、正規化した `raw_transactions` として保存する。
文字コード・日付・金額の正規化、冪等性（重複検知）、会計期間ゲート、部分取込、残高突合、
取込口座マスタとユーザー定義フォーマットを担う。取込後の仕訳化は [[journal]] が担う。
（[docs/csv-format.md]・[docs/PRD.md] F-IMP-1〜4/7/8）

## Requirements

### Requirement: 対応フォーマットのパース

システムは組込フォーマット（`bank_ufj` / `bank_shinsei` / `card_mufg_visa`）とユーザー定義フォーマット（`format:{id}`）の CSV を、
共通の中間形式（取引日・金額・方向・摘要・残高・原文）へ正規化する SHALL。

#### Scenario: 取込元ごとの文字コードを吸収する

- **WHEN** Shift_JIS の三菱UFJ銀行／UFJ-VISA、UTF-8 BOM 付きの新生銀行 CSV を取り込む
- **THEN** UTF-8 へ統一し、BOM と CRLF を除去する

#### Scenario: 日付・金額・摘要を正規化する

- **WHEN** `YYYY/M/D`・`YYYY/MM/DD`・`YYYY年M月D日` の日付、カンマ付き・全角の金額が現れる
- **THEN** 日付は ISO8601、金額は円整数（空文字は 0）へ変換し、摘要の全角英数記号は半角化する
- **AND** 原 CSV 行を `raw_transactions.raw_payload` に JSON で保持する

#### Scenario: 未対応の source_type を拒否する

- **WHEN** `POST /api/import?sourceType=...` に未知の `sourceType` が指定される
- **THEN** 400 を返し、何も取り込まない

### Requirement: 出現インデックス方式による冪等性

システムは `dedup_hash = hash(取引日, 金額, 方向, 摘要, 出現インデックス)` で重複を判定し、
同一ファイルの再取込を二重計上させない SHALL。残高列・支払回数には依存しない。

#### Scenario: 同日同額同摘要を取りこぼさない

- **WHEN** 1つのファイル内に同日・同額・同方向・同摘要の取引が複数含まれる
- **THEN** 出現順の連番で別ハッシュとなり、全件が取り込まれる

#### Scenario: 再取込は冪等

- **WHEN** 同じファイルをもう一度取り込む
- **THEN** すべて重複としてスキップし、`skippedDup` 件数と明細サンプル（先頭50件）を結果に返す

#### Scenario: 重複を黙って落とさない

- **WHEN** 重複スキップが発生する
- **THEN** 取込結果に件数と明細（日付・金額・摘要）を含め、UI に表示できる形で返す

### Requirement: 会計期間ゲート

システムは開いている会計期間（`fiscal_years.status='open'`）の `[start_date, end_date]` に取引日が含まれる行のみを取り込む SHALL。

#### Scenario: 期間外を取り込まない

- **WHEN** open 年度の範囲外の取引日を含む CSV を取り込む
- **THEN** 当該行は `raw_transactions` に登録せず、`skippedOutOfPeriod` として件数と期間（periodStart/periodEnd）を返す

#### Scenario: 会計年度未設定では取り込めない

- **WHEN** open な会計年度が存在しない状態で取込を実行する
- **THEN** 400 を返し「先に対象年度を設定してください」と案内する

### Requirement: 部分取込とエラーリカバリ

システムは行単位でパース失敗を隔離し、正常行の取込を継続する SHALL。

#### Scenario: 壊れた行があっても正常行を取り込む

- **WHEN** 取引行と判定できたが日付／金額を解釈できない行が混在する
- **THEN** 正常行を取り込み、`import_batches.status='partial'` と `error_count`・`error_sample`（`{rowNo, raw, message}`）を記録する

#### Scenario: 全行が解釈不能でも結果を返す

- **WHEN** すべての行が解釈不能である
- **THEN** バッチを作らず `status='failed'` の取込結果（件数と行単位内訳）を 200 で返す

#### Scenario: 取引行でない行はエラーにしない

- **WHEN** 見出し・注記・登録番号などの非取引行が現れる
- **THEN** エラーとせずスキップする

### Requirement: 取込口座マスタ

システムは取込先口座を `linked_account_ref` を持つ補助科目として管理し、取込は口座マスタからの選択で行える SHALL。

#### Scenario: 口座を登録する

- **WHEN** `POST /api/import-accounts` に `sourceType`・`accountRef`・`accountId` を送る
- **THEN** 当該勘定科目配下に `linked_account_ref` と `import_source_type` を持つ補助科目を作成する

#### Scenario: 未登録の口座を自動登録する

- **WHEN** 口座マスタに存在しない `accountRef` で取込を実行する
- **THEN** 既定の勘定科目（`bank_ufj`/`bank_shinsei`→普通預金、`card_mufg_visa`→未払金）配下に補助科目を作成して紐付ける

### Requirement: ユーザー定義の列マッピング

システムはコード変更なしに新フォーマットを追加できる列マッピング設定（`import_formats`）を提供する SHALL。対象は 1行=1取引型。

#### Scenario: フォーマットを定義して取り込む

- **WHEN** `POST /api/import-formats` で列マッピング設定を保存し、`sourceType=format:{id}` で取込を実行する
- **THEN** 設定に従って列を解釈し、組込フォーマットと同じ中間形式へ正規化する

#### Scenario: 破損した設定を拒否する

- **WHEN** 保存済み設定の JSON が破損している
- **THEN** 取込を開始せず 400 を返す

#### Scenario: フォーマットを更新・無効化する

- **WHEN** `PATCH /api/import-formats/:id` に `name`/`config`/`isActive` の一部を送る
- **THEN** 指定フィールドのみ更新し、未指定は既存値を保持する

### Requirement: 残高チェーンによる突合

システムは残高列を持つ明細について、口座別の残高連続性を検証し取りこぼしを検知する SHALL。

#### Scenario: 残高の不連続を報告する

- **WHEN** `GET /api/reports/reconciliation` を呼ぶ
- **THEN** 各行の取引前残高（残高−符号付き金額）を他行の取引後残高に結びつけ、結べない行を差異として報告する
- **AND** 口座期首の1件のみは正当として扱う

#### Scenario: 並び順・分割取込に依存しない

- **WHEN** CSV が逆時系列である、または複数バッチに分割して取り込まれている
- **THEN** 残高値そのものでチェーンを辿るため、正常データを誤検知しない

#### Scenario: 残高列のない明細は対象外

- **WHEN** カード明細など `balance` が null の行のみが存在する
- **THEN** 突合対象とせず、差異として報告しない

### Requirement: 取込明細の状態管理

システムは取込明細を `pending` / `journalized` / `ignored` で管理し、退避と復帰を提供する SHALL。
一覧は既定で**開いている会計年度に属する明細**（`txn_date` が `[start_date, end_date]` に入る）に閉じ、
過年度は明示操作でのみ表示する。復帰（再仕訳）は会計期間ゲート（[[journal]]）に従う。

取込明細は作業キューであると同時に証跡でもある。繰越後に視界から外すのは前者の都合であり、
行そのものは削除も移動もしない（原文・仕訳への逆引き・名寄せリンクを失わないため）。

#### Scenario: 状態で絞り込む

- **WHEN** `GET /api/raw-transactions?status=pending` を呼ぶ
- **THEN** 当該状態かつ開いている会計年度に属する明細と、総件数・打切りフラグを返す

#### Scenario: 過年度を明示操作で表示する

- **WHEN** 一覧の要求で過年度を含めるよう明示する
- **THEN** 会計年度で絞り込まず、すべての年度の明細を対象に返す

#### Scenario: 年度で外した件数を黙って隠さない

- **WHEN** 既定（開いている会計年度）で一覧を返す
- **THEN** 会計年度の絞り込みによって一覧から外れた明細の件数を併せて返す

#### Scenario: 会計年度が無い場合は絞り込まない

- **WHEN** 開いている会計年度が存在しない状態で一覧を要求する
- **THEN** 会計年度による絞り込みを行わず、外した件数は 0 として返す

#### Scenario: 明細を退避・復帰する

- **WHEN** `POST /api/raw-transactions/:id/ignore` または `/restore` を呼ぶ
- **THEN** `ignored` へ退避、または `pending` へ復帰し、復帰時は仕訳候補を再生成できる状態にする

#### Scenario: 過年度の明細は復帰できない

- **WHEN** 開いている会計年度の範囲外の `txn_date` を持つ明細に `/restore` を呼ぶ
- **THEN** 400 を返して日付と会計年度の範囲を示し、明細の状態を `ignored` のまま変えない

### Requirement: 口座間振替の名寄せ

システムは同額・逆方向・日付近接の明細対を口座間振替の候補として提示し、確認のうえ1本の振替 draft に統合する SHALL。二重計上防止のため自動確定はしない。

#### Scenario: 振替候補を提示する

- **WHEN** `GET /api/settlement/transfer-candidates` を呼ぶ
- **THEN** 同額・逆方向・日付が近接する明細対を候補として返す

#### Scenario: 候補をリンクして振替仕訳にまとめる

- **WHEN** `POST /api/settlement/link` に `outRawId`・`inRawId` を送る
- **THEN** 2明細を1本の振替 draft（`source='transfer'`）へ統合する

#### Scenario: リンクを解除する

- **WHEN** `POST /api/settlement/unlink` に `rawId` を送る
- **THEN** 統合を解除し、元の明細単位の状態へ戻す
