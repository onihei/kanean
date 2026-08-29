# EC取込 import API 契約 — Kanean

> スキルトラック（EC連携取込）が本体へ叩く **3本のAPI**（[acquisition-skill-spec §7.4]）。
> **token 認証の1系統**で、(1) 巡回対象の取得 (2) 分類履歴の取得 (3) 仕訳候補の draft 投入 を行う。
> 受け口は本体が **zod 検証**し、**会計期間ゲート・冪等性・科目検証**の**権威**を持つ（スキルを信用しすぎない）。
>
> **関連**: 銀行（普通預金）のスキルトラックは **[bank-import-api.md]**（`POST /skill/bank/journal-candidates`・普通預金が一脚）。`GET /skill/linked-services` は EC の `services` に加え銀行の `bankAccounts` も返す（[bank-import-api.md §1]）。`classification-history/lookup`（§2）は EC/銀行で共通（`source` で切替）。

---

## 0. 共通仕様

- **ベースパス**: スキル3本は `/skill`（ボディ上限・エラー形式が `/api` と異なるため分離）。
- **認証**: **なし**。本体は `127.0.0.1` 限定で待ち受けており（[architecture §5]）、同一マシンで動くスキルが
  `http://127.0.0.1:<PORT>/skill/*` を直接呼ぶ。到達できること自体が認可。
  - import トークン（`mwi_`）とブラウザ認証（ループバック＋PKCE）は**廃止**。サーバとスキルが同一マシンに
    閉じた時点で、Bearer トークンは到達性の制御を何も追加しないため。
  - 旧スキルが送る `Authorization` ヘッダは**無視**され、エラーにはならない（移行時に順序依存がない）。
  - 処理対象は解決された帳簿の data plane（`books/{book_id}.sqlite`）（[architecture §4]）。
  - **帳簿が2冊以上ある場合のみ** `X-Book-Id: <bookId>` を送る（1冊なら省略可）。未指定で複数あると
    400 `book_required` を返し、応答の `books[]`（id・name）で選択肢を提示する（[architecture §5]）。
- **ケーシング**: リクエスト/レスポンスの JSON キーは **camelCase**（本体の他APIと同じ house style）。本書の例・スキルもすべて camelCase。
- **金額**: 円整数（`Yen`）。小数・通貨記号を含めない。負数は 400、円整数の安全上限（10^12 未満）超も 400。`currency` 既定 `JPY`。
- **冪等性**: `dedupHash = sourceType + orderId + lineNo`（保存は内部値）。同一の再POSTは安全（既存はスキップして件数を返す。[csv-format §4.2]）。
- **エラー形（共通）**:
  ```json
  { "error": { "code": "validation_error", "message": "…", "details": [ { "path": "orders.0.lineAmount", "issue": "..." } ] } }
  ```
  - `code`: `validation_error`(400) / `no_open_fiscal_year`・`unknown_source`・`precondition_failed`(409) / `internal`(500)。前提不足（会計年度なし・連携サービス未登録・シード未投入）は 409。
- **「黙って落とさない」**: 期間外・重複・未解決は**握りつぶさず件数と明細を返す**（[csv-format §4/§5]・[acquisition-skill-spec §5]）。

---

## 1. `GET /skill/linked-services` — 巡回対象＋最終取得日

スキルが「どのサービスを・いつ以降」巡回するかを決める情報源。**レジストリは本体DBが正**（口座マスタ/F-IMP-8 を拡張）。

### Request
```
GET /skill/linked-services
```

### Response `200`
```json
{
  "openFiscalYear": { "id": 7, "startDate": "2025-01-01", "endDate": "2025-12-31" },
  "services": [
    {
      "source": "amazon",
      "accountRef": "amazon-1",
      "displayName": "Amazon",
      "payableSubAccount": "未払金 / Amazon",
      "lastImportedAt": "2025-05-31T10:20:00+09:00",
      "fetchSince": "2025-05-01"
    },
    {
      "source": "rakuten",
      "accountRef": "rakuten-1",
      "displayName": "楽天市場",
      "payableSubAccount": "未払金 / 楽天",
      "lastImportedAt": null,
      "fetchSince": "2025-01-01"
    }
  ]
}
```

| フィールド | 説明 |
|---|---|
| `openFiscalYear` | 開いている会計期間（`{id,startDate,endDate}`）。**取得対象は `[startDate, endDate]` の `orderDate` のみ**（[acquisition-skill-spec §5]）。未作成なら `null` |
| `services[].source` | カタログ key / `import_source_type`（`amazon`/`rakuten`）。**巡回対象＋履歴/学習キー**（§2 lookup の `source`） |
| `services[].accountRef` | `linked_account_ref`（`amazon-1` 等）。**§3 journal-candidates の投入先**（未払金チャネルを一意に指す。複数アカウント可） |
| `services[].payableSubAccount` | 計上先の未払金チャネル補助科目（クリアリング・[csv-format §4.3]） |
| `services[].lastImportedAt` | 前回取込時刻（null=未取込） |
| `services[].fetchSince` | **差分の起点**＝`max(直近取得済みの orderDate, openFiscalYear.startDate)`。これ以降を巡回（[acquisition-skill-spec §7/§8]） |

