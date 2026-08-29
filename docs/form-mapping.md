# 帳票マッピング仕様（PDF層）— Kanean

> [data-model.md](./data-model.md) の `statement_items.statement_line_code` を、確定申告に必要な各様式の欄へ対応づける。
> 本書は **Phase 3（PDF出力・手動提出）** が対象の **PDF層**。XML層（e-Tax 様式ID/タグ名）は [etax-api-notes.md](./etax-api-notes.md) §6 を参照し別途追補する。
> 対象様式: ①所得税青色申告決算書（一般用） ②確定申告書（第一表・第二表） ③消費税及び地方消費税申告書（簡易課税用）。
>
> ⚠️ **各様式の項番（丸数字・欄番号）は令和6年分の最新様式で要確認**。本書は構造とデータ源の対応を正とし、番号は実装前に公式様式と突合する。

---

## 0. statement_line_code の体系

`statement_items.statement_line_code` に **PDF層の宛先**を付与する。複数様式に同一値が出る場合は配列（連動）で持つ。

```
{FORM}.{SECTION}.{LINE}
  FORM    : AOIRO(青色申告決算書) / KAKUTEI(確定申告書) / SHOHI(消費税申告書 簡易)
  SECTION : PL/BS/DEP/RENT/SALARY/SENJU/KASHIDAORE/URIAGE  …(様式内の区分)
  LINE    : 行キー（丸数字は box 列に別持ち）
```
> 宛先は data-model の `statement_items` に紐づくため、勘定科目→決算書科目→欄 の3段で集計される。
> XML層を追加する際は同テーブルに `etax_youshiki_id` / `etax_tag` 列を足し、本書の各行へ対応づける。

---

## 1. 青色申告決算書（一般用）

### 1.1 損益計算書（1ページ目）
集計元: 当該年度 `confirmed` 仕訳の `journal_lines` を、決算書科目配下の勘定科目で合算（§5 算出ルール）。
box は標準様式の丸数字（要確認）。参照CSVのPL決算書科目に準拠。

| line_code | 決算書科目（様式の行） | box(要確認) | データ源（勘定科目） | 算出 |
|---|---|---|---|---|
| AOIRO.PL.SALES | 売上（収入）金額 | ① | 売上高・売上値引返品・家事消費等・雑収入 | 売上系の貸方−借方 |
| AOIRO.PL.OPEN_STOCK | 期首商品（製品）棚卸高 | ② | 期首商品棚卸高 | |
| AOIRO.PL.PURCHASE | 仕入金額 | ③ | 仕入高・仕入値引返品 | |
| AOIRO.PL.SUBTOTAL_COST | 小計 | ④ | – | ②+③ |
| AOIRO.PL.CLOSE_STOCK | 期末商品（製品）棚卸高 | ⑤ | 期末商品棚卸高 | |
| AOIRO.PL.COST | 差引原価 | ⑥ | – | ④−⑤ |
| AOIRO.PL.GROSS | 差引金額 | ⑦ | – | ①−⑥ |
| AOIRO.PL.EXP_TAX | 租税公課 | ⑧ | 租税公課 | |
| AOIRO.PL.EXP_PACK | 荷造運賃 | ⑨ | 荷造運賃 | |
| AOIRO.PL.EXP_UTIL | 水道光熱費 | ⑩ | 水道光熱費 | |
| AOIRO.PL.EXP_TRAVEL | 旅費交通費 | ⑪ | 旅費交通費 | |
| AOIRO.PL.EXP_COMM | 通信費 | ⑫ | 通信費 | |
| AOIRO.PL.EXP_AD | 広告宣伝費 | ⑬ | 広告宣伝費 | |
| AOIRO.PL.EXP_ENT | 接待交際費 | ⑭ | 接待交際費 | |
| AOIRO.PL.EXP_INS | 損害保険料 | ⑮ | 損害保険料 | |
| AOIRO.PL.EXP_REPAIR | 修繕費 | ⑯ | 修繕費 | |
| AOIRO.PL.EXP_SUPPLY | 消耗品費 | ⑰ | 消耗品費 | |
| AOIRO.PL.EXP_DEP | 減価償却費 | ⑱ | 減価償却費 | §1.3 と連動 |
| AOIRO.PL.EXP_WELFARE | 福利厚生費 | ⑲ | 福利厚生費・法定福利費 | |
| AOIRO.PL.EXP_SALARY | 給料賃金 | ⑳ | 給料賃金・退職給与 | §1.4 と連動 |
| AOIRO.PL.EXP_OUTSRC | 外注工賃 | ㉑ | 外注工賃 | |
| AOIRO.PL.EXP_INTEREST | 利子割引料 | ㉒ | 利子割引料 | |
| AOIRO.PL.EXP_RENT | 地代家賃 | ㉓ | 地代家賃 | §1.5 と連動 |
| AOIRO.PL.EXP_BADDEBT | 貸倒金 | ㉔ | 貸倒金(損失) | |
| AOIRO.PL.EXP_BLANK_1..7 | （空欄行：その他経費） | ㉕〜㉛ | 車両費・リース料・支払手数料・研修採用費・新聞図書費・会議費 等 | 標準行に無い科目を空欄行へ |
| AOIRO.PL.EXP_MISC | 雑費 | ㉜ | 雑費・繰延資産償却 | |
| AOIRO.PL.EXP_TOTAL | 経費計 | ㉝ | – | ⑧〜㉜の合計 |
| AOIRO.PL.NET_BEFORE_ADJ | 差引金額 | ㉞ | – | ⑦−㉝ |
| AOIRO.PL.RESERVE_BACK | 貸倒引当金等 繰戻額等 | ㉟〜 | 貸倒引当金戻入 | |
| AOIRO.PL.SENJU | 専従者給与 | （繰入欄） | 専従者給与 | §1.6 と連動 |
| AOIRO.PL.RESERVE_IN | 貸倒引当金繰入 | （繰入欄） | 貸倒引当金繰入 | |
| AOIRO.PL.INCOME_BEFORE | 青色申告特別控除前の所得金額 | ㊸ | – | 算出 |
| AOIRO.PL.BLUE_DEDUCT | 青色申告特別控除額 | ㊹ | – | 最大65万（要件判定） |
| AOIRO.PL.INCOME | 所得金額 | ㊺ | – | ㊸−㊹ → **確定申告書へ転記** |

