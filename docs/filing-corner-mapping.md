# 確定申告書等作成コーナー 転記マッピング — Kanean

> [form-mapping.md](./form-mapping.md) の様式ボックス（`statement_line_code`）を、国税庁
> **確定申告書等作成コーナー**の入力画面・欄へ対応づける。入力指示書
> （`GET /api/filing/instruction-sheet`）の画面グループ・項目順は本書を正とする。
> 提出そのものの規約（検算ゲート・認証と送信は人間）は openspec `filing` spec を参照。
>
> ⚠️ **基準年分: 令和7年分**の作成コーナー画面構成を基に記述。作成コーナーは毎年1月に
> 作り直されるため、**提出対象年分の公開後に本書を実画面で検証・更新する**こと。
> 画面名・欄ラベルの軽微な揺れは転記者（人または AI）が画面を読んで吸収してよいが、
> **欄の意味が特定できない乖離は入力せず停止して報告する**（推測で埋めない）。

---

## 0. 全体フローと指示書の画面グループ

作成コーナーは「決算書・収支内訳書」→「所得税」→（別途）「消費税」の順に作成し、
決算書の結果は所得税コーナーへ引き継がれる。指示書の `groups` はこの順に並ぶ。

```
A. 決算書・収支内訳書作成コーナー（青色申告決算書）
   A1 種類選択 → A2 損益（月別売上・仕入） → A3 損益（経費） → A4 内訳（減価償却ほか）
   → A5 青色申告特別控除 → A6 貸借対照表 → A7 決算書の確認
B. 所得税及び復興特別所得税の確定申告書作成コーナー
   B1 収入・所得（事業） → B2 所得控除 → B3 税額控除・源泉・予定納税
   → B4 計算結果確認（★検算） → B5 住民税等 → B6 基本情報
C. 消費税及び地方消費税の確定申告書作成コーナー（簡易課税）
   C1 条件判定 → C2 売上（税率別） → C3 中間納付 → C4 計算結果確認（★検算）
```

各項目には種別を付す:

- `input` … 転記者が値を入力する欄
- `select` … 選択肢を選ぶ欄（値は指示書が文字列で指定）
- `verify` … 作成コーナーが自動計算する欄。**入力せず**、指示書の値と一致することを確認する

`verify` の不一致は入力ミスか前提のずれを意味するので、その時点で停止して差分を報告する
（最終の★検算まで進めてから気づくより早い）。

---

## A. 決算書・収支内訳書作成コーナー（青色申告決算書）

### A1 種類選択

| 欄 | 種別 | 値の源 |
|---|---|---|
| 提出方法（e-Tax で送信） | select | 手順の前提（固定） |
| 決算書の種類（青色申告決算書・一般用） | select | 固定 |

### A2 損益計算書 — 売上・仕入（月別）

作成コーナーは月別を入力すると年計①③を自動計算する。月別が正、①③は verify。

| 画面欄 | 種別 | line_code |
|---|---|---|
| 月別売上（1〜12月・家事消費・雑収入） | input | AOIRO.URIAGE.*（form-mapping §1.7） |
| 月別仕入（1〜12月） | input | 同上 |
| 売上（収入）金額 ① | verify | AOIRO.PL.SALES |
| 仕入金額 ③ | verify | AOIRO.PL.PURCHASE |
| 期首・期末棚卸高 ②⑤ | input | AOIRO.PL.OPEN_STOCK / CLOSE_STOCK |

### A3 損益計算書 — 経費

| 画面欄 | 種別 | line_code |
|---|---|---|
| 租税公課⑧〜雑費㉜（標準行） | input | AOIRO.PL.EXP_*（form-mapping §1.1 の並び） |
| 空欄行の科目名と金額（㉕〜㉛） | input | AOIRO.PL.EXP_BLANK_1..7（科目名も指示書が指定） |
| 経費計 ㉝ | verify | AOIRO.PL.EXP_TOTAL |
| 差引金額 ㉞ | verify | AOIRO.PL.NET_BEFORE_ADJ |

> 減価償却費⑱は A4 の資産入力から自動計算されるため、A3 では入力しない（verify のみ）。

### A4 内訳ページ

| 画面 | 種別 | データ源 |
|---|---|---|
| 減価償却資産の入力（1件ずつ: 名称・取得年月・取得価額・償却方法・耐用年数・事業専用割合） | input | form-mapping §1.3（`fixed_assets` / `depreciation_entries`） |
| 本年分の必要経費算入額（資産ごと・合計⑱） | verify | depreciation_entries.business_amount / AOIRO.PL.EXP_DEP |
| 給料賃金の内訳 | input | form-mapping §1.4 |
| 専従者給与の内訳 | input | form-mapping §1.6 |
| 地代家賃の内訳 | input | form-mapping §1.5 |
| 貸倒引当金（一括評価） | input | form-mapping §1.8 |

### A5 青色申告特別控除

| 欄 | 種別 | 値の源 |
|---|---|---|
| 控除区分（65万/55万/10万） | select | `GET /api/tax-return/blue-deduction`（e-Tax 送信を行う本フローでは 65 万の電子要件を満たす。指示書が判定済みの区分を指定） |
| 青色申告特別控除前の所得金額 ㊸ | verify | AOIRO.PL.INCOME_BEFORE |
| 青色申告特別控除額 ㊹ / 所得金額 ㊺ | verify | AOIRO.PL.BLUE_DEDUCT / AOIRO.PL.INCOME |

