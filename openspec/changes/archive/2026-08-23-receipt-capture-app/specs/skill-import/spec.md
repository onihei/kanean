## ADDED Requirements

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
