---
name: acquisition-ufjvisa
description: 三菱UFJ-VISA（三菱UFJニコス NEWS+PLUS www2.cr.mufg.jp/newsplus/）のカード利用明細をヘッドフルブラウザで巡回し、利用（利用日・店名・金額）を正規化＋AI科目分類して取得する。acquisition オーケストレータから呼ばれるサイト個別スキル。
---

# acquisition-ufjvisa — 三菱UFJ-VISA カード利用明細の取得・正規化・分類

`acquisition` オーケストレータのサイト個別スキル。三菱UFJニコス NEWS+PLUS のカード利用明細を巡回し、
正規化取引＋AI仕訳候補を返す（ログイン・2FAは人、抽出・分類はAI）。`source` は **`card_mufg_visa`**。
安全原則・期間ゲート・証跡保存・watermark 規約は `acquisition` SKILL.md に従う。

## カードは「銀行トラックのAPI」を使う（未払金が一脚）

投入先は **`POST /skill/bank/journal-candidates`**（EC の `/skill/ec/journal-candidates` ではない）。importer の一脚は `accountRef` の補助科目で汎用化されており、**カードは普通預金でなく「未払金（カードチャネル）」が一脚**に立つ。`direction='out'`（利用）で本体が貸借を機械構築する:
- 直接利用: `借) 費用科目 / 貸) 未払金(三菱UFJ-VISA)`（`treatment=expense`、相手科目＝AI分類）。
- 私用: `借) 事業主貸 / 貸) 未払金(三菱UFJ-VISA)`（`treatment=owner_draw`）。

**冪等は出現インデックス方式**（`取引日+金額+方向+摘要+出現連番`）＝UI手動CSVカード取込（`docs/csv-format.md` §2）と byte 互換。**同一カードを両トラックで二重計上しない**。

### ★ EC（Amazon/楽天）の二重計上回避＝付替え（最重要）

Amazon/楽天をこのカードで決済している場合、**EC連携で費用は最上流（`借)費用/貸)未払金(EC)`）に計上済み**。カード明細の同じ行を費用計上すると**二重計上**になる。連携済みECの利用行は**付替え**にする（`docs/csv-format.md` §4.3）:
- `treatment=settlement` / `proposedAccount=未払金` / `counterSubAccountRef=<該当ECの accountRef>` → 本体が **`借) 未払金(EC) / 貸) 未払金(card)`** を生成（費用を再計上しない）。`未払金(EC)` は EC側の貸方と相殺され 0 に向かう。
- 該当ECの `accountRef` は **手順1の `services[]`** から引く（店名 `ＡＭＡＺＯＮ.ＣＯ.ＪＰ` → `amazon-1`、`楽天市場`/`RAKUTEN…ICHIBA` → `rakuten-1` 等、意味で対応づけ）。**連携していないECは付替えできない**＝通常の費用として分類（`docs/csv-format.md` §4.3「連携なし」）。
- **⚠️ 付替え対象は「物販EC」決済のみ**。同じ `ラクテン`/`楽天`/`Amazon` でも **通信・サブスク・コンテンツは物販ではない＝付替えしない**（費用計上）。例: `ラクテンブロ－ドバンド`・`ラクテンモバイル…`＝**通信費**、`Amazon Prime Video`/`Kindle`＝内容に従う。付替えるのは楽天市場・Amazon物販の利用だけ。
- **⚠️ 付替えは「対応するEC注文がEC取込済み」のときだけ正しい**。未取込（EC巡回範囲外の注文・別期間の注文等）だと `借)未払金(EC)` の相手（`貸)未払金(EC)` ＝EC側の費用計上）が無く、**未払金(EC)が宙に浮き費用が欠落**する。よって付替え行は **`confidence=low`＋必ず要承認**（settlement は本体が `unresolved` に乗せる）にし、`reason` に「**EC未取込ならこの行を経費に変更**」を明記する。運用は**EC（Amazon/楽天）を先に取り込んでから**カードを取り込むのが安全。厳密な金額×日付の突合（付替え連鎖）は将来機能。
- **未確定分（最新の請求月）は金額変動の可能性＝取り込まない**（確定分のみ。確定後の再取込で入る）。