- 開いている会計年度が無くても **200** を返し `openFiscalYear: null` で示す（巡回前に人へ通知）。実際の年度ゲートは §3 journal-candidates が `409 no_open_fiscal_year` で担保。

---

## 2. `POST /skill/classification-history/lookup` — 確定分類履歴（絞り込み済み）

スキルのAI分類の**最優先入力**。`mapping_history`（EC転用）から、**今回バッチの品名に関連する行だけ**を返す。
注入 payload を履歴総量から切り離すため、フィルタは**サーバ（SQL）側**で適用（[acquisition-skill-spec §7.3]・[data-model §2.9.2]）。

### Request
```json
POST /skill/classification-history/lookup

{
  "source": "amazon",
  "items": ["SanDisk microSDXC 256GB", "鬼滅の刃 24巻", "謎の雑貨X"],
  "windowMonths": 12,
  "limit": 200
}
```

| フィールド | 必須 | 説明 |
|---|---|---|
| `source` | ○ | `amazon` / `rakuten` 等（`mapping_history.source_type`） |
| `items` | ○ | 今回抽出した品名の配列（関連プレフィルタのキー） |
| `windowMonths` | – | 既定 **12**。`lastUsedAt` がこの月数以内の行だけ候補（忘却窓） |
| `limit` | – | 既定 **200**。`recency × hitCount` 上位K件で打切り |

### Response `200`
```json
{
  "policy": { "windowMonths": 12, "limit": 200, "matchedItems": 1 },
  "candidates": [
    {
      "pattern": "SanDisk microSDXC 128GB",
      "proposedAccount": "消耗品費",
      "treatment": "expense",
      "subAccountId": null,
      "hitCount": 6,
      "lastUsedAt": "2025-04-12",
      "score": 5.82
    }
  ]
}
```

- `score` は `recency係数(0〜1) × hitCount`（0〜hitCount の範囲。順位付け用で正規化されない）。
- サーバ処理: ① 集約済み `pattern→科目`（`hitCount`） → ② `items` のトークンと語が重なる行に限定（関連プレフィルタ） → ③ `lastUsedAt ≥ now - windowMonths` → ④ `recency × hitCount` で上位 `limit`。
- 関連が無い品（例 `謎の雑貨X`）は候補に出ない＝スキルは §ポリシー(md)で判断（新規品目は正しくAIへ）。
- `pattern` は正規化済みキー（保存値は不変、照合のみ正規化・[csv-format §5]）。

---

## 3. `POST /skill/ec/journal-candidates` — 仕訳候補を draft 投入

[csv-format §4.2] の正規化明細＋AI仕訳候補を受け、`raw_transactions`(EC) と **draft 仕訳**を生成（クリアリング連鎖 [csv-format §4.3]）。

### Request
```json
POST /skill/ec/journal-candidates

{
  "accountRef": "amazon-1",
  "fileName": "amazon_2025-05.json",
  "orders": [
    {
      "orderId": "249-1234567-7654321",
      "orderDate": "2025-05-20",
      "orderTotal": 4880,
      "paymentHint": "UFJ-VISA",
      "currency": "JPY",
      "shipping": 0,
      "pointsUsed": 100,
      "lines": [
        {
          "lineNo": 1,
          "itemName": "SanDisk microSDXC 256GB",
          "quantity": 1,
          "lineAmount": 2980,
          "proposedAccount": "消耗品費",
          "treatment": "expense",
          "reason": "作業用ストレージ",
          "confidence": "high",
          "policyRef": "ec-classify@v1",
          "evidenceRef": "evidence/amazon/249-1234567/line1.html"
        },
        {
          "lineNo": 2,
          "itemName": "鬼滅の刃 24巻",
          "quantity": 1,
          "lineAmount": 2000,
          "proposedAccount": "事業主貸",
          "treatment": "owner_draw",
          "reason": "漫画＝私用",
          "confidence": "high",
          "policyRef": "ec-classify@v1",
          "evidenceRef": "evidence/amazon/249-1234567/line2.html"
        }
      ]
    }
  ]
}
```

- **`lineAmount` は値引き反映後の税込純額**（[csv-format §4.2]）。割引は別フィールドを持たず純額化（商品別値引きは適格請求書PDF由来）。
- **注文レベル調整**（任意・非負円整数）: `shipping`（送料）/ `pointsUsed`（ポイント利用）/ `pointsEarned`（付与）。本体が調整仕訳を生成して **未払金=請求額（`orderTotal`）** にそろえる（方式B・[csv-format §4.3]）。

