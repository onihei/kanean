---
name: acquisition
description: 連携サービス（Amazon/楽天などのEC、三菱UFJ銀行・SBI新生銀行などの銀行口座、三菱UFJ-VISA などのカード）の明細を取り込み、AIが勘定科目を分類して Kanean に draft 投入する。「取り込み」「取込して」「連携サービスの取込」「Amazonの取込」「三菱UFJ銀行の取込」「新生銀行の取込」「UFJ-VISAの取込」「カード明細の取込」「銀行明細の取込」等で起動。
---

# acquisition — 連携サービス取込オーケストレータ

Kanean（個人事業主向け会計システム）の連携サービス取込スキル。ブラウザで明細を巡回・抽出し、
**AIが勘定科目を分類**して、本体の import API へ **draft 仕訳** として投入する。
本スキルは「取得・正規化・分類・投入」のクライアントで、本体（server）が会計期間ゲート・冪等・科目検証の権威を持つ。

> **アプリ内取込との関係**: 通常の取込は Kanean デスクトップアプリの「連携サービス」画面から行い、
> 分類は Claude Desktop（MCP）が担う。巡回手順は `packages/acquisition` にあり**両経路で同じ実体**を動かす。
> このスキルが要るのは、**開発時の較正**と、**較正データでは直らない深い修復**（巡回手順そのものの変更）。

**3つのトラック（取込元で分岐）**:
- **EC**（Amazon/楽天）→ サイトスキル（`acquisition-amazon`/`acquisition-rakuten`）→ `POST /skill/ec/journal-candidates`。**品名→科目**を分類、貸方=未払金チャネル（クリアリング連鎖）。
- **銀行**（三菱UFJ銀行／SBI新生銀行）→ `acquisition-mufg`／`acquisition-shinsei` → `POST /skill/bank/journal-candidates`。**摘要→科目**を分類（`docs/classification-policy.md` §5）、**普通預金が一脚**で direction が貸借を決める。`docs/bank-import-api.md` が契約。
- **カード**（三菱UFJ-VISA）→ `acquisition-ufjvisa` → **`POST /skill/bank/journal-candidates`（銀行と同じAPI）**。importer の一脚は accountRef の補助科目で汎用なので**未払金(カード)が一脚**。`借)費用/貸)未払金(card)`、連携EC利用は **付替え**（`treatment=settlement`＋`counterSubAccountRef`＝`借)未払金(EC)/貸)未払金(card)`・二重計上回避）。

設計の正は repo の docs（**必ず参照**）:
- 役割分担・2トラック・学習ループ・注入ポリシー … `docs/acquisition-skill-spec.md` §7
- API 契約（3本）… `docs/ec-import-api.md`
- 正規化フォーマット・クリアリング連鎖 … `docs/csv-format.md` §4
- **分類ポリシー（カスタマイズはここを編集）… `docs/classification-policy.md`**

## 絶対原則（安全側）

- **認証情報をAI/スキルに渡さない**。EC のログイン・2FA・CAPTCHA は**人が見えるブラウザに直接入力**する。
- **無人全自動にしない**。人が前面セッションで起動し、ブラウザを監視・介入できる状態で行う。
- **金額・品名はページ抽出を鵜呑みにしない**（抽出は常にページの snapshot から行う）。**証憑（スクショ/HTML）の保存は事業者設定 `evidenceCapture` に従う**（手順1で取得・手順2で分岐。ON=保存して `evidenceRef` にパス／OFF=保存せず `evidenceRef` に注文URL等の参照を入れる）。
- 取込結果は**すべて draft**。最終確定は人が UI（連携サービス タブ）で承認する。**勝手に確定しない**。
- 想定外ページ・抽出失敗・確信が持てない時は**中断して人へ報告**（誤った数値を作らない）。

## 前提（実行前に確認）

