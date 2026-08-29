---
name: acquisition-rakuten
description: 楽天市場の購入履歴をヘッドフルブラウザで巡回し、購入明細（品名・数量・金額）を正規化して抽出する。acquisition オーケストレータから呼ばれるサイト個別スキル。
---

# acquisition-rakuten — 楽天市場 明細の取得・正規化

`acquisition` オーケストレータのサイト個別スキル。楽天市場は**公式CSV出力が無い**ためブラウザ巡回が基本。
注文履歴を巡回し `docs/csv-format.md` §4.2 の正規化明細を返す（ログイン・2FAは人、抽出はAI）。
安全原則・期間ゲート・証跡保存・watermark 規約は `acquisition` SKILL.md に従う（本書は楽天特有の手順のみ）。

## 固定スクリプト（優先経路）

まず `node .claude/skills/acquisition/scripts/scrape.mjs rakuten --since … --until … --out /tmp/acq-rakuten.json [--evidence]` で取得する（購入履歴→注文詳細→純額化→突合まで自動。突合NG・注文全体クーポン未紐づけの注文は `failedOrders` に落ちる＝按分しない）。exit 0 なら以下の MCP 巡回は行わない。exit 4 は `failedOrders` の注文だけ MCP 補完。失敗時のフォールバック・修復手順は `acquisition` SKILL.md 手順2b（較正ポイントは `packages/acquisition/src/sites/rakuten.mjs` の `DEFAULT_SEL`）。**以下は MCP フォールバック時・修復時の参照**。

## ブラウザ基盤

本リポジトリ設定済みの **`playwright` MCP**（`.mcp.json`）を使う。ヘッドフル・永続プロファイル `./.kanean/pw-profile`（ログイン継続）。証跡の保存先は `./.kanean/evidence/rakuten/<orderId>/`（ローカル秘密＝gitignore 済 `/.kanean/` 配下）。
ページ読取は**アクセシビリティ snapshot（構造化テキスト）**で意味抽出する（楽天はカード/HTMLレイアウトなので Amazon と同じく a11y snapshot が向く。ピクセル/vision に頼らない）。スクショは証跡用に補助保存。金額の内訳ブロックが snapshot で取りにくい時だけ `browser_evaluate` で当該 DOM を構造化抽出する。

## 取得方法（優先順）

1. **ブラウザ巡回（本命）**: Playwright MCP でヘッドフル起動し、購入履歴 → 各注文詳細を読む。
2. **注文確認メールの解析（代替・ToS堅い）**: 楽天の注文確認メールから品名・数量・金額を抽出（巡回が不安定な期間のフォールバック）。

## 金額の取得 — 楽天特有（純額化して突合を合わせる）

楽天の注文詳細は「**商品ごとの税込価格** ＋ **注文レベルの調整**（送料・手数料・クーポン・ポイント利用）」で構成され、内訳が画面に出る。下記に振り分けて取り、**`Σ lineAmount + shipping − pointsUsed == orderTotal` が成り立つように**取得する（成り立たないと未払金が請求額とズレ、カード突合が崩れる）。

- **`lineAmount`（商品ごと・税込純額）**: その商品の **値引き反映後の税込額**。
  - **商品割引・ショップクーポン**（特定商品にかかる）は、その商品の `lineAmount` を**純額化**（値引き後の額にする＝Amazon と同じ思想。割引を別フィールドで持たない）。
  - **注文全体にかかるクーポン**は、紐づく商品が分かればその `lineAmount` から引く。**どうしても商品に紐づけられない注文全体クーポンは、合わせ込まずに warning で人へ報告**（按分しない）。
- **`shipping`（注文レベル・非負円整数）**: **送料 ＋ あす楽手数料 ＋ 代引き手数料 ＋ ラッピング等の手数料**を合算（未払金を増やす方向）。
- **`pointsUsed`（注文レベル）**: **楽天ポイント／楽天キャッシュの利用額**（個人ポイントで肩代わり＝未払金を減らす方向。`貸)事業主借`）。
- **`pointsEarned`（注文レベル・任意）**: 獲得（予定）ポイント。請求額に無影響だが取れれば渡す（`借)事業主貸 / 貸)雑収入`）。
- **`orderTotal`（必須）**: その注文の**お支払い金額（税込・請求額）**。カード明細との突合キー（日付＋金額）。