### 1.2 貸借対照表（4ページ目）
集計元: `opening_balances`（期首）と当該年度末残高（期末＝開始残高+期中仕訳の累積）。決算書(貸借)の section/決算書科目に対応（[data-model](./data-model.md) §2.3.1, 実画面の構造）。

| line_code | section / 決算書科目 | 期首列 | 期末列 |
|---|---|---|---|
| AOIRO.BS.ASSET.* | 資産の部（現金/普通預金/売掛金/車両運搬具/減価償却累計額 …） | opening_balances(借方) | 期末残高(debit科目) |
| AOIRO.BS.LIAB.* | 負債の部（買掛金/未払金/借入金 …） | opening_balances(貸方) | 期末残高(credit科目) |
| AOIRO.BS.EQUITY.MOTOIRE | 資本の部：元入金 | opening_balances(元入金) | 同額（期中不変） |
| AOIRO.BS.EQUITY.INCOME | 資本の部：控除前所得金額 | – | 損益の㊸を連結（§5.3） |
| AOIRO.BS.TOTAL_* | 資産の部合計 / 負債・資本の部合計 | – | 一致を検証 |

### 1.3 減価償却費の計算（3ページ目）
集計元: `fixed_assets` + `depreciation_entries`（当該年度）。

| 様式の列 | データ源 |
|---|---|
| 減価償却資産の名称 | fixed_assets.name |
| 取得年月 / 取得価額 | acquired_date / acquisition_cost |
| 償却方法 / 耐用年数 / 償却率 | depreciation_method / useful_life / depreciation_rate |
| 本年分の普通償却費 | depreciation_entries.depreciation_amount |
| 事業専用割合 | fixed_assets.business_use_ratio |
| 本年分の必要経費算入額 | depreciation_entries.business_amount |
| 未償却残高 | depreciation_entries.closing_book_value |
| （特別償却費） | fixed_assets.special_depreciation_amount |

> 必要経費算入額の合計 = 損益計算書 減価償却費⑱。

### 1.4 給料賃金の内訳
集計元: 給料賃金 勘定の `journal_lines`（補助科目＝従業員別）。氏名・支給額・源泉徴収税額を内訳化。

### 1.5 地代家賃の内訳
集計元: 地代家賃 勘定の `journal_lines`。支払先（counterparty_id）・物件・本年中の賃借料・うち必要経費算入額（家事按分後）を内訳化。

### 1.6 専従者給与の内訳
集計元: 専従者給与 勘定。

### 1.7 月別売上（収入）金額及び仕入金額
集計元: 売上系・仕入系 `journal_lines` を月別（entry_date の月）に集計。