1. **本体が起動**していること。**取込に認証は不要**（同一マシンから到達できること自体が認可）。
   トークン発行・`login.mjs` は廃止された。接続経路は2つあり、下の定型で自動的に選ばれる:
   - **デスクトップアプリ**（通常）: `$DATA_DIR/kanean.sock`（unix domain socket）。既定は
     `~/Library/Application Support/Kanean/data/kanean.sock`。`KANEAN_SOCKET` で明示できる。
     **ソケットはアプリ起動中だけ存在する**ので、無ければ「起動していない」と判断してよい。
   - **開発時**（`pnpm --filter @kanean/server dev`）: `http://127.0.0.1:10140`。`KANEAN_BASE_URL` で上書き可。
     `localhost` ではなく **`127.0.0.1`** を使う（環境により `localhost` が `::1` に解決され、届かないため）。
   - どちらにも繋がらない場合は「Kanean を起動してください」と人へ報告して中断（勝手に別ポートを探さない）。
   - **アプリのウィンドウを閉じるとソケットは消える**。長い取込の最中に閉じられると接続が切れるので、
     途中で繋がらなくなったら黙って再試行せず、人へ報告する。
2. ブラウザ自動化が使えること。**優先経路は固定スクリプト**（`playwright-core`＝root devDependency・Chrome チャンネル起動・MCP と同じ永続プロファイル共有。`pnpm install` 済みなら動く）。フォールバック用に **`playwright` MCP サーバを `.mcp.json` で設定済み**（ヘッドフル＝人が2FA入力可・永続プロファイル `./.kanean/pw-profile` でログイン継続・証跡は `--output-dir=./.kanean/evidence/amazon`）。
   - 初回は Claude Code 再起動で `playwright` MCP を有効化し、**人がブラウザでログイン**（以降はプロファイル復元でログイン維持）。MCP ツールが見えない時は人に「Claude Code を再起動し `playwright` MCP を許可」を依頼。

```bash
# 接続先を決める。デスクトップアプリ（ローカルソケット）を優先し、無ければ開発時の TCP を使う。
# 以降の呼び出しは必ず `"${CURL[@]}"` を使う（素の `curl` はソケット経路で届かない）。
# パス規約の正は packages/shared/src/{appLink,nodePaths}.ts（SOCKET_FILENAME / defaultDataDir・issue #167）
SOCK="${KANEAN_SOCKET:-$HOME/Library/Application Support/Kanean/data/kanean.sock}"
if [ -S "$SOCK" ]; then
  CURL=(curl -s --unix-socket "$SOCK"); BASE="http://localhost"  # socket 経由はホスト名を解決しないので localhost で可
else
  CURL=(curl -s); BASE="${KANEAN_BASE_URL:-http://127.0.0.1:10140}"
fi
# 疎通確認。ここで落ちたら「Kanean を起動してください」と報告して中断する（推測で先へ進まない）。
"${CURL[@]}" -f -m 5 "$BASE/health" >/dev/null || { echo "Kanean が起動していません"; exit 1; }

# 取込API は認証なし。Authorization ヘッダは不要。
# 帳簿（books）が複数ある場合だけ対象を指定する。1冊なら空のままでよい。
book=()   # 例: book=(-H "X-Book-Id: 01J...")
```

### 帳簿が複数ある場合（400 book_required）

本体は1インスタンスで**複数の帳簿**を持てる（自分の事業／顧問先ごと 等）。
1冊しか無ければ指定不要だが、2冊以上あると API は **400 `book_required`** を返し、
応答に選択肢が入る:

```json
{ "error": { "code": "book_required", "message": "..." },
  "books": [ { "id": "01J...", "name": "自分の事業" }, { "id": "01K...", "name": "顧問先A" } ] }
```

このときは**推測せず人に確認する**（どの帳簿に取り込むかは会計上の判断）。
選ばれた id で `book=(-H "X-Book-Id: <id>")` を設定し、同じ呼び出しを1回だけ再試行する。

## 手順

### 1. 巡回対象を取得（本体DBが正）

