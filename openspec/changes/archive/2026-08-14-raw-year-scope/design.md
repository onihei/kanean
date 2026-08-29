## Context

動機・症状・影響は [proposal.md](./proposal.md) を参照。ここでは実装上の制約と選択だけを書く。

**期間ゲートは既に3箇所にある。** 取込（`import/importer.ts:86`・`ecImport.ts:324`・`bankImport.ts:197`）と
手入力/編集（`journal/manualEntry.ts:75`）。いずれも「ISO 日付の辞書順比較で `[start_date, end_date]` に入るか」
という同一の判定を、それぞれの場所に書いている。**足りないのは仕訳化（journalize）の層だけ**であり、
新しい概念は要らない。既にある判定を、抜けている層にも当てる。

**仕訳化の入口は3つある。**

| 関数 | トラック | 呼び元 |
|---|---|---|
| `journalizeRow`（`journal/journalize.ts:96`） | 銀行・カード CSV / 汎用 | `journalizeBatch`・`journalizeRawById` |
| `journalizeEcRow`（`import/ecImport.ts:199`） | EC スキル | `importEcOrders`・`journalizeRawById` |
| `journalizeBankRow`（`import/bankImport.ts:105`） | 銀行スキル | `importBankRows`・`journalizeRawById` |

3つとも「open 年度を引いて `fiscalYearId` に入れ、`entryDate` には `raw.txnDate` をそのまま置く」構造で、
範囲の一致を誰も見ていない。`journalizeRawById`（`journalize.ts:217`）はこの3つへの分岐点で、
`restoreRawTransaction` からの唯一の入口でもある。

**`raw_transactions` に年の列は無い。** `txn_date`（`db/data/schema.ts:352`）と `fiscal_years` の範囲比較で
年を決める。既存インデックス `raw_txn_status_date_idx (status, txn_date)`（`schema.ts:377`）が
「状態で絞って日付範囲」をそのまま支える。

**UI 側は会計年度を既に持っている。** `RawTransactionsTab({ fiscalYear })` は `DateScope`
（`web/src/lib/format.ts:24`）を受け取っており、`listDate` が過年度行を年付きで描いている。
年の判定に必要な材料は揃っていて、足りないのは**その判定を操作の可否に使うこと**だけ。

## Goals / Non-Goals

**Goals:**

- 会計期間ゲートの判定を1箇所に置き、仕訳化の3経路すべてから同じものを呼ぶ
- API を直接叩いても範囲外の `entry_date` を持つ仕訳が作れない（UI の無効化は二重の壁であって唯一の壁ではない）
- 一覧の既定を当年度に閉じつつ、外した件数を必ず返す（`truncated` と同じ「黙って切らない」原則）

**Non-Goals:**

- `raw_transactions` への `fiscal_year_id` 列の追加（後述 D5）
- 過年度明細を当年度へ持ち越す機能（日付の付け替え＝別の会計判断。必要なら手入力で起票する）
- 繰越の阻却条件の追加（利用者判断で警告のみ。proposal の決定事項）
- draft のまま残った仕訳の繰越前チェック（隣接するが取込明細とは別の対象。必要なら別 change）

## Decisions

### D1. 判定を `fiscalPeriod` に切り出し、3経路すべてで呼ぶ

`packages/server/src/journal/fiscalPeriod.ts` に純関数を置く。

```
isInFiscalPeriod(fy: {startDate, endDate}, date: string): boolean
assertInFiscalPeriod(fy, date, label): void   // 範囲外なら OutOfFiscalPeriodError
```

`journalizeRow` / `journalizeEcRow` / `journalizeBankRow` の**それぞれの先頭**で、解決済みの
open 年度に対して `assertInFiscalPeriod` を呼ぶ。呼び元ではなく関数の中に置くのは、
`journalizeRawById` 経由でない呼び元（取込時の `importEcOrders` / `importBankRows`）が将来
ゲート前に分岐しても穴が開かないようにするため。取込側では既に範囲内の行しか来ないので、
実行時コストは日付2回の文字列比較だけで、二重判定の害は無い。

`manualEntry.ts:75` の同じ判定もこの関数に置き換える（判定式が2つあると片方だけ直る）。

**代案（採らない）**: `journalizeRawById` の1箇所だけに置く。復帰経路は塞げるが、
`journalizeBatch` と取込時の経路が素通しのまま残る。「根治」の位置が入口ではなく**書込みの直前**に
あることが重要。

**代案（採らない）**: `journalizeRow` を `createManualEntry` 経由に作り替える。ゲートは自動で付くが、
`journalize` 側は2行固定・`sourceRef` あり・`status='draft'` と契約が違い、変更の幅がバグの
修正としては大きすぎる（[[journal]] の別 Requirement を巻き込む）。

### D2. バッチは事前に振り分ける（例外で止めない）

`journalizeBatch` は pending 行を取ったあと、**ループに入る前に**範囲内/範囲外へ振り分ける。
範囲内だけを `journalizeRow` に渡し、範囲外は件数として返す。

```
JournalizeSummary { drafted: number; skippedOutOfPeriod: number }
```

例外を投げてループを中断すると、途中まで作った draft が残る（`journalizeBatch` は
トランザクションで包まれていない）。取込の `skippedOutOfPeriod`（`importer.ts:39`）と
同じ形にして、UI の表示も既存の文言（`ServicesTab.tsx:522`）に1項目足すだけにする。

単発（`journalizeRawById`）は逆に**投げる**。利用者が1件を名指しで操作しているので、
黙って0件成功にすると何も起きなかったように見える。

