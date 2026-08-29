## Why

取込明細（`raw_transactions`）だけが会計年度に閉じていない。仕訳帳も確認待ち draft も
`withOpenYear` 経由で開いている会計年度1つに限定される（`packages/server/src/http/api.ts:324,518`）のに、
`listRawTransactions(db, status?)`（`packages/server/src/import/rawStatus.ts:48`）に年の条件が無い。
`raw_transactions` に `fiscal_year_id` 列は無く（`packages/server/src/db/data/schema.ts:345`）、
`executeRollover` は `fiscal_years` と `opening_balances` しか触らない（`packages/server/src/closing/rollover.ts:83`）。

そこから2つの症状が出る（#109 / #108）。

**① 一覧に過年度が混ざる。** 並びは `txn_date DESC` の `LIMIT 500`（`rawStatus.ts:37,69`）なので
過年度行は下に沈む。年300件なら2年目で600件 → 500で切られ、当年300 ＋ 前年の新しい200が
**境目の目印なく**混在する。

**② その行を「復帰」すると、自分の会計年度の範囲外の日付を持つ仕訳ができる。** エラーは出ない。

```
[復帰] ─▶ restoreRawTransaction   import/rawStatus.ts:106
         ─▶ journalizeRawById     journal/journalize.ts:217
            ─▶ journalizeRow      journal/journalize.ts:96
               └─ insert journal_entries {
                    fiscalYearId: ctx.openYearId,  ← FY2026（開いている年）
                    entryDate:    raw.txnDate,     ← 2025-08-02（raw の値をそのまま）
                  }
```

`journalizeRow` は `createManualEntry` を通さず `journal_entries` へ直接 insert しており、
手入力経路が持つ会計期間ゲート（`journal/manualEntry.ts:75`）がこの経路に無い。`buildContext`
（`journalize.ts:70`）は「開いている会計年度が存在するか」しか見ておらず、**その範囲に
`raw.txnDate` が入るかを検証していない**。EC・銀行スキルトラックの
`journalizeEcRow`（`import/ecImport.ts:199`）/ `journalizeBankRow`（`import/bankImport.ts:105`）も同じ。

できあがった仕訳は帳票間で食い違う。

| 帳票 | 集計キー | この仕訳は |
|---|---|---|
| 試算表・PL・BS | `fiscalYearId` のみ（`reports/reports.ts:134`） | **載る** |
| 推移表 | `fiscalYearId` ＋ 月バケット（`reports.ts:619`） | **黙って落ちる** |

推移表には既に防御コードがあり、`// 会計年度の月レンジ外（通常は期間ゲートで発生しない）` と
書かれている。この経路が、その「通常でない」を作れる。

取込時には期間ゲートが効く（`import/importer.ts:86` ほか）ので、過年度データを今から取り込むことは
できない。問題になるのは**当時取り込んで残ったまま繰越を跨いだ行**だけであり、繰越を1回以上した
帳簿でしか起きない。本番帳簿はまだ繰越していないため未発生 — **最初の繰越までに入れば十分**。

## What Changes

方針は一つ — **取込明細を、他の一覧と同じように会計年度に閉じる。**

- **仕訳化に会計期間ゲートを入れる（根治）**。`entry_date` が開いている会計年度の
  `[start_date, end_date]` に入らない明細は仕訳化しない。単発（復帰）は明確なエラー、
  バッチ再仕訳は**取込と同じ扱い＝件数を返してスキップ**（1件で全体を落とさない）。
  3経路（銀行/汎用・EC スキル・銀行スキル）すべてに同じゲートを当てる
- **一覧の既定を開いている会計年度に絞る**。`GET /api/raw-transactions` に年スコープを足し、
  既定＝当年度。**過年度は明示操作で表示**できる
- **黙って隠さない**。当年度に絞った結果として視界の外に出た件数を、常に返す
  （`total` と別に「過年度に N 件」）。既存の `truncated`（`LIMIT 500`）と同じ原則