```bash
"${CURL[@]}" "${book[@]}" "$BASE/skill/linked-services"
```
- `openFiscalYear`（取得対象は `[startDate, endDate]` の取引日＝EC は **orderDate** / 銀行は **txnDate** のみ。翌期は取らない）。
- `services[]`（**EC**）：`source`(amazon/rakuten 等=巡回対象・履歴キー) / `accountRef`(投入先) / `fetchSince`(差分起点) / `payableSubAccount`。
- `bankAccounts[]`（**銀行**）：`source`(bank_ufj 等) / `accountRef`(投入先＝普通預金の口座補助) / `fetchSince`(差分起点) / `depositSubAccount`。
- `cards[]`（**カード**）：`source`(card_mufg_visa 等) / `accountRef`(投入先＝未払金カードチャネル) / `fetchSince`(差分起点) / `payableSubAccount`。投入先は**銀行と同じ** `POST /skill/bank/journal-candidates`（未払金が一脚）。
- `evidenceCapture`(boolean)：**証憑保存の要否**（事業者設定・電帳法）。手順2の証跡保存はこの値で分岐する。
- **前提チェック（満たさなければ手順2へ進まず＝ブラウザを開かずにここで中断・理由を提示）**:
  - `openFiscalYear` が `null` → 「**会計年度が未作成です**。Kanean で会計年度を作成してください（設定→会計年度）」と報告して中断。
  - `services`・`bankAccounts`・`cards` がすべて空 → 「**連携サービス/口座が未登録です**。Kanean の『連携サービス』タブで Amazon や三菱UFJ銀行・三菱UFJ-VISA 等を登録してください」と報告して中断。
- 上記を満たせば、対象（EC サービス / 銀行口座）を人に確認（全件 or 個別）して手順2へ。

### 2. サイトごとに取得 — ハイブリッド（固定スクリプト優先 → MCPフォールバック＋自動修復）

各 `services[]`（EC）/ `bankAccounts[]`（銀行）/ `cards[]`（カード）について、**まず固定スクリプト**で取得する
（速い・トークンを消費しない）。**サイト変更等で失敗した時だけ** MCP 巡回にフォールバックし、**その後スクリプトを修復**する。

#### 2a. 固定スクリプト（優先経路）

**巡回手順の実体は `packages/acquisition/src/sites/*.mjs` にある**（アプリ内取込と共有する唯一の実体）。
`scripts/scrape.mjs` は CLI（`packages/acquisition/bin/scrape.mjs`）へサイト名ごと素通しする薄いラッパで、
終了コードは従来どおり（旧 `scrape-<site>.mjs` ×5 は issue #169 で一本化）。

| source | `<site>` 引数 | 巡回手順の実体 |
|---|---|---|
| `amazon` | `amazon` | `packages/acquisition/src/sites/amazon.mjs` |
| `rakuten` | `rakuten` | `packages/acquisition/src/sites/rakuten.mjs` |
| `bank_ufj` | `mufg` | `packages/acquisition/src/sites/mufg.mjs` |
| `bank_shinsei` | `shinsei` | `packages/acquisition/src/sites/shinsei.mjs` |
| `card_mufg_visa` | `ufjvisa` | `packages/acquisition/src/sites/ufjvisa.mjs` |

```bash
# --since = max(fetchSince, openFiscalYear.startDate) / --until = min(今日, openFiscalYear.endDate)
node .claude/skills/acquisition/scripts/scrape.mjs <site> \
  --since YYYY-MM-DD --until YYYY-MM-DD --out /tmp/acq-<source>.json
# 手順1の evidenceCapture=true なら --evidence を付ける
```

- **実行前に**: playwright MCP のブラウザが開いていたら **`browser_close` で閉じる**（永続プロファイル
  `./.kanean/pw-profile` を共有しており同時に開けない）。
- **Bash タイムアウトは10分**（timeout=600000）。ログイン/2FA が必要ならスクリプトがヘッドフル窓を開いて
  **人を待つ**ので、人に「開いた窓でログインしてください」と伝える（AIはパスワードに触れない＝従来どおり）。
