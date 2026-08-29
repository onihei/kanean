# documents Specification

## Purpose

見積書・納品書・請求書・領収書（`documents` / `document_lines`）の作成と、請求書起票による
売掛金の複合仕訳、入金消込、取消、領収書の複製を担う。合計金額は常にサーバ側で再計算し、
クライアント送信値を信用しない。税込経理・インボイス（適格請求書）の記載要件を前提とする。
（[docs/PRD.md] F-INV・[docs/accounting-spec.md] §4.2/§5・[docs/roadmap.md] Phase 5 slice9）

## Requirements

### Requirement: 書類の作成と合計の再計算

システムは書類を明細付きで作成・更新し、小計・消費税・源泉徴収税額・総額をサーバ側で再計算する SHALL。

#### Scenario: 明細から合計を算出する

- **WHEN** `POST /api/documents` に `docType` と `lines[]`（金額・税率・源泉対象フラグ等）を送る
- **THEN** 明細から税率別に消費税を算出し、小計・税額・総額を保存する
- **AND** クライアントが送った合計値は採用しない

#### Scenario: 税率別に端数処理を1回だけ行う

- **WHEN** 8% と 10% の明細が混在する請求書を作成する
- **THEN** 税率ごとに1回だけ端数処理して消費税額を確定する（適格請求書の要件）

#### Scenario: 必須項目を検証する

- **WHEN** `docType` または `lines` を欠いたリクエストを送る
- **THEN** 400 を返す

#### Scenario: 書類を一覧・取得する

- **WHEN** `GET /api/documents?docType=&status=&counterpartyId=` / `GET /api/documents/:id` を呼ぶ
- **THEN** 条件に一致する書類（詳細は明細付き）を返す

### Requirement: 請求書の起票（売掛金の複合仕訳）

システムは請求書の発行時に、売掛金と売上の仕訳を confirmed で起票する SHALL。

#### Scenario: 源泉なしの請求を起票する

- **WHEN** `POST /api/documents/:id/issue` を呼ぶ（源泉対象行なし）
- **THEN** 借)売掛金［総額］／ 貸)売上高［総額・税率別に分割し税区分を付与］の仕訳を `source='invoice'` で起票する
- **AND** 書類に仕訳 id と発行済みステータスを記録する

#### Scenario: 源泉ありの請求を起票する

- **WHEN** 源泉対象行を含む請求書を発行する
- **THEN** 借)売掛金［総額−源泉］／ 借)事業主貸（源泉所得税）［源泉］／ 貸)売上高［総額］の複合仕訳を起票する
- **AND** 源泉の計算基礎は源泉対象行の本体（税抜）合計とする

#### Scenario: 取引先別の売掛金補助科目に収束する

- **WHEN** 取引先が指定された請求書を起票する
- **THEN** 当該取引先の売掛金補助科目を get-or-create して用いる（開始残高の繰越と同じ補助科目になる）

### Requirement: 入金消込

システムは請求書に対する入金を消込仕訳として起票する SHALL。

#### Scenario: 入金を消し込む

- **WHEN** `POST /api/documents/:id/collect` に `paymentDate`（＋ `depositAccountId`）を送る
- **THEN** 借)現金預金［回収額］／ 貸)売掛金［回収額］の仕訳を起票し、書類を入金済みにする

#### Scenario: 日付必須を検証する

- **WHEN** `paymentDate` が無い
- **THEN** 400 を返す

### Requirement: 取消と領収書の作成

システムは書類の取消と、請求書からの領収書複製を提供する SHALL。

#### Scenario: 書類を取り消す

- **WHEN** `POST /api/documents/:id/void` を呼ぶ
- **THEN** 当該書類を取消状態にする

#### Scenario: 請求書から領収書を作る

- **WHEN** `POST /api/documents/:id/receipt` を呼ぶ
- **THEN** 元の請求書を参照する領収書を作成する（仕訳は複製せず元請求書の仕訳を参照する）

### Requirement: 準備書類の扱い

システムは見積書・納品書を仕訳を伴わない準備書類として扱う SHALL。

#### Scenario: 見積・納品では仕訳を作らない

- **WHEN** `docType` が `quote` または `delivery` の書類を作成する
- **THEN** CRUD は可能とし、仕訳は生成しない