## 固定スクリプト（優先経路）

まず `node .claude/skills/acquisition/scripts/scrape.mjs ufjvisa --since … --until … --out /tmp/acq-card.json [--evidence]` で取得する（確定請求月を `--since` に届くまで自動でさかのぼり、月ごとに **Σ利用＝新規ご利用額** を検算。未確定月は対象外。検算NGなら投入させず exit 1）。exit 0 なら以下の MCP 巡回は行わず、出力 JSON の `transactions` を分類（付替え判断含む）へ。失敗時のフォールバック・修復手順は `acquisition` SKILL.md 手順2b（較正ポイントは `packages/acquisition/src/sites/ufjvisa.mjs` の `DEFAULT_SEL`）。**以下は MCP フォールバック時・修復時の参照**。

## ブラウザ基盤

本リポジトリ設定済みの **`playwright` MCP**（`.mcp.json`）を使う。ヘッドフル・永続プロファイル `./.kanean/pw-profile`（ログイン継続）。
ナビゲーション・ログイン確認は a11y snapshot でよいが、**利用明細は「表」なので `browser_evaluate` でDOMの `<table>` を直接構造化抽出する**（桁・行ズレに強い）。
証跡の保存先は `./.kanean/evidence/ufjvisa/`（ローカル秘密＝gitignore 済 `/.kanean/` 配下）。**`browser_evaluate` の `filename` 保存は戻り値を二重JSON化する**ので、投入ボディは `filename` に頼らず、戻り値（JSON文字列）を受け取って後段で**素のオブジェクトとして** `/tmp` に書く（投入の節）。

## カードと銀行の違い（抽出時の注意）

- **残高列が無い** → 銀行の「残高チェーン自己検算」は使えない。代わりに **Σ明細利用金額 ＝ ご利用区分テーブルの当月「新規ご利用額」** で検算する。**請求額（当月お支払合計額）は“支払額”で、分割/リボ/前月残があると新規ご利用額と一致しない**（1回払いのみ・前月残なしのときだけ Σ利用＝新規ご利用額＝請求額）。会計は**発生主義＝利用日に全額 `借)費用/貸)未払金`** を計上する（支払額でなく利用額で起票）。合わなければ取りこぼし/重複/未確定混入を疑い人へ報告。
- **取引日＝ご利用日**（発生主義）。お支払日は未払金の決済予定（参考。`balance` には入れない）。
- **確定/未確定**: 金額変動の可能性がある**未確定（暫定）明細は取り込まない**（確定のみ）。未確定があれば件数を人へ報告（確定後に再取込で入る）。
- **海外利用**: 取引本体＋「内海外利用事務手数料」「内消費税」等の**注記が直前取引に付随**。MVPは利用金額（合計）で1取引として扱い、注記は `description` に連結 or 無視（手数料を別計上するかは運用方針）。
- **返金/キャンセル**（マイナス額・入金）は `direction='in'`。連携ECの返金は settlement の戻し、それ以外は `雑収入`/`事業主借`/`unresolved` を内容で判断。

## ブラウザ巡回の手順