- スクリプトは**取得・正規化・自己検算だけ**を行い、分類・POSTはしない（読むだけ＝何度実行しても安全）。
  検算規約は従来と同一（銀行=残高チェーン / カード=Σ利用＝新規ご利用額 / EC=Σline+shipping−points==total）。
- **終了コードで分岐**:
  - `0` … 成功。`--out` の JSON を読んで**手順3（分類）へ直行**。MCPブラウザは開かない（トークン節約）。
  - `4` … 部分成功（ECのみ）。`orders` はそのまま使い、`failedOrders` の注文だけ MCP で補完取得する。
  - `2` … プロファイル使用中。`browser_close` してから再実行。
  - `1` … 失敗。`.kanean/acquisition/fail/<source>/latest/error.json` を読み、**2b フォールバック＋修復**へ。

#### 2b. MCPフォールバック＋スクリプト自動修復（失敗時のみ・必ずこの順）

1. `error.json`（step / message / url / hint）を読む。`page.html` は大きいので **Read せず grep** で当たりをつける。
2. **今回の取込は MCP 巡回で完遂する**（2c のサイトスキル手順）。このとき、壊れた step に対応する
   **実ページの構造（リンク名・テーブルヘッダ・セレクタ）を観察して控える**。
3. 取込完了後、観察した構造に合わせて直す。**直す先は2通りあり、まず前者を試す**。
   - **較正データ**（多くはこちら）: `packages/acquisition/src/sites/<site>.mjs` の `DEFAULT_SEL` に
     あるキーの値だけが変わったのなら、**コードを触らず** `$DATA_DIR/acquisition/selectors/<source>.json`
     に上書きを置いて直せる（アプリの更新も再ビルドも要らない・消せば同梱較正へ戻る）。
     受け付けるのはデータのみ（文字列・数値・文字列配列。同梱に無いキーは追加できない）。
   - **巡回手順そのもの**: 導線や待ち方が変わったなら `packages/acquisition/src/sites/<site>.mjs` を直し、
     `SCRIPT` の版 `@vN` を上げる。**このとき使ってよい API は `src/core/page.mjs` の `BROWSER_API` だけ**
     （Electron 殻でも同じ手順を動かすため。契約外を使うと `contract.test.mjs` が落ちる）。
4. 修正したスクリプトを**再実行して検証**（読むだけ＝安全）。出力 JSON の件数・金額合計が MCP 取得分と
   一致すれば修復完了。
5. 人への報告に「**スクリプトを修正した**（どの step を何に直したか1行）」を含める。修復できなければその旨と
   `error.json` の場所を報告（次回も MCP で動く＝機能は止まらない）。

#### 2c. サイト個別の手順（MCPフォールバック時・修復時の参照）

対応するサイトスキルの手順に従う:
- Amazon → `acquisition-amazon` スキル → `POST /skill/ec/journal-candidates`
- 楽天 → `acquisition-rakuten` スキル → `POST /skill/ec/journal-candidates`
- 三菱UFJ銀行（`bank_ufj`） → `acquisition-mufg` スキル → **`POST /skill/bank/journal-candidates`**
- SBI新生銀行（`bank_shinsei`） → `acquisition-shinsei` スキル → **`POST /skill/bank/journal-candidates`**（新生固有: 国税/地方税＝利息源泉。⚠️消費税でない）
- 三菱UFJ-VISA（`card_mufg_visa`） → `acquisition-ufjvisa` スキル → **`POST /skill/bank/journal-candidates`**（カード＝未払金一脚・残高列なし＝Σ利用＝請求額で検算。Amazon/楽天利用は**付替え**で二重計上回避）