- **繰越に警告を足す**。未処理（pending / ignored）の取込明細の件数を繰越の確認前に示す。
  **繰越はブロックしない**（`ignored` は利用者が意図して残す状態であり、これを塞ぐと繰越が詰まる）
- **UI で過年度行の「復帰」を無効にする**。サーバが弾く操作をボタンで誘わない

### 明示的に「消さない」

`raw_transactions` の物理削除はしない。このテーブルは2つの役割を兼ねている:

- **作業キュー**（`pending` → `journalized` / `ignored`）… 繰越後は視界から外したい
- **証跡**（`raw_payload` の原文、`journal_entry_id` の逆引き、`settlement_raw_id` の名寄せリンク）… 消してはいけない

削除すると、確定済みの過年度仕訳から元データへの逆引きが切れる。`schema.ts:372` のインデックスに
「仕訳→取込明細の逆引き（確定時の学習・**確定取消/削除時の戻し**）」とあるとおり、確定取消の
戻り先が失われる。名寄せの相手も宙吊りになる。**行は残す。一覧から外すだけ。**

## Capabilities

### New Capabilities

なし。

### Modified Capabilities

- `csv-import`: 「取込明細の状態管理」に一覧の年度スコープを加える。既定は開いている会計年度に
  閉じ、過年度は明示操作で表示できること、絞り込みで視界から外れた件数を返すことを要求に足す。
  復帰（`/restore`）が会計期間ゲートに従うことも同じ要求に含める
- `journal`: 「取込明細からの自動仕訳」に会計期間ゲートを加える。`entry_date` が開いている
  会計年度の範囲外になる明細は仕訳化しない（単発は拒否・バッチは件数を返してスキップ）
- `closing`: 「年度繰越」に未処理取込明細の件数提示を加える。繰越は拒否しない（警告のみ）
- `web-app`: 取込明細画面に年スコープの操作を加える。既定は当年度、過年度は明示操作で表示し、
  過年度の行では復帰を提供しない

## Impact

**変更するコード**

| 層 | ファイル | 変更 |
|---|---|---|
| server | `src/journal/journalize.ts` | `journalizeRow` に期間ゲート・`journalizeBatch` の戻り値に skip 件数 |
| server | `src/import/ecImport.ts` / `src/import/bankImport.ts` | `journalizeEcRow` / `journalizeBankRow` に同じゲート |
| server | `src/import/rawStatus.ts` | `listRawTransactions` に年スコープ引数・視界外件数 |
| server | `src/closing/rollover.ts` | 未処理取込明細の件数を数える（繰越はブロックしない） |
| server | `src/http/api.ts` | `GET /raw-transactions` のクエリ・繰越プレビューの警告 |
| web | `src/pages/RawTransactionsTab.tsx` | 年スコープの切替・過年度行の復帰無効化・視界外件数の表示 |
| web | `src/pages/ClosingTab.tsx` | 繰越確認前の未処理件数の提示 |
| web | `src/api.ts` | 上記の型 |

**変更しないもの**

- DB スキーマ（`raw_transactions` に `fiscal_year_id` 列は足さない。`txn_date` と
  `fiscal_years` の範囲比較で足りる。列を足すと既存行のバックフィルと二重管理が要る）
- `raw_transactions` の物理削除・繰越時の移動（証跡を切らない）
- 取込時の会計期間ゲート（`importer.ts` ほか。既に正しく効いている）
- 名寄せ（`settlement`）の候補提示範囲（別の一覧・別の判断）

**受入基準**

繰越を1回実行した帳簿で、前年度の pending / ignored 明細が (1) 既定の一覧に出ない、
(2) 明示操作で出したとき復帰できない、(3) API を直接叩いても範囲外の `entry_date` を持つ
仕訳が作られない、(4) 隠れた件数が画面に出る。
