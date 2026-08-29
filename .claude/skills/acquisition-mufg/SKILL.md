---
name: acquisition-mufg
description: 三菱UFJ銀行（三菱UFJダイレクト bk.mufg.jp）の入出金明細をヘッドフルブラウザで巡回し、入出金（摘要・金額・差引残高）を正規化＋AI科目分類して取得する。acquisition オーケストレータから呼ばれるサイト個別スキル。
---

# acquisition-mufg — 三菱UFJ銀行 入出金明細の取得・正規化・分類

`acquisition` オーケストレータのサイト個別スキル。三菱UFJダイレクトの入出金明細を巡回し、
`docs/bank-import-api.md` の正規化取引＋AI仕訳候補を返す（ログイン・2FAは人、抽出・分類はAI）。
安全原則・期間ゲート・証跡保存は `acquisition` SKILL.md に従う。

**EC（Amazon/楽天）と違う点（重要）**:
- 投入先は **`POST /skill/bank/journal-candidates`**（EC の `/skill/ec/journal-candidates` ではない）。
- 仕訳は **普通預金が一脚**で direction（入金/出金）が貸借を決める。借方科目（相手科目）だけAIが分類し、貸借の機械構築は本体（importer）が行う。
- 分類は **品名でなく摘要→科目**（`docs/classification-policy.md` **§5 金融取引**）。利息/源泉/消費税は決定的なので**確信提案**（`unresolved` に逃がさない）。
- 金額は CSV でなく **DOM 抽出**なので、**差引残高チェーンの自己検算が金額正確性の生命線**（後述・必須）。
- 冪等キーは **出現インデックス方式**（`source_type+...` ではなく `取引日+金額+方向+摘要+出現連番`）＝UI手動CSV取込と互換（同一口座を両トラックで二重計上しない）。

## 固定スクリプト（優先経路）

まず `node .claude/skills/acquisition/scripts/scrape.mjs mufg --since … --until … --out /tmp/acq-bank_ufj.json [--evidence]` で取得する（明細テーブル抽出→正規化→**残高チェーン検算**まで自動。検算NGなら投入させず exit 1）。exit 0 なら以下の MCP 巡回は行わず、出力 JSON の `transactions` をそのまま分類へ。失敗時のフォールバック・修復手順は `acquisition` SKILL.md 手順2b（較正ポイントは `packages/acquisition/src/sites/mufg.mjs` の `DEFAULT_SEL`）。**以下は MCP フォールバック時・修復時の参照**。

## ブラウザ基盤

本リポジトリ設定済みの **`playwright` MCP**（`.mcp.json`）を使う。ヘッドフル・永続プロファイル `./.kanean/pw-profile`（ログイン継続）。
ナビゲーション・ログイン状態の確認は a11y snapshot でよいが、**入出金明細は「表」なので `browser_evaluate` でDOMの `<table>` を直接構造化抽出する**（a11y snapshot の整形より桁・行ズレに強い）。同じ `browser_evaluate` 内で正規化（日付ISO化・金額の円整数化・direction 判定）と**残高チェーン検算**まで済ませて、検算OKの結果だけを取り出すのが堅い（手順3-4）。
証跡の保存先は `./.kanean/evidence/mufg/`（ローカル秘密＝gitignore 済 `/.kanean/` 配下）。**`browser_evaluate` の `filename` 保存は戻り値を二重にJSON化する**ので、投入ボディは `filename` に頼らず、戻り値（JSON文字列）を受け取って後段で**素のオブジェクトとして** `/tmp` に書く（投入の節）。

## ブラウザ巡回の手順

1. `https://www.bk.mufg.jp/` を**ヘッドフル**で開き、三菱UFJダイレクトにログイン。**ログイン/2FA（ワンタイムパスワード等）/合言葉は人**が見えている窓に直接入力（AIは認証情報に触れない）。保存プロファイルが有効ならそのまま続行。
2. 「入出金明細照会」を開き、対象口座を選択。期間で「期間指定」を選び、開始日＝`fetchSince`・終了日＝今日（open 期間内）にして再照会。**1ページの表示件数は最大（例 100件）**にし、件数が上限に達していたら**ページ送り/期間分割で全件取得**する（取りこぼし防止）。
   - **⚠️ 期間クランプを必ず検証**: 三菱UFJダイレクトはオンライン照会可能期間に上限があり、開始日を古くしても**黙って数か月にクランプ**され得る。再照会後に画面の「**表示期間**」を読み、**返ってきた開始日 ≤ 要求開始日（`fetchSince`）** を確認する。足りなければ**取りこぼし分（未照会期間）を人へ明示**（「この期間はオンライン未照会＝後日CSV/通帳/Eco通帳推移表で補完」）し、取れた範囲だけ投入する。
