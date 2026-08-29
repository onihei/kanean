# skill-import Specification

## Purpose

外部の取得層（Claude Code スキル等の AI エージェント）が叩く `/skill` API 群。
巡回対象の提示・確定分類履歴の提供・仕訳候補の draft 投入を担い、
**会計期間ゲート・冪等性・科目検証の権威は本体側が持つ**（スキルを信用しすぎない）。
取得手段（スクレイピング／メール解析／手動）に依存しない中間契約であり、投入結果は必ず draft で人の承認を要する。
（[docs/ec-import-api.md]・[docs/bank-import-api.md]・[docs/acquisition-skill-spec.md]）

## Requirements

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

### Requirement: 確定分類履歴の絞り込み提供

システムは `POST /skill/classification-history/lookup` で、今回バッチに関連する確定履歴だけをサーバ側で絞って返す SHALL。

#### Scenario: 関連する履歴のみ返す

- **WHEN** `{source, items[], windowMonths, limit}` を送る
- **THEN** `items` と語が重なる `mapping_history` 行に限定する
- **AND** `lastUsedAt` が `windowMonths`（既定12）以内の行のみを候補とする
- **AND** `recency × hitCount` の上位 `limit`（既定200）件で打ち切り、`score` を添えて返す

#### Scenario: 関連の無い品目は候補に出さない

- **WHEN** 過去に一度も確定していない品名・摘要を送る
- **THEN** 当該品目に対する候補は返さず、スキル側のポリシー判断に委ねる

### Requirement: EC 仕訳候補の draft 投入

システムは `POST /skill/ec/journal-candidates` で正規化済み EC 明細を受け取り、`raw_transactions` と draft 仕訳を生成する SHALL。

#### Scenario: 明細から未払金クリアリングの draft を作る

- **WHEN** `accountRef` と `orders[]`（`orderId`・`orderDate`・`lines[]`）を送る
- **THEN** 借方＝提案科目、貸方＝当該チャネルの未払金補助科目の draft 仕訳を生成する
- **AND** `auto_journal_rules` と金融機関既定仕訳は適用しない

#### Scenario: 注文レベル調整で請求額に揃える

- **WHEN** `shipping` / `pointsUsed` / `pointsEarned` が指定される
- **THEN** 送料は 借)雑費/貸)未払金、ポイント利用は 借)未払金/貸)事業主借、ポイント付与は 借)事業主貸/貸)雑収入 の調整仕訳を生成し、未払金合計を `orderTotal` に一致させる

#### Scenario: 明細合計の不一致を警告する

- **WHEN** `Σ lineAmount + shipping − pointsUsed` が `orderTotal` と一致しない
- **THEN** 取込は継続しつつ `warnings` に不一致を含める

### Requirement: 銀行・カード仕訳候補の draft 投入

システムは `POST /skill/bank/journal-candidates` で正規化済み取引を受け取り、`accountRef` の補助科目を一脚に置く draft 仕訳を生成する SHALL。

#### Scenario: direction から貸借を機械構築する

- **WHEN** `direction='in'` の取引を送る
- **THEN** 口座科目を借方、相手科目を貸方に置く（`out` はその逆）

#### Scenario: treatment から相手科目を決める

- **WHEN** `treatment` が `expense`/`revenue`/`settlement`/`owner_contribution`/`owner_draw`/`unresolved` のいずれかで送られる
- **THEN** `owner_contribution`→事業主借、`owner_draw`→事業主貸、`unresolved`→未確定勘定、その他は `proposedAccount` を科目名として解決する

#### Scenario: カード決済を未払金の付替えとして扱う

- **WHEN** `treatment='settlement'` と `counterSubAccountRef` が指定される
- **THEN** 親勘定が一致する場合のみ当該補助科目を採用し、費用を再計上せず未払金間の付替えとする

#### Scenario: 残高を保存する

- **WHEN** `balance` が指定される
- **THEN** `raw_transactions.balance` に保存し、残高チェーン突合（[[csv-import]]）の素とする

### Requirement: 投入時の検証と権威

システムはスキルからの入力を zod で検証し、期間ゲート・冪等性・科目解決の最終判断を本体側で行う SHALL。

#### Scenario: 不正な値を拒否する

- **WHEN** 金額が負・非整数、または円整数の安全上限（10^12 未満）を超える
- **THEN** 400 `validation_error` を返し、`details` に該当パスを含める

#### Scenario: 配列・本文サイズの上限を超える入力を拒否する

- **WHEN** 注文 5000 件／明細 1000 行／取引 10000 件、または本文 5MB を超える
- **THEN** 400（本文超過は 413）で拒否する