**銀行トラックの相違（`acquisition-mufg` が詳説。`docs/bank-import-api.md` が契約）**:
- 仕訳は **普通預金が一脚**で direction（入金/出金）が貸借を決める。AIは**相手科目だけ**分類する。
- 分類は**品名でなく摘要→科目**（`docs/classification-policy.md` **§5**）。利息/源泉/消費税は決定的＝確信提案（`unresolved` に逃がさない）。
- 冪等は**出現インデックス方式**（取引日+金額+方向+摘要+出現連番）＝UI手動CSV取込と互換。**同一口座を両トラックで二重に取り込まない**。
- 金額が DOM 抽出なので **差引残高チェーンの自己検算が必須**（崩れたら投入せず人へ報告）。

共通の作法:
- ヘッドフルでブラウザを開く。保存済みセッション（`storageState`）があれば復元。
- ログイン要求が出たら **一時停止して人に依頼**（「ログインと2FAを済ませたら Enter」）。AIはパスワードに触れない。
- **取得範囲＝`fetchSince` 以降かつ open 期間内**の注文のみ。`orderDate` で判定。範囲外は取らない。
- **必ず古い順（`fetchSince`→今日）に、範囲を連続して取り込む**。`fetchSince` は「これ以前は取得済み」という高水位（watermark）であり、`max(直近取込済み orderDate, 期間開始)` で前進する。**新しい注文だけ先に取ると、その間の古い注文が watermark の後ろに隠れて取りこぼす**（例: 最新3件だけ取ると fetchSince が最新日へ跳ね、間の注文が拾えなくなる）。サンプル/部分取込をするときは、範囲を人に明示確認し、取りこぼし分は別途キャッチアップする。
- 差分の再取込は `fetchSince`（最終取込日）からでよい。同日は重複し得るが `sourceType+orderId+lineNo` の冪等で**重複は自動スキップ**、同日に増えた新規だけ入る。
- **証跡保存は手順1の `evidenceCapture` で分岐**:
  - `evidenceCapture=true` → 注文ごとに**生証跡を保存**（`./.kanean/evidence/<source>/<orderId>/` にスクショ/HTML。このdirはローカル秘密＝gitignore 済みを確認/追加）し、`evidenceRef` に保存パスを入れる。
  - `evidenceCapture=false` → **スクショ保存はスキップ**（取込が速い）。`evidenceRef` には注文URL等の参照を入れる（API は `evidenceRef` 必須＝空にしない）。抽出自体は常にページの snapshot から行うので金額の検証性は保たれる。
- スコープ最小化（`docs/acquisition-skill-spec.md` §9）: **明細が必須なのは経費品と私用品が混在する注文だけ**。混在注文を優先する。

抽出結果は `docs/csv-format.md` §4.2 の正規化明細（注文＝複数行）にする（**JSONキーは camelCase**）:
- 明細: `lineNo / itemName / quantity / lineAmount / evidenceRef`。**`lineAmount` はその商品の値引き反映後の税込純額**（Amazon は適格請求書PDFの商品別小計。割引を別に持たず純額化＝按分しない）。
- 注文: `orderId / orderDate / orderTotal`（＝ご請求額）（任意 `paymentHint` / `currency`）。**注文レベル調整**（任意・非負円整数）: `shipping`（送料・手数料）/ `pointsUsed`（ポイント利用）/ `pointsEarned`（ポイント付与）。
- **突合**: `Σ lineAmount + shipping − pointsUsed == orderTotal` になるよう取得する（合わなければ人へ報告・本体も warning）。

### 3. 品目ごとに分類（確定履歴 ▶ ポリシー ▶ 未確定）

> **銀行トラック**は品名でなく**摘要→科目**（`classification-policy.md` §5・利息/源泉/消費税は確信提案）。`source` は `bank_ufj`、付与する `treatment` は EC より広い（owner_contribution/revenue/settlement）。詳細は `acquisition-mufg`。以下は EC（品名）の手順。