3. **`browser_evaluate` でDOMの明細テーブルを構造化抽出**（古い順 `fetchSince`→今日。`acquisition` の watermark 規約。新しい行だけ先に取ると間が watermark の後ろに隠れる）。1行＝1取引で:
   - `txnDate`: 日付（年は見出し行「YYYY年」から引き継ぎ、ISO `YYYY-MM-DD`）。
   - `description`: 取引内容（摘要。`クレジット` / 振込依頼人名 / `税金 シヨウヒゼイ` 等。全角はサーバが半角化）。
   - `amount` / `direction`: お支払い>0→`out`、お預かり>0→`in`（円整数・非負。方向は別持ち）。両方空・見出し/合計行はスキップ。
   - `balance`: 残高（円整数）。**必ず取る**（検算と残高同期の要）。
4. **差引残高チェーンの自己検算（必須・金額正確性の担保）**: DOM抽出ゆえこれが金額正確性の生命線。**`browser_evaluate` 内で**取得行を古い順に並べ、各行で
   `balance(n) == balance(n-1) + (in ? +amount : −amount)` を検証する。
   - 連続すれば抽出は信頼できる → 投入へ。
   - **崩れたら投入せず中断して人へ報告**（誤った金額を作らない＝安全側）。どの行で崩れたか・期待値と実値を示す。
   - 先頭行は前残高が無いので連続性チェックの起点（単独では検証不可。可能なら1行前も読んで起点を確定）。

## 分類（§5・摘要→科目。普通預金でない側＝相手科目だけ決める）

各行の `description` で確定履歴を引き、無ければ `docs/classification-policy.md` §5 で分類する:

```bash
"${CURL[@]}" "${book[@]}" -H 'Content-Type: application/json' \
  -d '{"source":"bank_ufj","items":["クレジット","トウキヨウデンリヨク","税金 シヨウヒゼイ"]}' \
  "$BASE/skill/classification-history/lookup"
```
- 返る `candidates`（`pattern`→`proposedAccount`/`treatment`）を**最優先**で当てる（意味で一致するもの）。
- 履歴に無ければ **§5 ポリシー**で分類。各行に付与する `treatment`（銀行の語彙）と相手科目:

| 摘要パターン | proposedAccount | treatment | 貸借（本体が構築） |
|---|---|---|---|
| 預金利息（`税引前利息` 等・入金） | （不要） | `owner_contribution` | 借)普通預金 / 貸)事業主借（§5.1・損益外） |
| 利息の源泉（`国税`/`地方税`・出金。**同日利息とペア**） | （不要） | `owner_draw` | 借)事業主貸 / 貸)普通預金（§5.1・⚠️消費税でない） |
| 消費税納付（`税金 シヨウヒゼイ`・出金） | `租税公課` | `expense` | 借)租税公課 / 貸)普通預金（§5.1） |
| 報酬の振込入金（取引先＝振込依頼人名） | `売掛金`（または `売上`） | `revenue` | 借)普通預金 / 貸)売掛金（売上回収） |
| 電気/ガス/水道の引落 | `水道光熱費` | `expense` | 借)水道光熱費 / 貸)普通預金（家事按分要は reason で明示） |
| 通信（携帯/回線/サーバ/ドメイン）の引落 | `通信費` | `expense` | 借)通信費 / 貸)普通預金 |
| カード利用代金の引落（`クレジット` 等） | `未払金` | `settlement` | 借)未払金 / 貸)普通預金（費用は最上流で計上済＝二重計上しない）。カードチャネルが特定できれば `counterSubAccountRef`（例 `card_mufg_visa-1`）を付す。**カード未連携だと費用が宙に浮く**点に留意 |
| 国民年金保険料（`コクミンネンキン`/`年金`・出金） | （不要） | `owner_draw` | 借)事業主貸 / 貸)普通預金（社会保険料控除＝経費でない・§5.2） |
| 国民健康保険料（`コクミンホケンリヨウ`・出金） | （不要） | `owner_draw` | 借)事業主貸 / 貸)普通預金（同上） |
| 所得税の還付（`…ゼイムシヨ`＝税務署・入金） | （不要） | `owner_contribution` | 借)普通預金 / 貸)事業主借（個人の税還付＝損益外・§5.2） |
| 国民健康保険の還付（`コクホ…`・入金） | （不要） | `owner_contribution` | 借)普通預金 / 貸)事業主借（高額療養費等の還付・損益外） |
| ATM出金（`支払機`・出金） | （不要） | `owner_draw` | 借)事業主貸 / 貸)普通預金（用途不明は私用前提。現金管理するなら要修正・`confidence=low`） |
| 固定資産税（`…コテイシサンゼイ…`・出金） | `租税公課`（事業分） | `expense`／自宅は `unresolved` | 事業利用は租税公課、自宅は家事按分。割合不明は `unresolved`＋`reason` |
| 本当に判別不能 | （不要） | `unresolved` | 借)未確定勘定 / 貸)普通預金（要確認） |