#### Scenario: UI 取込と冪等性を共有する

- **WHEN** 銀行明細を送る
- **THEN** 出現インデックス方式（期間外の行も連番を消費）で dedup し、同一口座を手動 CSV 取込と併用しても二重計上しない

#### Scenario: 期間外を除外して報告する

- **WHEN** open 期間外の取引日を含む入力を送る
- **THEN** 当該行を登録せず `excludedCount` / `excludedOutOfPeriod` として返す

#### Scenario: 未知の科目を未確定勘定へ寄せる

- **WHEN** `proposedAccount` が勘定科目マスタに存在しない
- **THEN** `未確定勘定` を割り当て、`unresolved` に理由付きで列挙する（黙って確定しない）

#### Scenario: 行単位で原子化する

- **WHEN** 一部の行で取込処理が失敗する
- **THEN** 当該行のみロールバックし、他の行の取込を継続して `warnings` に失敗を記録する

#### Scenario: 前提不足を 409 で返す

- **WHEN** open な会計年度が無い、連携サービス未登録、シード未投入のいずれかである
- **THEN** 409（`no_open_fiscal_year` / `unknown_source` / `precondition_failed`）を返す

### Requirement: 承認による学習の書き戻し

システムは利用者が draft を確定したとき、`source` と正規化パターン → 科目の対応を `mapping_history` に書き戻す SHALL。

#### Scenario: 確定で履歴を更新する

- **WHEN** 取込由来の draft 仕訳を確定する
- **THEN** 該当 `sourceType` × パターンの `hit_count` を加算し `last_used_at` を更新する（未登録なら作成する）

#### Scenario: 学習してはならないものを除外する

- **WHEN** 金融機関既定仕訳（`auto_institution`）由来、または `未確定勘定` のまま確定された仕訳がある
- **THEN** `mapping_history` に学習しない

### Requirement: 現金レシートの draft 投入

システムは `POST /skill/receipts/journal-candidates` で正規化済みレシートと画像を受け取り、
`raw_transactions`・draft 仕訳・証憑添付を 1 件として生成する SHALL。
検証・期間ゲート・科目解決の権威は既存の「投入時の検証と権威」に従う。

#### Scenario: 現金支出の draft を作る

- **WHEN** 支払手段が現金のレシート（`transactionDate`・`totalAmount`・`merchant`・`proposedAccount`）を送る
- **THEN** 借方＝提案科目、貸方＝現金 の draft 仕訳を生成する
- **AND** `auto_journal_rules` と金融機関既定仕訳は適用しない

#### Scenario: 証憑を同じ操作で添付する

- **WHEN** レシート画像を伴って送る
- **THEN** 生成した draft 仕訳に当該画像を [[attachments]] の規約で添付し、仕訳と証憑を離ればなれにしない

#### Scenario: 撮影時の文脈を摘要に残す

- **WHEN** 飲食の参加人数・相手・用途（事業／按分／私用）が添えられている
- **THEN** それらを摘要ないしメモとして残し、交際費／会議費の判断材料が仕訳から辿れるようにする

#### Scenario: 画像ハッシュで冪等にする

- **WHEN** 既に登録済みの証憑と同じ SHA-256 を持つ画像を送る
- **THEN** 新たな仕訳も添付も作らず、重複として既存の仕訳を指し示して返す

#### Scenario: 読み取れなかった項目を黙って埋めない

- **WHEN** `transactionDate` または `totalAmount` が欠けている
- **THEN** 起票せず、どの項目が不足しているかを返す

### Requirement: カード払いレシートの突合候補の提示

システムは `POST /skill/receipts/match` で日付・金額・店名から取込済み明細の候補を返す SHALL。
この経路では**新規の仕訳を起こさない**（[[acquisition]] の取込と二重計上しないため）。

#### Scenario: 突合候補を返す

- **WHEN** カード払いのレシート（`transactionDate`・`totalAmount`・`merchant`）を送る
- **THEN** 日付の近接と金額の一致から候補となる既存仕訳を返し、各候補に一致した根拠を添える

#### Scenario: 候補が無いときに起票しない

- **WHEN** 一致する明細が存在しない
- **THEN** 空の候補を返し、当該レシートを起票しない

#### Scenario: 一意に定まらないときは人に委ねる

- **WHEN** 候補が複数該当する
- **THEN** 自動で選ばず全件を返し、選択を利用者に委ねる

#### Scenario: 起票の経路を持たない

- **WHEN** この API を呼ぶ
- **THEN** 応答は候補の提示に限られ、仕訳の作成・確定は行わない