### 1.8 貸倒引当金繰入額の計算（2ページ目・一括評価のみ）
集計元: 期末残高（`accountAggregates`）＋ 損益の貸倒引当金繰入（AOIRO.PL.RESERVE_IN）。

| 欄 | 内容 | 算出 |
|---|---|---|
| ① | 個別評価による本年分繰入額 | 未モデル化（0・空欄）。個別評価貸金は別途データが必要 |
| ② | 年末における一括評価による貸金の合計額 | 期末 売掛金 + 受取手形 残高（一括評価対象の標準債権） |
| ③ | 本年分繰入限度額 | `floor(② × 5.5%)`。**金融業の 3.3% は対象外**（注記し 5.5% 固定） |
| ④ | 本年分繰入額（一括評価による） | ⑤ − ①（実際に計上した一括分） |
| ⑤ | 本年分貸倒引当金繰入額 | ① + ④ ＝ RESERVE_IN 実績（帳簿の繰入額が正） |

連動: ⑤ ＝ 損益計算書の貸倒引当金繰入（AOIRO.PL.RESERVE_IN）。⑤＝0 の場合は表全体を空欄とする。
注: ② の対象債権は売掛金・受取手形に限定（貸付金・未収入金等の一括評価編入は後続）。個別評価（①）と金融業 3.3% は未対応。

---

## 2. 確定申告書（第一表・第二表）

> 個人の所得税申告本体。事業所得は青色決算書から転記。

### 2.1 第一表
| line_code | 欄 | box(要確認) | データ源 |
|---|---|---|---|
| KAKUTEI.1.INCOME_BIZ | 収入金額等：事業（営業等） | – | 青色決算書 売上①（AOIRO.PL.SALES） |
| KAKUTEI.1.AMOUNT_BIZ | 所得金額等：事業（営業等） | – | 青色決算書 所得金額㊺（AOIRO.PL.INCOME）を**転記** |
| KAKUTEI.1.AMOUNT_TOTAL | 所得金額の合計 | – | 各所得の合計 |
| KAKUTEI.1.DEDUCT_* | 所得から差し引かれる金額（社保・基礎控除 等） | – | 別途入力（控除データ） |
| KAKUTEI.1.TAXABLE | 課税される所得金額 | – | 合計所得−所得控除 |
| KAKUTEI.1.TAX | 上の金額に対する税額 | – | 累進税率で算出 |
| KAKUTEI.1.WITHHOLD | 源泉徴収税額 | – | 第二表 所得の内訳の源泉合計（§2.2） |
| KAKUTEI.1.PAYABLE | 申告納税額（納める/還付） | – | 算出 |

> 消費税は所得税申告書には載らず、別途③で申告。

### 2.2 第二表
| line_code | 欄 | データ源 |
|---|---|---|
| KAKUTEI.2.INCOME_DETAIL | 所得の内訳（支払者・収入・源泉徴収税額） | `documents`(請求/売上) と `journal_lines` の源泉（事業主貸(源泉所得税)） |
| KAKUTEI.2.SOCIAL_INS | 社会保険料控除 等の内訳 | 控除データ |
| KAKUTEI.2.SENJU | 事業専従者に関する事項 | 専従者給与（§1.6） |

---

## 3. 消費税及び地方消費税申告書（簡易課税用）

> 計算ロジックは [accounting-spec.md](./accounting-spec.md) §3。第5種＝みなし仕入率50%。

### 3.1 付表（簡易課税の計算：付表4-3 / 5-3 相当）
| line_code | 欄 | データ源 / 算出 |
|---|---|---|
| SHOHI.FUHYO.SALES_10 | 課税標準額（税率10%・税抜） | tax_categories `SALE_10_*` の課税売上集計 |
| SHOHI.FUHYO.SALES_8 | 課税標準額（税率8%・税抜） | `SALE_8_*` 集計 |
| SHOHI.FUHYO.TAX_SALES | 売上に係る消費税額 | 課税標準額×税率（国税分） |
| SHOHI.FUHYO.DEEMED_RATE | みなし仕入率 | 第5種=50%（business_settings） |
| SHOHI.FUHYO.DEDUCT_PUR | 控除対象仕入税額 | 売上税額×みなし仕入率 |
| SHOHI.FUHYO.RETURN | 返還等対価に係る税額 | `*_RET` 集計 |
| SHOHI.FUHYO.BADDEBT | 貸倒れに係る税額 | `*_BAD` 集計 |