今回抽出した品名で確定履歴を引く:
```bash
"${CURL[@]}" "${book[@]}" -H 'Content-Type: application/json' \
  -d '{"source":"amazon","items":["SanDisk microSDXC 256GB","鬼滅の刃 24巻"]}' \
  "$BASE/skill/classification-history/lookup"
```
- 返る `candidates`（`pattern`→`proposedAccount`/`treatment`）を**最優先**で各品目に当てる（意味で一致するもの）。
- 履歴に無い品目は **`docs/classification-policy.md` のポリシー**で分類（例: SDカード→消耗品費 / 漫画→事業主貸 / 技術書→新聞図書費）。
- 高額（取得価額10万円以上）・判別不能・私用疑いは安全側で `treatment=unresolved`（未確定）＋ `reason`。**勝手に経費にしない**。
- 各行に付与: `proposedAccount`(科目名) / `treatment`(expense/owner_draw/unresolved) / `reason`(1行) / `confidence` / `policyRef`(ポリシー版・例 `ec-classify@v1`)。

### 4. draft 投入（クリアリング連鎖は本体が機械適用）

> **銀行トラック**は投入先が **`POST /skill/bank/journal-candidates`**（payload は `transactions[]`・普通預金一脚は本体が direction で機械構築）。以下は EC（`/skill/ec/journal-candidates`）の手順。

サービスの `accountRef` を指定して投入（`source` ではなく **accountRef**）:
```bash
"${CURL[@]}" "${book[@]}" -H 'Content-Type: application/json' \
  -d @/tmp/ec-payload.json \
  "$BASE/skill/ec/journal-candidates"
```
payload（**camelCase**）は `{ "accountRef":"amazon-1", "fileName":"amazon_YYYY-MM.json", "orders":[ {orderId,orderDate,orderTotal, shipping?, pointsUsed?, pointsEarned?, lines:[{lineNo,itemName,quantity,lineAmount,proposedAccount,treatment,reason,confidence,policyRef,evidenceRef}]} ] }`。
- 金額(`lineAmount`/`orderTotal`/`shipping`/`pointsUsed`/`pointsEarned`)は非負の円整数。`lineAmount` は**値引き反映後の税込純額**。
- 本体が**クリアリング連鎖＋注文レベル調整仕訳**を機械生成（`docs/csv-format.md` §4.3・方式B）し、**未払金=請求額**にそろえる:
  借)費用科目（仕訳候補）/ 貸)未払金(チャネル)、送料→借)雑費、ポイント利用→貸)事業主借、ポイント付与→借)事業主貸・貸)雑収入。

### 5. 結果を報告

応答（camelCase）の各件数を人にそのまま報告（**黙って落とさない**）:
- `acceptedLines` / `draftEntries`（承認待ち）
- `skippedDup`（既取込）/ `excludedCount`＋`excludedOutOfPeriod`（翌期＝繰越後に取込）/ `unresolved`（要確認）/ `warnings`（明細合計と注文合計のズレ・行失敗等）

最後に案内: 「Kanean の **連携サービス** タブで draft を確認・承認してください。確定した分類は次回以降の提案に学習されます。」

## カスタマイズ

- 分類の方針・例は **`docs/classification-policy.md`** を編集する（このスキル本体は触らなくてよい）。
- サイトのページ構造変化は、まず **較正データ**（`$DATA_DIR/acquisition/selectors/<source>.json`。
  アプリの更新なしで直せる）、次に **`packages/acquisition/src/sites/<site>.mjs`**（手順2b の自動修復対象）、
  最後に各サイトスキル（`acquisition-amazon` / `acquisition-rakuten` / `acquisition-mufg` /
  `acquisition-shinsei` / `acquisition-ufjvisa`）に閉じる。
- **同じ手順を2箇所に持たない**。アプリ内取込（Electron）とこのスキル経路は同じ `sites/*.mjs` を動かすので、
  片方だけ直すという状態は作らない。

## 規約

- 本人が自分のデータを個人利用の範囲で取得する前提。商用再配布・第三者の代行取得はしない。
- 生証跡・保存セッションはローカルの秘密（gitignore・非同期）。
