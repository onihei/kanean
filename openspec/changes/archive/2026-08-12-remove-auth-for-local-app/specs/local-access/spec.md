## Purpose

ローカル単一ユーザーのアクセス境界を定める。認証を持たない代わりに、待ち受けを 127.0.0.1 に固定して
**ネットワーク到達性そのものを防壁**とし、唯一のオーナーを自動解決して data plane
（`$DATA_DIR/users/{id}.sqlite`）を初期化する。従来の [[auth-session]] を置き換える。
（[docs/architecture.md] §4/§5・[docs/PRD.md] F-AUTH）

## ADDED Requirements

### Requirement: ループバック限定の待ち受け

システムは HTTP の待ち受けを `127.0.0.1` に固定し、同一マシン以外からの到達を不可能にする SHALL。
これが認証に代わる唯一の防壁であり、設定で外部公開へ切り替える手段を提供してはならない。

#### Scenario: ループバックからのリクエストを受け付ける

- **WHEN** 同一マシンのプロセスが `http://127.0.0.1:<port>/api/*` を呼ぶ
- **THEN** 認証情報を要求せずに処理する

#### Scenario: 同一 LAN の他ホストから到達できない

- **WHEN** 同一 LAN の別ホストがサーバの LAN アドレス宛にリクエストする
- **THEN** ソケットレベルで接続が確立せず、いかなる会計データも返さない

#### Scenario: 外部公開へ切り替える設定を持たない

- **WHEN** 環境変数や設定ファイルでバインドアドレスを変更しようとする
- **THEN** そのような設定項目は存在せず、待ち受けは常に `127.0.0.1` である

### Requirement: 単一オーナーの自動解決

システムは control plane の唯一の `users` 行をオーナーとして自動解決し、
以降のすべての処理をそのユーザーの data plane に対して行う SHALL。ログイン操作は存在しない。

#### Scenario: 既存のオーナーを解決する

- **WHEN** `users` に行が1件存在する状態でリクエストが到達する
- **THEN** その `userId` を解決し、`DbRouter.userDb(userId)` の data plane に対して処理する

#### Scenario: 初回起動でオーナーを作成する

- **WHEN** `users` が空の状態でサーバが起動する
- **THEN** ULID を採番して `users` に1行を作成する
- **AND** `$DATA_DIR/users/{id}.sqlite` を作成し、最新スキーマへマイグレーションする
- **AND** 勘定科目・税区分・償却率等の `is_system` シードを投入する

#### Scenario: 複数行を検出したら起動を止める

- **WHEN** `users` に2行以上が存在する
- **THEN** どの行を使うか推測せずエラーとして起動を中断する（誤った帳簿を開かない）

#### Scenario: 現在のオーナー情報を返す

- **WHEN** `GET /api/me` を呼ぶ
- **THEN** control plane の `users` 行を返す

### Requirement: シード追加への自己修復

システムは data plane を開くたびに冪等なシード適用を行い、後から追加された標準シードへ追いつかせる SHALL。

#### Scenario: 開くたびに不足シードを補う

- **WHEN** `DbRouter.userDb()` が既存の data plane を開く
- **THEN** 不足している `is_system` シードを冪等に投入する
- **AND** 利用者側の操作を一切要求しない

### Requirement: 取込スキルの呼び出し境界

システムは `/skill` 配下のルートを、ループバック到達性のみを条件として受け付ける SHALL。
トークンその他の認証情報を要求してはならない。

#### Scenario: ローカルのスキルが認証なしで呼ぶ

- **WHEN** 同一マシンで動作する取込スキルが `http://127.0.0.1:<port>/skill/*` を呼ぶ
- **THEN** オーナーの data plane に対して処理し、認証情報を要求しない

#### Scenario: 過大なリクエストを遮断する

- **WHEN** 5MB を超えるリクエストボディが `/skill/*` に到達する
- **THEN** 413 を返す
