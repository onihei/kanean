# 銀行取込 import API 契約 — Kanean

> 銀行（普通預金）をスキルトラックに乗せる import API（[acquisition-skill-spec §7/§12]・[classification-policy.md §5]）。
> EC（[ec-import-api.md]）と同じ **token 認証1系統**で、(1) 巡回対象の取得 (2) 分類履歴の取得 (3) 仕訳候補の draft 投入 を行う。
> **EC との違い**: 貸方が「未払金チャネル（クリアリング連鎖・[csv-format §4.3]）」でなく **普通預金が一脚**で、direction（入金/出金）が貸借を決める。
> 受け口は本体が **zod 検証**し、**会計期間ゲート・冪等性・科目検証**の**権威**を持つ（スキルを信用しすぎない）。

---

## 0. 共通仕様

[ec-import-api.md §0] と同じ。差分のみ:

- **ベースパス**: `/skill`（認証なし・ループバック限定）。EC と同一マウント。
- **冪等性**: 銀行は **出現インデックス方式**＝`dedupHash = sha256(取引日, 金額, 方向, 摘要, 出現インデックス)`（[csv-format C-6]・[import/types.ts] `withDedupHashes`）。**UI手動CSV取込（`bank_ufj` パーサ）と同一**ゆえ、同一口座を両トラックで取り込んでも二重計上しない（同一行は dedup スキップ）。摘要は `toHankaku` 正規化して照合（半角カナ・全角差を吸収）。
- **金額**: `amount` は方向と分離した**非負円整数**（方向は `direction`）。`balance`（差引残高）は残高チェーン（[csv-format C-10]・`reconcileBalances`）の素。**金額は取得層（スキル）が DOM 抽出するため、残高チェーンの連続性が正確性の検証手段**。

---

## 1. `GET /skill/linked-services` — 巡回対象＋最終取得日（EC＋銀行＋カード）

[ec-import-api.md §1] の応答に **`bankAccounts[]`**（銀行）と **`cards[]`**（カード）を追加（EC の `services[]` は不変）。

### Response `200`（抜粋）
```json
{
  "openFiscalYear": { "id": 7, "startDate": "2026-01-01", "endDate": "2026-12-31" },
  "evidenceCapture": false,
  "services": [ /* EC（未払金チャネル）。[ec-import-api.md §1] */ ],
  "bankAccounts": [
    {
      "source": "bank_ufj",
      "accountRef": "bank_ufj-1",
      "displayName": "三菱UFJ銀行",
      "depositSubAccount": "普通預金 / 三菱UFJ銀行",
      "lastImportedAt": "2026-05-31T10:20:00+09:00",
      "fetchSince": "2026-05-01"
    }
  ],
  "cards": [
    {
      "source": "card_mufg_visa",
      "accountRef": "card_mufg_visa-1",
      "displayName": "三菱UFJ-VISA",
      "payableSubAccount": "未払金 / 三菱UFJ-VISA",
      "lastImportedAt": null,
      "fetchSince": "2026-01-01"
    }
  ]
}
```

| フィールド | 説明 |
|---|---|
| `bankAccounts[].source` | カタログ key / `import_source_type`（`bank_ufj` 等）。巡回対象＋履歴/学習キー（§2 lookup の `source`）|
| `bankAccounts[].accountRef` | `linked_account_ref`（`bank_ufj-1` 等）。**§3 bank/journal-candidates の投入先**（普通預金の口座補助を一意に指す）|
| `bankAccounts[].depositSubAccount` | 一脚に立つ普通預金の補助科目（`"普通預金 / 三菱UFJ銀行"`）|
| `bankAccounts[].fetchSince` | **差分の起点**＝`max(直近取得済みの txnDate, openFiscalYear.startDate)`。これ以降を巡回 |
| `cards[].source`/`accountRef`/`fetchSince` | カード（`card_mufg_visa` 等）。投入先は**銀行と同じ** §3 `bank/journal-candidates`（importer の一脚は accountRef の補助科目で汎用＝**未払金(カード)が一脚**）。`fetchSince` の意味は銀行と同じ |
| `cards[].payableSubAccount` | 一脚に立つ未払金カードチャネルの補助科目（`"未払金 / 三菱UFJ-VISA"`）|

- 銀行口座は既存カタログ（[services/catalog.ts] kind='bank'・parent='普通預金'）、カードは kind='card'・parent='未払金' に登録（既存「連携サービス」タブ `registerService`）。
- **カードの仕訳**: カード利用は `direction='out'` で `借)費用/貸)未払金(card)`。Amazon/楽天等の**連携EC利用は付替え**＝`treatment='settlement'`＋`counterSubAccountRef=<ECの accountRef>` で `借)未払金(EC)/貸)未払金(card)`（費用の二重計上を防ぐ・[csv-format §4.3]）。残高列が無いので残高チェーンの代わりに**Σ利用＝請求額**で検算する（スキル `acquisition-ufjvisa`）。

