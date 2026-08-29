---
name: acquisition-amazon
description: Amazon.co.jp の注文履歴をヘッドフルブラウザで巡回し、購入明細（品名・数量・金額）を正規化して抽出する。acquisition オーケストレータから呼ばれるサイト個別スキル。
---

# acquisition-amazon — Amazon 明細の取得・正規化

`acquisition` オーケストレータのサイト個別スキル。Amazon の注文履歴を巡回し、`docs/csv-format.md` §4.2 の
正規化明細を返す（ログイン・2FAは人、抽出はAI）。安全原則・期間ゲート・証跡保存は `acquisition` SKILL.md に従う。

## 固定スクリプト（優先経路）

まず `node .claude/skills/acquisition/scripts/scrape.mjs amazon --since … --until … --out /tmp/acq-amazon.json [--evidence]` で取得する（注文一覧→詳細→適格請求書PDF→テキスト化（同梱 pdf.js）→突合まで自動。分類・投入は `acquisition` の手順3-4）。exit 0 なら以下の MCP 巡回は行わない。exit 4（部分成功）は `failedOrders` の注文だけ以下の手順で MCP 補完。失敗時のフォールバック・修復手順は `acquisition` SKILL.md 手順2b（較正ポイントは `packages/acquisition/src/sites/amazon.mjs` の `DEFAULT_SEL` と `parseInvoiceItems`）。**以下は MCP フォールバック時・修復時の参照**。

## ブラウザ基盤

本リポジトリ設定済みの **`playwright` MCP**（`.mcp.json`）を使う。ヘッドフル・永続プロファイル `./.kanean/pw-profile`（ログイン継続）・証跡出力 `./.kanean/evidence/amazon`。
ページ読取は**アクセシビリティ snapshot（構造化テキスト）**で意味抽出する（ピクセル/vision に頼らない）。スクショは証跡用に補助保存。

## 金額の取得 — **2ソース併用**（PDF＝商品別純額 / 明細ページ＝ポイント・送料）

注文詳細HTMLは「商品別が税込 gross・割引/ポイントは注文合計だけ」で**商品別の値引きが分からない**。そこで:

- **適格請求書PDF**（注文の「領収書等」→「明細書／適格請求書 1/2/3」＝発送ごと・`/documents/download/<uuid>/invoice.pdf`）から **商品別の税込小計（その商品の値引き反映後）＝`lineAmount`**・数量・税率別を取る。**商品別の値引きはここにしか無い**。
- **注文詳細ページ（HTML）**から **`pointsUsed`（Amazonポイント利用）/ `pointsEarned`（付与・任意）/ `shipping`（送料・手数料）/ `orderTotal`（ご請求額）** を取る。**ポイントはPDFに無い**のでここで取る。

### 適格請求書PDFの読み方（playwright MCP + 同梱 pdf.js）
PDFは snapshot で読めないので、**ページ内 fetch（cookie認証）でバイトを取り出して抽出**する。
抽出は同梱の pdf.js で行う＝`pdftotext`（poppler）は要らない:
1. 注文の「領収書等」を開き、`明細書／適格請求書 N` の PDF URL（`/documents/download/<uuid>/invoice.pdf`）を集める。
2. `browser_evaluate` で各 URL を fetch → base64 化して `filename` 保存（例 `.kanean/evidence/amazon/<orderId>/inv<N>.b64`）:
   ```js
   async () => {
     const r = await fetch('<PDF_URL>', { credentials: 'include' })
     const b = new Uint8Array(await r.arrayBuffer())
     let s = ''; for (let i = 0; i < b.length; i += 8192) s += String.fromCharCode.apply(null, b.subarray(i, i + 8192))
     return btoa(s) // %PDF… のbase64
   }
   ```
3. `base64 -d inv<N>.b64 > inv<N>.pdf && node packages/acquisition/bin/pdf-text.mjs inv<N>.pdf` で
   テキスト化し、商品別の行を読む:
   - 例: `Anker … USB-C ケーブル  1  ￥1,264  10%  ￥1,390  ￥1,390`（数量/税抜/税率/税込/小計）。
   - ⚠ **値引は独立行で来る**（商品の小計には織り込まれていない）。実物22注文中4注文がこの形。
     `値引  -￥243  -￥263  -￥263` の**最終カラム**を直前の商品の `lineAmount` から差し引く。
   - ⚠ **配送料が値引で相殺されて正味0になることがある**。その場合 `shipping` は **0**（HTMLの値引前の額を使わない）。
4. PDF が無い/読めない注文は**中断して人へ**（誤った金額を作らない）。複数発送＝PDFも発送ごと。全PDFの商品を `orderId` 単位でまとめる。

## ブラウザ巡回の手順

1. ヘッドフルで開く（`playwright` MCP・永続プロファイルでセッション復元）。ログイン/2FA/CAPTCHA は**人**（見えている窓に直接入力、AIは触れない）。
2. 「注文履歴」を年/期間フィルタで **`fetchSince` 以降かつ open 期間内**に絞り、**古い順**に処理（`acquisition` の watermark 規約）。
3. 各注文:
   - `orderId` / `orderDate`(ISO `YYYY-MM-DD`) / `orderTotal`（詳細ページの「ご請求額」）。
   - **適格請求書PDF**（上記recipe）→ 商品別 `itemName` / `quantity` / `lineAmount`（税込純額）・`lineNo` 1始まり。
   - **詳細ページ** → `pointsUsed` / `pointsEarned`(任意) / `shipping`。
   - **証跡**（`acquisition` 手順1の `evidenceCapture` で分岐）: ON=PDF/スクショを `./.kanean/evidence/amazon/<orderId>/` に保存し `evidenceRef` にパス／OFF=保存スキップ・`evidenceRef` に注文詳細URL（`https://www.amazon.co.jp/your-orders/order-details?orderID=<orderId>`）。
   - 決済元が分かれば `paymentHint`（例 `UFJ-VISA`）。
4. **突合（必ず）**: `Σ lineAmount(純額) + shipping − pointsUsed == orderTotal(請求額)` を検算。合わなければ抽出ミス → 人へ報告（本体も warning を返す）。

## 抽出の注意

- **金額は円整数**。**商品別の値引きは適格請求書PDFの小計で純額化済み**を使う（按分・合わせ込みはしない）。送料/ポイントは `shipping`/`pointsUsed`/`pointsEarned` として渡し、本体が調整仕訳（雑費 / 事業主借 / 事業主貸・雑収入）を生成する。
- 定期おトク便・複数発送で1注文が複数PDFに分割される。`orderId` 単位でまとめる。
- 返品・キャンセル・未発送は費用計上に含めない可能性が高い → 含めず、判断が要るものは人へ。
- 翌期（open 期間外）の `orderDate` は**取得しない**（繰越後に取り込まれる）。
- ギフト券・チャージはポイントとは別。判別不能は人へ。

## 出力

`docs/csv-format.md` §4.2 の正規化明細（注文＝複数 line）。分類（proposedAccount 等）は `acquisition` の手順3で付与する
（本スキルは取得・正規化に専念）。返した明細を `acquisition` が分類→`POST /skill/ec/journal-candidates` する。

## 規約

本人が自分の注文履歴を個人利用の範囲で取得する前提。商用再配布・第三者の代行取得はしない。