- 各行に: `proposedAccount`（settlement/expense/revenue で使う科目名）/ `treatment` / `reason`（1行）/ `confidence` / `policyRef`（現行 `ec-classify@v3`）。
- **§5.1（利息/源泉/消費税）は決定的**＝`unresolved` に逃がさず正解を確信提案。`unresolved` は「**本当に情報不足で決まらない**」時だけ。
- 高額・私用疑い・判別不能は安全側（`unresolved` または `事業主貸`）＋ `reason`。**勝手に経費にしない**。

## 投入

payload（**camelCase**）は `{ "accountRef":"bank_ufj-1", "fileName":"bank_ufj_YYYY-MM.json", "transactions":[ {txnDate, amount, direction, description, balance, proposedAccount?, treatment, reason, confidence, policyRef, counterSubAccountRef?} ] }`。

**投入ボディの作り方（堅い手順・ハマり所を回避）**:
- `browser_evaluate` は **`JSON.stringify(payload)`（文字列）を返す**。これを受け取り、**素のオブジェクトとして** `/tmp/bank-payload.json` に書く（`filename` 保存は二重JSON化するので使わない。二重化された場合は1段 `JSON.parse` で解く）。
- 投入は**1回だけ**。`bankAccounts[].accountRef`（例 `bank_ufj-1`）宛に POST:
  ```bash
  # ❌ してはいけない: 整形パイプ＋|| フォールバックは、整形失敗時にPOSTを二重送信する
  #    curl ... -d @body.json URL | python3 -m json.tool || curl ... -d @body.json URL
  # ✅ 変更系POSTは生で受け、HTTPコードは別途・本文と分けて取る（再送しない）
  http=$("${CURL[@]}" -o /tmp/bank-resp.json -w '%{http_code}' "${book[@]}" \
    -H 'Content-Type: application/json' -d @/tmp/bank-payload.json \
    "$BASE/skill/bank/journal-candidates")
  echo "HTTP $http"; cat /tmp/bank-resp.json   # 整形が要るなら保存後の本文だけ整形する
  ```
- `amount` は**非負円整数**（方向は `direction`）。`balance` は差引残高（残高同期・突合）。
- 本体が **普通預金一脚で貸借を機械構築**（direction で借方/貸方）、科目検証（未知→未確定勘定＋flag）、会計期間ゲート、出現インデックス dedup を権威適用。**全件 draft**（人が承認）。再送は dedup で安全（`skippedDup` になるだけ）。

## 抽出の注意（三菱UFJ特有）

- **半角カナ**（`ｼﾖｳﾋｾﾞｲ` 等）で出ることがある。摘要は原文を尊重しつつ、分類は意味で行う（本体は照合時のみ NFKC 正規化）。
- `クレジット`＝カード引落（費用でなく**未払金の決済**＝`settlement`。費用は EC/カード明細の最上流で計上済み・二重計上しない）。
- 翌期（open 期間外）の `txnDate` は**取得しない**（繰越後に取り込まれる）。
- 振込入金は売上回収（`revenue`→`売掛金`）か個人入金（`事業主借`）かを摘要で判断。判別不能は `unresolved`。
- **UI手動CSV取込との共存**: 同一口座を「スキル」と「UI手動CSV」の両方で取り込まない（dedup 互換なので重複は自動スキップされるが、混乱を避け片方に寄せる）。スキル取得が不安定な期間は UI手動CSV がフォールバック。

## 出力・報告

応答（camelCase）の各件数を人にそのまま報告（**黙って落とさない**）:
- `acceptedRows` / `draftEntries`（承認待ち）
- `skippedDup`（既取込）/ `excludedCount`＋`excludedOutOfPeriod`（翌期＝繰越後に取込）/ `unresolved`（要確認）/ `warnings`

最後に案内: 「Kanean の **連携サービス/取込** タブで draft を確認・承認してください。**残高突合レポート（`GET /reports/reconciliation`）で残高チェーンの連続も確認**してください。確定した分類は次回以降の提案に学習されます。」

## 規約

本人が自分の口座明細を個人利用の範囲で取得する前提。商用再配布・第三者の代行取得はしない。生証跡・保存セッションはローカルの秘密（gitignore・非同期）。