---

## 2. `POST /skill/classification-history/lookup` — 確定分類履歴

[ec-import-api.md §2] と**同一**。`source` に `bank_ufj` を渡し、`items` に今回の**摘要**配列を渡す。
銀行は品名でなく摘要→科目（[classification-policy.md §5]）。確定実績は §4 で `mapping_history`（sourceType=`bank_ufj`・pattern=摘要）へ書き戻される。

---

## 3. `POST /skill/bank/journal-candidates` — 銀行仕訳候補を draft 投入

正規化取引＋AI仕訳候補を受け、`raw_transactions` と **draft 仕訳**を生成。**普通預金が一脚**で direction が貸借を決める。

### Request
```json
POST /skill/bank/journal-candidates

{
  "accountRef": "bank_ufj-1",
  "fileName": "bank_ufj_2026-05.json",
  "transactions": [
    { "txnDate": "2026-05-01", "amount": 718,   "direction": "in",  "description": "税引前利息",        "treatment": "owner_contribution", "reason": "預金利息＝利子所得・損益外", "confidence": "high", "policyRef": "ec-classify@v3", "balance": 2916474 },
    { "txnDate": "2026-05-01", "amount": 109,   "direction": "out", "description": "国税",              "treatment": "owner_draw",         "reason": "利息の所得税源泉（同日利息とペア）", "confidence": "high", "policyRef": "ec-classify@v3", "balance": 2916365 },
    { "txnDate": "2026-05-11", "amount": 193945,"direction": "out", "description": "クレジット",        "treatment": "settlement", "proposedAccount": "未払金", "counterSubAccountRef": "card_mufg_visa-1", "reason": "カード引落＝未払金決済", "confidence": "high", "policyRef": "ec-classify@v3", "balance": 37717278 },
    { "txnDate": "2026-05-15", "amount": 330000,"direction": "in",  "description": "カ）ソフトウエアカイハツ", "treatment": "revenue", "proposedAccount": "売掛金", "reason": "報酬入金＝売掛金回収", "confidence": "medium", "policyRef": "ec-classify@v3", "balance": 38047278 },
    { "txnDate": "2026-05-27", "amount": 8800,  "direction": "out", "description": "トウキヨウデンリヨク", "treatment": "expense", "proposedAccount": "水道光熱費", "reason": "電気料金", "confidence": "high", "policyRef": "ec-classify@v3", "balance": 38038478 }
  ]
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `txnDate` | ○ | 取引日（ISO `YYYY-MM-DD`・発生日）|
| `amount` | ○ | 非負円整数（方向は `direction`）|
| `direction` | ○ | `in`（入金＝普通預金が増える）/ `out`（出金＝減る）|
| `description` | ○ | 摘要（+摘要内容を半角スペースで連結）。学習・dedup・分類キー |
| `balance` | – | 差引残高（残高チェーン）。負残高も可 |
| `treatment` | – | `expense`/`owner_draw`/`owner_contribution`/`revenue`/`settlement`/`unresolved` |
| `proposedAccount` | – | 相手科目名（expense/revenue/settlement で使用）。本体が `account_id` へ検証 |
| `counterSubAccountRef` | – | 相手科目の補助（settlement の未払金カードチャネル等）の `linked_account_ref`。親勘定一致時のみ採用 |
| `reason`/`confidence`/`policyRef`/`evidenceRef` | – | 監査・承認UI表示用 |

### treatment → 貸借（本体が direction と組み合わせて機械構築）

| treatment | 相手科目 | 入金(in) | 出金(out) | 用途（[classification-policy.md §5]）|
|---|---|---|---|---|
| `expense` | proposedAccount | 借)普通預金 / 貸)費用 | 借)費用 / 貸)普通預金 | 公共料金・通信・消費税納付（租税公課）等 |
| `revenue` | proposedAccount（売掛金/売上）| 借)普通預金 / 貸)売掛金 | — | 報酬入金＝売上回収 |
| `settlement` | proposedAccount（未払金）+ sub | — | 借)未払金 / 貸)普通預金 | カード引落（費用は最上流で計上済＝二重計上しない）|
| `owner_contribution` | 事業主借 | 借)普通預金 / 貸)事業主借 | — | 受取利息（個人の利子所得・損益外）|
| `owner_draw` | 事業主貸 | — | 借)事業主貸 / 貸)普通預金 | 利息源泉（国税/地方税）・私用引出 |
| `unresolved`・未知科目 | 未確定勘定 | 借)普通預金 / 貸)未確定勘定 | 借)未確定勘定 / 貸)普通預金 | 真の判別不能（要承認）|

### 受け口の処理（本体が権威）
1. **zod 検証**（型・必須・`amount` 非負円整数・安全上限・配列/本文サイズ上限）。
2. **冪等性**: 入力全件を順序保持で `withDedupHashes`（出現インデックス）。**期間外も出現連番を消費**＝UI parser（whole-file dedup→importer 期間ゲート）と byte 互換。既存は dedup スキップ。
3. **会計期間ゲート**: `txnDate` が open 期間外は**登録しない**（翌期は繰越後）。除外件数を返す。
4. **科目解決**: `treatment`→相手科目名（owner_contribution→事業主借 等）→ `account_id`。**未知/曖昧は `未確定勘定`＋flag**（黙って確定しない）。
5. **draft 生成**: 普通預金(line_no=1・口座補助)＋相手科目(line_no=2)。side は direction（in=普通預金が借方）。`auto_journal_rules`/institution は**通さない**（[acquisition-skill-spec §7.1]）。**1行ごとにトランザクション**で原子化。**status=draft**。
6. `import_batches` を1件作成し `raw_transactions`（`balance` 込み）を紐付け。

### Response `200`
```json
{
  "batchId": 88,
  "acceptedRows": 5,
  "draftEntries": [ { "entryId": 9101, "index": 0 } ],
  "skippedDup": 0,
  "duplicates": [],
  "excludedCount": 0,
  "excludedOutOfPeriod": [],
  "unresolved": [],
  "warnings": [],
  "periodStart": "2026-01-01",
  "periodEnd": "2026-12-31"
}
```

| フィールド | 説明 |
|---|---|
| `acceptedRows` | 取込んだ取引数 |
| `draftEntries` | 生成した draft 仕訳（`{entryId, index}`・承認待ち。index=入力配列の位置）|
| `skippedDup` / `duplicates` | 重複でスキップ（`{index, txnDate, amount, description}` サンプル先頭50件）|
| `excludedCount` / `excludedOutOfPeriod` | 期間外で除外（繰越後に取込）|
| `unresolved` | 要確認（未確定勘定・事業主勘定・settlement 補助未特定。サンプル先頭50件）|
| `warnings` | 行単位の取込失敗等 |

---

## 4. 承認→学習（書き戻し）

[ec-import-api.md §4] と同じ機構。確定時、`mapping_history`（sourceType=`bank_ufj`・pattern=摘要・科目=line_no=2 の相手科目）へ書き戻し、次回の §2 lookup でAIが優先提案する（学習ループ）。
決定的な金融取引（利息/源泉/消費税納付・摘要→科目）も学習してよい（[acquisition-skill-spec §7.2]）。`未確定勘定` は学習しない。

---

## 5. 実装状況

- [x] `bankAccounts`（kind='bank'）／`cards`（kind='card'）を `linked-services` で列挙・`fetchSince`/`lastImportedAt`（`import/ecServices.ts`）
- [x] `bank/journal-candidates`：zod 検証＋普通預金一脚の draft 生成（`http/ec.ts`＋`import/bankImport.ts`＋純粋マッピング `import/bank.ts`）
- [x] restore（ignored→復帰）も AI候補から再仕訳（`journal/journalize.ts` の `isBankSkillRaw`→`journalizeBankRow` 分岐）
- [x] 冪等＝出現インデックス方式（UI手動CSV取込と互換・`import/types.ts` `withDedupHashes`）／残高は `raw_transactions.balance` 保存（残高チェーン `import/reconcile.ts`）
- [x] スキル本体＝Claude Code skill（`.claude/skills/acquisition-mufg`・`acquisition-shinsei`・オーケストレータ `acquisition` が銀行トラックを束ねる）。**Playwright MCP**（ヘッドフル＝人が2FA・DOM抽出）
- [x] 新生銀行（bank_shinsei）のスキル化済み（`.claude/skills/acquisition-shinsei`・UFJ同様 DOM 抽出。新生固有＝国税/地方税は同日利息とペアの**利息源泉**で `事業主貸`・⚠️消費税でない）
- [x] **UFJ-VISA（card_mufg_visa）のスキル化済み**（`.claude/skills/acquisition-ufjvisa`・DOM 抽出）。**カードは bank API を共有**（一脚＝未払金）。`借)費用/貸)未払金(card)`、連携EC利用は **`settlement`＋`counterSubAccountRef`** で `借)未払金(EC)/貸)未払金(card)` に**付替え**（二重計上回避）。残高列なし→Σ利用＝請求額で検算。`linked-services` の `cards[]` で列挙。
- [~] 銀行↔カード／EC の決済突合（付替え連鎖・[csv-format §4.3]）: カード→EC は**店名→連携EC**で行単位付替え（実装）。**金額×日付の厳密突合**は将来拡張。