### 3.2 申告書（第一表・第二表）
| line_code | 欄 | 算出 |
|---|---|---|
| SHOHI.1.TAX_BASE | 課税標準額 | 付表より |
| SHOHI.1.TAX_AMOUNT | 消費税額 | 売上税額−控除対象仕入税額−返還−貸倒（国税） |
| SHOHI.1.LOCAL_TAX | 地方消費税額 | 国税×(地方割合/国税割合) |
| SHOHI.1.MID_PAID | 中間納付税額 | 中間納付実績（e-Tax 消費税事項参照と照合可） |
| SHOHI.1.PAYABLE | 納付税額 | 算出 |

---

## 4. 帳票間の連動（転記）

PDF層でも様式間の転記が発生する。e-Tax §5 帳票間連動（転記元→転記先）と概念一致。

| 転記元 | 転記先 |
|---|---|
| 青色決算書 所得金額㊺（AOIRO.PL.INCOME） | 確定申告書 第一表 事業所得（KAKUTEI.1.AMOUNT_BIZ） |
| 青色決算書 損益㊸（控除前所得） | 青色決算書 貸借 資本の部 控除前所得金額（AOIRO.BS.EQUITY.INCOME） |
| 減価償却 必要経費算入額 合計（§1.3） | 損益計算書 減価償却費⑱ |
| 各内訳ページ（地代家賃/給料/専従者） | 損益計算書 各経費行 |
| 第二表 源泉徴収税額 合計 | 第一表 源泉徴収税額（KAKUTEI.1.WITHHOLD） |
| 消費税 付表 | 消費税 申告書第一表 |

---

## 5. 算出ルール（共通）

### 5.1 損益計算書の各行
```
行の金額 = Σ 当該決算書科目配下の勘定科目の journal_lines（status=confirmed, 当該年度）
          （収益科目=貸方−借方、費用科目=借方−貸方。家事按分・減価償却の期末仕訳を含む）
```
### 5.2 貸借対照表の各行
```
期首 = opening_balances（当該年度・科目・side）
期末 = 期首 ± 期中 journal_lines の累積（normal_balance 方向）
```
### 5.3 控除前所得金額の連結
```
損益 ㊸（青色特別控除前の所得） → 貸借 資本の部「控除前所得金額」
（期末の事業主貸/事業主借/控除前所得 → 翌期元入金へ振替。accounting-spec §1.3）
```
### 5.4 対象データ
- すべて `journal_entries.status='confirmed'` のみ（draft除外。data-model D-10）。
- 年度は `fiscal_years`。個人は暦年（1/1〜12/31）。

---

## 6. 進捗・残作業

### 完了（PDF出力）
PDF生成方式は **pdf-lib による「自前レイアウト」＋「官製様式（gs正規化テンプレ）への座標オーバーレイ」**で確定。主要3帳票が両方式で出力可能（参考帳票・legalRisk:high）。較正基盤は `scripts/calibForm.mts`（ptルーラー）＋ `assets/forms/README.md`（NTA取得・gs再生成手順）。

- [x] 青色申告決算書（損益／月別・内訳・控除計算／減価償却／貸借対照表＝全4ページ）
- [x] 貸倒引当金繰入額の計算（決算書2ページ目 §1.8）
- [x] 確定申告書 第一表・第二表（基礎控除・扶養控除＝万円単位欄も自動記入）
- [x] 消費税及び地方消費税申告書（簡易課税 第一表）
- [x] 青色申告特別控除額の判定（65万/55万/10万・e-Tax/電子帳簿要件）

### 残作業（数値・モデル層の拡張を伴う）
- [ ] **源泉徴収税額の従業員別内訳**（決算書 給料賃金§1.4／専従者給与§1.6）— 預り金(源泉所得税)からの補助科目別按分の設計
- [ ] **各種税額控除**（配当控除・住宅借入金等特別控除 等）— `taxreturn/incomeTax` 拡張（第一表 税額計算欄の㉜〜㊸群）
- [ ] **事業所得以外の所得**（不動産・給与・雑）— 所得モデル拡張（第一表 収入金額等・所得金額等の各行）
- [ ] **地代家賃の賃借料総額**（家事按分前）— 按分元データからの再構成（§1.5 様式の「本年中の賃借料」総額欄）
- [ ] 消費税 付表4-3/5-3 のオーバーレイ（軽減8%・複数事業区分が発生する場合の補助計算表）
- [ ] 各様式の項番（丸数字・欄番号）の最新年度様式との突合（オーバーレイ済みだが提出年分での再確認）
- [ ] **XML層（e-Tax）**: 様式ID＋帳票項番→タグ名を入手し `statement_items` に `etax_youshiki_id`/`etax_tag` を付与（[etax-api-notes.md](./etax-api-notes.md) §6.4）