> Amazon の適格請求書PDF（商品別純額）に相当する確定ソースは楽天には無い。**注文詳細ページの内訳が一次ソース**。インボイス対応で店舗が適格請求書を出す場合はそれも証跡保存してよいが、突合は注文詳細の内訳で行う。

## ブラウザ巡回の手順

1. `https://www.rakuten.co.jp/` を**ヘッドフル**で開く（永続プロファイルでセッション復元）。**ログイン／2FA（SMS・SPC本人認証）／合言葉は人**が見えている窓に直接入力（AIは認証情報に触れない）。保存セッションが有効ならそのまま続行。
2. 購入履歴 `https://order.my.rakuten.co.jp/` を開く。期間フィルタを **`fetchSince` 以降かつ open 期間内**に絞り、**古い順（`fetchSince`→今日）に連続して処理**（`acquisition` の watermark 規約。新しい注文だけ先に取ると間が watermark の後ろに隠れて取りこぼす）。古い注文は年/期間の選択が要る場合がある。
   - 一覧の件数が表示上限（ページング）に達していたら**ページ送りで全件**取得する（取りこぼし防止）。
3. 各注文（＝**注文番号** `orderId`。**店舗ごとに別注文**＝1回の買い物が複数 `orderId` になる）について、注文詳細を開いて抽出:
   - `orderId`（注文番号）／ `orderDate`(ISO `YYYY-MM-DD`)／ `orderTotal`（お支払い金額＝請求額）。
   - 商品ごとに `lineNo`(1始まり)／ `itemName`／ `quantity`／ `lineAmount`（税込純額・上記「金額の取得」）。
   - 注文レベル: `shipping`／ `pointsUsed`／ `pointsEarned`(任意)。
   - 決済元が分かれば `paymentHint`（例 `楽天カード` / `UFJ-VISA` / 代引き）。
   - **証跡**（`acquisition` 手順1の `evidenceCapture` で分岐）: ON=注文詳細のスクショ/HTML を `./.kanean/evidence/rakuten/<orderId>/` に保存し `evidenceRef` にパス／OFF=保存スキップ・`evidenceRef` に注文詳細URL。
4. **突合（必ず）**: `Σ lineAmount + shipping − pointsUsed == orderTotal` を検算。合わなければ抽出ミス／未紐づけクーポン → **合わせ込まず人へ報告**（本体も warning を返す）。

## 抽出の注意（楽天特有）

- **店舗ごとに注文が分かれる**: カート1回の購入が複数 `orderId`（店舗別）になる。各注文を独立に扱う（合算しない）。
- **金額は円整数**。**割引は `lineAmount` で純額化**（按分しない）。送料・手数料は `shipping`、ポイント/楽天キャッシュ利用は `pointsUsed`、付与は `pointsEarned` として渡し、本体が調整仕訳（雑費 / 事業主借 / 事業主貸・雑収入）を生成（`docs/csv-format.md` §4.3 方式B）。
- **商品名が長い／装飾的**（【楽天1位】等の修飾・店舗名込み）。**分類に効く核（ブランド・型番・作品名）が残るように** `itemName` を取る（過度な切り詰めはしない）。
- **キャンセル・返品・未発送**は費用計上に含めない可能性が高い → 含めず、判断が要るものは人へ。
- **定期購入（楽天の定期便）**は各回が別注文として出る。そのまま注文単位で扱う。
- **翌期（open 期間外）の `orderDate` は取得しない**（繰越後に取り込まれる）。
- 楽天Pay/ふるさと納税/楽天ブックス等は楽天市場と別導線・別注文番号体系。**本スキルの対象は楽天市場の購入履歴**（他は対象外。判別不能は人へ）。

## 出力

`docs/csv-format.md` §4.2 の正規化明細（注文＝複数 line・**JSONキーは camelCase**）。分類（`proposedAccount`/`treatment`/`reason`/`confidence`/`policyRef`）は `acquisition` の手順3で付与する（本スキルは取得・正規化に専念）。返した明細を `acquisition` が分類→`POST /skill/ec/journal-candidates`（`accountRef` 宛・例 `rakuten-1`）する。

## 規約

本人が自分の購入履歴を個人利用の範囲で取得する前提。商用再配布・第三者の代行取得はしない。生証跡・保存セッションはローカルの秘密（gitignore・非同期）。