### A6 貸借対照表

| 欄 | 種別 | line_code |
|---|---|---|
| 資産・負債・資本の各科目（期首/期末） | input | AOIRO.BS.*（form-mapping §1.2） |
| 資産合計・負債資本合計の一致 | verify | AOIRO.BS.TOTAL_* |

### A7 決算書の確認 → 所得税コーナーへ引継ぎ

決算書データを保存し、「所得税の申告書作成へ」で引き継ぐ。㊺が第一表の事業所得へ
自動転記される（B1 で verify）。

---

## B. 所得税の確定申告書作成コーナー

### B1 収入金額・所得金額（事業・営業等）

| 欄 | 種別 | line_code |
|---|---|---|
| 収入金額（営業等） | verify | KAKUTEI.1.INCOME_BIZ（決算書から引継ぎ） |
| 所得金額（営業等） | verify | KAKUTEI.1.AMOUNT_BIZ ＝ ㊺ |

### B2 所得控除

`tax_return_inputs`（`POST /api/tax-return/income-tax/inputs` で保存済みの値）を転記する。

| 欄 | 種別 | データ源 |
|---|---|---|
| 社会保険料控除（内訳含む） | input | tax_return_inputs.socialInsurance |
| 生命保険料控除 | input | tax_return_inputs.lifeInsurance |
| 医療費控除 | input | tax_return_inputs.medical |
| 配偶者(特別)控除・扶養控除 | input | tax_return_inputs.spouse / dependents |
| 基礎控除 | verify | 作成コーナーが所得から自動判定（指示書の値と一致確認） |
| その他（寄附金等） | input | tax_return_inputs.other |

### B3 税額計算・源泉・予定納税

| 欄 | 種別 | データ源 |
|---|---|---|
| 所得の内訳（支払者・収入・源泉徴収税額） | input | KAKUTEI.2.INCOME_DETAIL（form-mapping §2.2） |
| 源泉徴収税額 合計 | verify | KAKUTEI.1.WITHHOLD |
| 予定納税額 | input | tax_return_inputs.estimatedTax |

### B4 計算結果確認 ★検算

| 欄 | 種別 | 指示書 checksum |
|---|---|---|
| 課税される所得金額 | verify | KAKUTEI.1.TAXABLE |
| 申告納税額（納める税金／還付される税金） | **verify（★）** | checksum.incomeTax（1円単位で一致必須） |

### B5 住民税等・B6 基本情報

住民税に関する事項（給与所得者は徴収方法等）・住所・氏名・マイナンバー等は
帳簿データ外のため指示書は値を持たない（`input`・利用者が自分の情報を入れる）。
事業所情報（屋号・所在地）は `business_settings` から指示書が供給する。

---

## C. 消費税の確定申告書作成コーナー（簡易課税）

### C1 条件判定

| 欄 | 種別 | データ源 |
|---|---|---|
| 簡易課税制度の適用 | select | 固定（本アプリの前提。[accounting-spec.md](./accounting-spec.md) §3） |
| 事業区分 | select | business_settings.tax_business_category（既定 第5種） |

### C2 売上（収入）金額の入力

| 欄 | 種別 | line_code |
|---|---|---|
| 税率別の課税売上（10%/軽減8%・税込または税抜の指定に従う） | input | SHOHI.FUHYO.SALES_10 / SALES_8 |
| 返還等対価・貸倒れ | input | SHOHI.FUHYO.RETURN / BADDEBT |
| 課税標準額・消費税額 | verify | SHOHI.1.TAX_BASE / TAX_AMOUNT |

### C3 中間納付

| 欄 | 種別 | line_code |
|---|---|---|
| 中間納付税額 | input | SHOHI.1.MID_PAID |

### C4 計算結果確認 ★検算

| 欄 | 種別 | 指示書 checksum |
|---|---|---|
| 差引税額（国税） | **verify（★）** | checksum.consumptionNational |
| 地方消費税額 | **verify（★）** | checksum.consumptionLocal |
| 納付税額 合計 | **verify（★）** | checksum.consumptionTotal |

---

## D. 運用上の規約（転記手順に織り込む）

1. **転記値は指示書のみを源とする**。画面が指示書に無い入力を要求したら利用者に確認する。
2. `verify` 欄の不一致・★検算の不一致は**その場で停止**し、欄名と両方の値を報告する。
   一致しないまま送信へ進まない。完了記録も作らない。
3. ログイン・マイナンバーカード認証（QR 読み取り）・**送信操作は利用者が行う**。
4. 長丁場のため、コーナーの**途中保存（.data ファイル）**を区切りごとに案内し、
   セッション切れ時は再開ファイルから続行する。
5. 送信後は受信通知・申告書控え PDF を保存し、完了記録（受付番号）とともに
   `POST /api/filing/records` へ記録する。

## E. 年次メンテナンス

- [ ] 提出対象年分の作成コーナー公開（例年1月）後、A〜C の画面名・欄ラベル・遷移を実画面で突合する
- [ ] form-mapping.md 側の様式改訂（丸数字ずれ等）があれば本書の line_code 参照も追随する