### 受け口の処理（本体が権威）
1. **zod 検証**（型・必須・`lineAmount`/`orderTotal`/`shipping`/`pointsUsed`/`pointsEarned` は非負円整数かつ安全上限内・`Σ lineAmount + shipping − pointsUsed` と `orderTotal` の差異→警告。配列上限・本文サイズ上限あり）。
2. **会計期間ゲート**: `orderDate` が open 期間外の注文は**登録しない**（翌期は繰越後）。除外件数を返す（[acquisition-skill-spec §5]）。
3. **冪等性**: 明細は `sourceType+orderId+lineNo`、調整は `sourceType+orderId+adj:<kind>` で既存はスキップ。**1行ごとにトランザクション**で raw+仕訳を原子化（途中失敗は当該行のみロールバック＝部分取込）。
4. **科目解決**: `proposedAccount`（名前）→ `account_id`。**未知/曖昧は `未確定勘定` ＋ flag**（黙って確定しない）。`treatment=owner_draw`→`事業主貸`、`unresolved`→`未確定勘定`。
5. **draft 生成**: 明細＝借）費用科目（line_no=2） ／ 貸）`未払金`(該当チャネル補助＝`payableSubAccount`, line_no=1)。**注文レベル調整**＝送料：借)雑費/貸)未払金、ポイント利用：借)未払金/貸)事業主借、ポイント付与：借)事業主貸/貸)雑収入（調整は draftEntries に `lineNo=0` で計上）。**status=draft**（人が承認）。`auto_journal_rules`/institution は**通さない**（[acquisition-skill-spec §7.1]）。
6. `import_batches` を1件作成し `raw_transactions` を紐付け。

### Response `200`
```json
{
  "batchId": 412,
  "acceptedLines": 2,
  "draftEntries": [ { "entryId": 9001, "orderId": "249-1234567-7654321", "lineNo": 1 } ],
  "skippedDup": 0,
  "duplicates": [],
  "excludedCount": 0,
  "excludedOutOfPeriod": [],
  "unresolved": [
    { "orderId": "249-1234567-7654321", "lineNo": 2, "itemName": "鬼滅の刃 24巻", "reason": "owner_draw → 事業主貸（要承認）" }
  ],
  "warnings": [],
  "periodStart": "2025-01-01",
  "periodEnd": "2025-12-31"
}
```

| フィールド | 説明 |
|---|---|
| `batchId` | `import_batches.id` |
| `acceptedLines` | 取込んだ明細数 |
| `draftEntries` | 生成した draft 仕訳（`{entryId, orderId, lineNo}`・承認待ち。先頭サンプルでなく全件） |
| `skippedDup` / `duplicates` | 重複でスキップした総数 / 明細サンプル（先頭50件） |
| `excludedCount` / `excludedOutOfPeriod` | 期間外で除外した総数 / 明細サンプル（`{orderId,lineNo,orderDate}`。繰越後に取込）|
| `unresolved` | 要確認の明細（`{orderId,lineNo,itemName,reason}`：未確定勘定・owner_draw 等。サンプル先頭50件）|
| `warnings` | `orderTotal` と明細合計の不一致・行単位の取込失敗など（`{orderId,message}`）|
| `periodStart` / `periodEnd` | 取込に用いた open 期間（除外の参考） |

---

## 4. 承認→学習（書き戻し）

API外（UI側）だが契約として明記: ユーザーがUIで draft を**確定**したとき、確定した「`source` + 正規化 `item_name` → 科目/treatment」を `mapping_history` へ**書き戻す**（`hit_count`++・`last_used_at` 更新）。これが §2 lookup の入力となり、次回取込でAIが優先提案する（学習ループ・[acquisition-skill-spec §7.2]）。institution（源泉/消費税/利息）は学習しない（[csv-format §5]）。

## 5. 実装状況・次のアクション

- [x] `linked-services`：未払金チャネル補助から EC連携を列挙・`fetchSince`/`lastImportedAt`（`import/ecServices.ts`）
- [x] `classification-history/lookup`：関連プレフィルタ・recency窓・上限K（`journal/ecClassify.ts`＋`ecClassifyService.ts`）
- [x] `journal-candidates`：zod 検証＋§4.3 クリアリング連鎖の draft 生成（`http/ec.ts`＋`import/ecImport.ts`）
- [x] EC連携サービスの登録UI＝既存「連携サービス」タブ（`registerService` が `linked_account_ref`/`import_source_type` をセット）
- [x] スキル本体＝Claude Code skill（`.claude/skills/acquisition` ＋ `acquisition-amazon`/`acquisition-rakuten`）が本API 3本を叩く
- [ ] EC↔カードの突合（付替え）は [csv-format §4.3] と併せて（本APIは EC 最上流の費用計上まで）
- [x] スクレイプ基盤＝**`playwright` MCP**（`.mcp.json`・ヘッドフル・永続プロファイル `./.kanean/pw-profile`＝ログイン継続・証跡 `./.kanean/evidence/amazon`。`/.kanean/` は gitignore 済）。暗号化は将来課題
