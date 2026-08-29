# filing-corner-assist — タスク

## 1. 欄対応の正（docs）

- [x] 1.1 `docs/filing-corner-mapping.md` を新設: form-mapping の様式ボックス → 作成コーナー画面/欄の対応表（青色申告決算書・所得税第一表/第二表・消費税簡易課税）。対象年分と「乖離時は停止して報告」の規約を明記

## 2. core: 入力指示書への射影

- [x] 2.1 指示書の型（画面グループ → 項目、checksum ブロック）を shared/core に定義
- [x] 2.2 既存 organ 出力（blue-statement / income-tax / consumption）→ 指示書構造への純関数を実装
- [x] 2.3 ゴールデンテスト: マツダ2 基準データで指示書の金額が tax-return 組成と一致すること・checksum（所得税/消費税）の期待値固定

## 3. server: precheck・指示書・完了記録

- [x] 3.1 `GET /api/filing/precheck`: 貸借一致・青色控除設定・事業区分設定・控除入力有無・未確定 draft 件数を blocking/warning 区分＋該当画面リンク付きで返す（年度なしは 200 + null）
- [x] 3.2 `GET /api/filing/instruction-sheet`: 既存 organ を呼び core の射影で返す（年度なしは 200 + null）
- [x] 3.3 data plane マイグレーション: `filing_records`（添付は既存 attachments テーブルが polymorphic＝target_type='filing_record' で保持。別テーブル不要と判明し design D4 を修正）
- [x] 3.4 attachments のファイル保存・制約・ハッシュ処理をサービスへ共通化（既存の仕訳添付の挙動は不変のままリファクタ）
- [x] 3.5 `POST/GET/DELETE /api/filing/records`（複数記録可・削除は添付ごと）と `POST /api/filing/records/:id/attachments`
- [x] 3.6 server テスト: precheck の各判定・指示書の一致・完了記録 CRUD・添付制約（アーカイブ帳簿 409 は withBook 共通処理＝既存 archive.test が担保）

## 4. mcp: ツールと定型手順

- [x] 4.1 `get_filing_precheck`・`get_filing_sheet` ツール（読み取り・次の一手付き。MAX_TOOLS を 20→24 に拡張＝22本）
- [x] 4.2 `record_filing` ツール(記録作成＋控えファイルパス受け取り→生バイナリ添付。削除は露出しない。connection に rawBody 追加)
- [x] 4.3 定型手順「確定申告の転記」prompt（kanean_filing）: 指示書のみを源とする・認証と送信は利用者・検算一致ゲート・不一致時は停止して差分報告・途中保存での再開、を織り込む。manifest/バージョン 0.3.0
- [x] 4.4 mcp テスト: ツール入出力・書き込み許可リスト・prompt が規約文言を含むこと（bundle 検証も通過）

## 5. web: 確定申告画面

- [x] 5.1 「決算・申告」グループに確定申告画面を追加（URL ハッシュルーティング準拠・OPENABLE_TABS にも filing 追加）
- [x] 5.2 precheck 結果表示（不備/注意の区分・該当画面への導線・「提出可能」を出さない）
- [x] 5.3 入力指示書ビュー（画面順・項目コピー・検算税額の明示）
- [x] 5.4 AI 転記の案内（MCP 到達観測の有無で出し分け・断定しない文言）
- [x] 5.5 完了記録フォームと一覧（税目・提出方法・提出日・受付番号・控え PDF 添付）、corner_etax 記録時の 65 万控除設定確認への導線
- [x] 5.6 web テスト（純関数単位: splitIssues / aiGuide / needs65Hint）

## 6. 仕上げ

- [x] 6.1 `pnpm build && pnpm test && pnpm lint && pnpm typecheck` 全通過
- [x] 6.2 scratch DATA_DIR＋フィクスチャで実画面確認（precheck 3警告＋導線 → 指示書 A1〜C4・検算 還付98,527/消費税50,000 → 完了記録の作成＋65万控除バナー、を実ブラウザで確認）
- [x] 6.3 openspec validate --strict 通過を確認し、delta spec を実装実態に追随（完了記録の年分は open 年度から解決）

## 7. 申告期に残すフォローアップ（実装後・別作業）

- [ ] 7.1 令和8年分の作成コーナー公開後に mapping を実画面で検証・更新（Open Questions 参照）