### D3. 一覧のスコープは `?years=all` で解除する

`GET /api/raw-transactions` に `years` を足す。既定（未指定）＝開いている会計年度に閉じる、
`years=all` ＝絞らない。

```
listRawTransactions(db, { status?, years?: 'open' | 'all' })
  → { items, total, truncated, outOfYearTotal }
```

- `total` … 適用後のスコープ内・status 適用後の総件数（`truncated` の判定もこれ）
- `outOfYearTotal` … 同じ status で**スコープ外にある**件数。`years=all` のとき、および
  open 年度が無いときは 0

`open` / `all` の語を選ぶのは、除外される行が必ずしも「過年度」とは限らないため
（繰越を取り消す＝`reopen` すると、翌期に取り込み済みの行が open 年度より**未来**に来る）。
UI の文言は「過年度も表示」で構わないが、API の語は年の前後に依存しない形にする。

**代案（採らない）**: `includePastYears=1`（`counterparties` の `includeInactive=1` に倣う）。
上の理由で「past」が正しくない場合がある。

**代案（採らない）**: `fiscalYearId` を任意に指定できるようにする。年度を選んで見る一覧は
仕訳帳・帳票側にも無く（すべて open 固定）、ここだけ先行して持つ理由が無い。

open 年度が無いときは絞らない（`withOpenYear` のように空を返すのではなく全件返す）。
取込明細は open 年度があった時期にしか作られないため、この状態は実質「年度未設定の新規帳簿＝0件」で、
空を返すのと結果は同じだが、万一行があるときに**見えなくなる方が悪い**。

### D4. 繰越の警告は read-only の precheck で返す

`GET /api/closing/rollover/precheck` を足し、当期に属する未処理明細の件数を返す。

```
{ unprocessedRaw: { pending: number, ignored: number } }
```

`ClosingTab` の繰越パネルが開いたときに1回引き、0件でなければ確認の前に出す。
繰越そのもの（`POST /closing/rollover`）の契約は変えない（引数も戻り値も現状のまま）。

**代案（採らない）**: `capital-transfer/preview` の戻り値に混ぜる。あちらは元入金の計算結果で、
「繰越して良いか」の材料ではない。利用者が「振替を計算」を押さないと警告が出ないのも条件として弱い。

**代案（採らない）**: `POST /closing/rollover` の戻り値に警告を含める。繰越が済んだ後に
「未処理が N 件ありました」と言われても遅い。

**代案（採らない）**: web から `GET /raw-transactions?status=pending` を2回呼んで `total` を読む。
サーバ変更ゼロで済むが、「当期の未処理」という意味を UI 側で組み立てることになり、
[[closing]] の要求としてサーバに書けない。

### D5. `raw_transactions` に `fiscal_year_id` 列は足さない

`txn_date` と `fiscal_years` の範囲比較で年は一意に決まる（会計年度は暦年で重ならない）。
列を足すと (1) 既存行のバックフィル、(2) 年度の範囲を編集したときの再計算、(3) `txn_date` との
不整合という3つの面倒が増える。得られるのは JOIN の削減だけで、一覧は `LIMIT 500` の規模である。

### D6. UI は「サーバが拒否するものをボタンで誘わない」だけを担う

- 状態フィルタの隣にチェックボックス「過年度も表示」（`years=all` の切替）
- `outOfYearTotal > 0` のとき「他の年度に N 件（過年度も表示で確認できます）」を出す
- 行の `txnDate` が `fiscalYear` の範囲外なら「復帰」を `disabled` にし、`title` に理由を書く
  （判定は `listDate` と同じ `DateScope` の比較。`format.ts` に `inScope(iso, fy)` を出し、
  `listDate` もそれを使う）

無効化は導線の話で、正しさはサーバのゲート（D1）が持つ。

## Risks / Trade-offs

- **既定が変わることで「明細が消えた」と見える** → `outOfYearTotal` を常に表示し、
  解除手段を同じ場所に置く。件数が 0 のときは何も出さない（通常の1年目の帳簿では画面が変わらない）
- **判定の重複が残る（取込側の3箇所はそのまま）** → 取込側は「取り込むか」を、仕訳化側は
  「起票するか」を決めており、判定式は同じでも意思決定が別。`isInFiscalPeriod` を共有すれば
  式の重複は消える。取込側の呼び出しも同じ関数に寄せるかは実装時に判断（挙動は変わらない）
- **`JournalizeSummary` の形が変わる** → 参照は `api.ts:456` と `ServicesTab.tsx:522` の2箇所のみ。
  追加フィールドなので既存の表示は壊れない
- **`reopen`（繰越取消）後に未来日の行がスコープ外になる** → D3 で `open`/`all` の語にしたのはこのため。
  未来日の行は復帰も拒否される（正しい。open 年度の外だから）
- **過年度の pending が永久に処理できなくなる** → 意図した結果。過年度に計上したい取引が
  本当にあるなら、繰越を取り消す（`reopen`）か、当期の日付で手入力する。どちらも明示操作であり、
  黙って範囲外の仕訳ができるより良い

## Migration Plan

DB スキーマの変更もデータ移行も無い（列を足さない・行を動かさない）。既に不正な `entry_date` を
持つ仕訳がある帳簿の修復は本 change の対象外（本番帳簿はまだ繰越しておらず、発生していない）。
巻き戻しは実装のリバートのみで足りる。

## Open Questions

- 「過年度も表示」の状態を画面遷移をまたいで覚えるか（現状の状態フィルタは覚えていない）。
  覚えない方に倒して実装し、使ってみて決める。仕様にも approach にも影響しない