1. `https://www2.cr.mufg.jp/newsplus/` を**ヘッドフル**で開き、三菱UFJニコス NEWS+PLUS にログイン。**ログイン/2FA（ワンタイムパスワード等）/暗証番号は人**が見えている窓に直接入力（AIは認証情報に触れない）。保存プロファイルが有効ならそのまま続行。
2. NEWS+PLUS ログイン後、「**ご請求額・利用明細照会**」（会員サイト My Digital Connect へシームレス遷移＝別タブ）を開く。「請求額一覧」に**確定分／未確定分／過去（請求月プルダウン）**が並ぶ。各請求月の明細は `…/meisaisyokai/detail.html?tag=…&selectdt=YYYYMM`（`selectdt`＝**請求年月**。`selectdt` 直URLでの遷移可）。

   **⚠️ 取得範囲の取り方（最重要・取りこぼし防止）**: カードの画面は「**請求月（＝お支払日）単位**」だが、**会計の期間ゲートは「利用日」**。したがって **最新の請求月1枚では足りない**（その明細の最古利用日は `fetchSince` ではない）。**確定請求月を新しい→古いへさかのぼり、各明細の最古利用日が `fetchSince` 以下に達するまで全部開く**。
   - 例: 初回 `fetchSince=2026-01-01`・最新確定が6月請求(利用 4/1〜5/15)なら、**5月請求(利用 〜4/15)・4月・3月・2月請求… と利用日が 1/1 に届くまでさかのぼる**。6月だけで止めると 1〜3月が watermark の裏に隠れて消える（＝今回避けたい事故）。
   - **未確定分（最新請求月）は取り込まない**（金額変動）。**確定分のみ**。
   - **取り込みは利用日の古い順**。請求月をさかのぼって集め終えたら、利用日の昇順で投入する。
   - **請求月の利用日レンジは厳密には連続せず、遅延計上（ETC等）で前後にはみ出る**ことがある＝日付でなく**請求月を漏れなくさかのぼる**のが確実。期間外（前年利用）は本体の**期間ゲート**が除外、請求月間の重複は本体の**出現index dedup** が吸収するので、**範囲は広めに取り本体の権威に委ねてよい**（少なく取って取りこぼす方が危険）。
   - 各請求月の「**新規ご利用額**」を控える（手順4の検算用）。想定外ページ・抽出失敗は中断して人へ。
3. **`browser_evaluate` でDOMの利用明細テーブルを構造化抽出**。1行＝1取引で:
   - `txnDate`: **ご利用日**（`YYYY/MM/DD` or `YYYY年M月D日`→ISO `YYYY-MM-DD`）。
   - `description`: ご利用店名（全角は本体が半角正規化。海外注記があれば連結）。
   - `amount` / `direction`: ご利用金額（円整数・非負）。利用は `out`、返金/マイナスは `in`。
   - 確定/未確定・支払回数は補足（未確定は取り込まない＝手順「カードと銀行の違い」）。**`balance` は付けない**（カードに残高なし）。
4. **金額の整合検算（残高チェーンの代替・必須）**: 抽出した**その請求月の Σ明細利用金額（返金は減算）＝ ご利用区分テーブルの当月「新規ご利用額」**を確認する（請求額＝支払額とは別物。分割/リボ/前月残があると請求額とはズレる）。
   - 一致すれば抽出は信頼できる → 分類・投入へ。
   - **ズレたら投入せず中断して人へ報告**（取りこぼし/重複/未確定混入を疑う。どの月がいくらズレたか提示）。
   - **海外利用の事務手数料・内消費税は本体の利用金額に「内」包**＝**注記行（日付なしの末列のみの行）はskip・別計上しない**（二重計上回避）。**明細書発行手数料・年会費・分割手数料**は独立した利用行として取る（`支払手数料`）。

## 分類（§5・店名→科目。未払金(card)でない側＝相手科目だけ決める）

各行の店名で確定履歴を引き、無ければ `docs/classification-policy.md`（§3 品目／§5 金融）で分類する:

```bash
"${CURL[@]}" "${book[@]}" -H 'Content-Type: application/json' \
  -d '{"source":"card_mufg_visa","items":["ＡＭＡＺＯＮ.ＣＯ.ＪＰ","CLAUDE.AI SUBSCRIPTION","ＥＴＣ 京浜川崎"]}' \
  "$BASE/skill/classification-history/lookup"
```
- 返る `candidates` を**最優先**で当てる（意味で一致するもの）。無ければ下表＋ポリシーで分類:

| 店名/種別 | proposedAccount | treatment | 貸借（本体が構築） |
|---|---|---|---|
| **連携EC（Amazon/楽天 等が `services[]` にある）** | `未払金` | `settlement`＋`counterSubAccountRef=<ec accountRef>` | 借)未払金(EC) / 貸)未払金(card)（**付替え・二重計上回避**。費用は最上流で計上済） |
| SaaS/サブスク（開発・サーバ・ドメイン・AI 等の事業利用） | `通信費` 等内容に従う | `expense` | 借)通信費 等 / 貸)未払金(card)（私用サブスクは `事業主貸`） |
| ETC・交通・出張 | `旅費交通費` | `expense` | 借)旅費交通費 / 貸)未払金(card)（私用移動は `事業主貸`） |
| PC周辺機器・消耗品（事業利用） | `消耗品費` | `expense` | 借)消耗品費 / 貸)未払金(card) |
| 技術書・専門書 | `新聞図書費` | `expense` | 借)新聞図書費 / 貸)未払金(card) |
| 飲食（会議・打合せ） | `会議費`／`接待交際費` | `expense` | 内容で判断。私的飲食は `事業主貸` |
| カード年会費・明細発行手数料・分割/リボ手数料 | `支払手数料` | `expense` | 借)支払手数料 / 貸)未払金(card)（適格登録番号 `T…` はカード会社＝取引先） |
| 明らかに私用（食品・日用品・娯楽・衣類等） | （不要） | `owner_draw` | 借)事業主貸 / 貸)未払金(card) |
| 返金/キャンセル（入金） | 内容に従う | settlement 戻し／`revenue`／`unresolved` | direction=in。連携ECの返金は付替えの戻し |
| 本当に判別不能 | （不要） | `unresolved` | 借)未確定勘定 / 貸)未払金(card)（要確認） |

- 各行に: `proposedAccount`（settlement/expense で使う科目名）/ `treatment` / `counterSubAccountRef`（付替え時）/ `reason`（1行）/ `confidence` / `policyRef`（現行 `ec-classify@v3`）。
- **高額（取得価額10万円以上）は経費に落とさない**＝`unresolved`＋`reason`（固定資産候補）。私用疑い・判別不能は安全側（`unresolved`/`事業主貸`）＋`reason`。**勝手に経費にしない**。

## 投入

payload（**camelCase**）は `{ "accountRef":"card_mufg_visa-1", "fileName":"card_mufg_visa_YYYY-MM.json", "transactions":[ {txnDate, amount, direction, description, proposedAccount?, treatment, counterSubAccountRef?, reason, confidence, policyRef} ] }`（**`balance` は付けない**）。

**投入ボディの作り方（堅い手順・ハマり所を回避）**:
- `browser_evaluate` は **`JSON.stringify(payload)`（文字列）を返す**。これを受け取り、**素のオブジェクトとして** `/tmp/card-payload.json` に書く（`filename` 保存は二重JSON化するので使わない）。
- 投入は**1回だけ**。`cards[].accountRef`（例 `card_mufg_visa-1`）宛に POST:
  ```bash
  http=$("${CURL[@]}" -o /tmp/card-resp.json -w '%{http_code}' "${book[@]}" \
    -H 'Content-Type: application/json' -d @/tmp/card-payload.json \
    "$BASE/skill/bank/journal-candidates")
  echo "HTTP $http"; cat /tmp/card-resp.json
  ```
- `amount` は**非負円整数**（方向は `direction`）。本体が **未払金一脚で貸借を機械構築**（direction で借方/貸方）、`settlement`＋`counterSubAccountRef`（親勘定＝未払金一致時のみ採用）で付替え、科目検証（未知→未確定勘定＋flag）、会計期間ゲート、出現インデックス dedup を権威適用。**全件 draft**（人が承認）。再送は dedup で安全。

## 出力・報告

応答（camelCase）の各件数を人にそのまま報告（**黙って落とさない**）:
- `acceptedRows` / `draftEntries`（承認待ち）
- `skippedDup`（既取込）/ `excludedCount`＋`excludedOutOfPeriod`（翌期＝繰越後に取込）/ `unresolved`（要確認・付替え補助の確認含む）/ `warnings`
- 加えて**請求月ごとの Σ利用金額と請求額の一致**（手順4の検算結果）と、**付替えにした連携EC行の件数・対象EC**を人へ報告。

最後に案内: 「Kanean の **連携サービス/取込** タブで draft を確認・承認してください。**Amazon/楽天の付替え行（借)未払金(EC)/貸)未払金(card)）で未払金(EC)が相殺されているか**、確定申告前に確認してください。確定した分類は次回以降の提案に学習されます。」

## 規約

本人が自分のカード明細を個人利用の範囲で取得する前提。商用再配布・第三者の代行取得はしない。生証跡・保存セッションはローカルの秘密（gitignore・非同期）。
