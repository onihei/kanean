## 1. 会計期間ゲートの共有（D1）

- [x] 1.1 `packages/server/src/journal/fiscalPeriod.ts` を作り、`isInFiscalPeriod(fy, date)` と
      `assertInFiscalPeriod(fy, date, label)`（範囲外は `OutOfFiscalPeriodError`）を置く。判定は
      ISO 日付の辞書順比較（既存の3箇所と同じ方式）で、日付と範囲を含む日本語メッセージを持たせる
- [x] 1.2 `packages/server/src/journal/manualEntry.ts:75` の期間判定を 1.1 の関数に置き換える
      （メッセージは既存の文言と等価に保ち、既存テストを壊さない）
- [x] 1.3 `packages/server/src/__tests__/` に 1.1 の単体テストを追加する
      （範囲内・期首ちょうど・期末ちょうど・前年・翌年）

## 2. 仕訳化の3経路にゲートを当てる（D1・D2）

- [x] 2.1 `journal/journalize.ts` の `journalizeRow` 先頭で `assertInFiscalPeriod` を呼ぶ。
      `JournalizeContext` に open 年度の `startDate` / `endDate` を持たせる（`buildContext` で解決済み）
- [x] 2.2 `journalizeBatch` を、pending 行を範囲内/範囲外に振り分けてから範囲内だけ仕訳化する形にする。
      戻り値 `JournalizeSummary` に `skippedOutOfPeriod` を足す（例外でループを中断しない）
- [x] 2.3 `import/ecImport.ts` の `journalizeEcRow` 先頭に同じゲートを入れる
      （`open` は解決済み。`journalizeEcAdjustment` へ委譲する前に判定する）
- [x] 2.4 `import/bankImport.ts` の `journalizeBankRow` 先頭に同じゲートを入れる
- [x] 2.5 `import/rawStatus.ts` の `restoreRawTransaction` で、`pending` へ更新する**前に**
      期間を検査して弾く（既存の try/catch ロールバックは二重の壁として残す）
- [x] 2.6 `http/api.ts` の `POST /raw-transactions/:id/restore` が期間外を 400 と日本語メッセージで
      返すことを確認する（既存の catch で足りるはず。足りなければ整える）
- [x] 2.7 テスト: 繰越後に前年度の `ignored` を復帰しようとすると 400 で状態が `ignored` のまま、
      仕訳が1件も増えないことを確認する（`packages/server/src/import/__tests__/`）
- [x] 2.8 テスト: EC・銀行スキルの raw でも同じく拒否されること
      （`import/__tests__/ecImport.test.ts` / `bankImport.test.ts` に追加）
- [x] 2.9 テスト: `journalizeBatch` に範囲内・範囲外が混在する場合、範囲内は仕訳化され
      `skippedOutOfPeriod` に件数が入ること

## 3. 一覧の年スコープ（D3）

- [x] 3.1 `import/rawStatus.ts` の `listRawTransactions` を
      `(db, opts: { status?, years?: 'open' | 'all' })` に変え、既定で open 年度の
      `[start_date, end_date]` に `txn_date` が入る行だけを返す
- [x] 3.2 戻り値に `outOfYearTotal`（同じ status でスコープ外にある件数）を足す。
      `years='all'` および open 年度が無いときは 0、その場合は絞り込みも行わない
- [x] 3.3 `http/api.ts` の `GET /raw-transactions` に `years` クエリを足す
      （`all` のみ受理、それ以外・未指定は `open` 扱い）。レスポンスに `outOfYearTotal` を含める
- [x] 3.4 テスト: 繰越後の帳簿で既定が当年度だけを返し、`outOfYearTotal` が前年度の件数と一致すること。
      `years=all` で全件返り `outOfYearTotal` が 0 になること。open 年度が無ければ全件返ること

## 4. 繰越前の警告（D4）

- [x] 4.1 `closing/rollover.ts` に当期の未処理取込明細を数える read-only 関数を足す
      （`pending` / `ignored` の内訳。当期＝open 年度の日付範囲）
- [x] 4.2 `http/api.ts` に `GET /closing/rollover/precheck` を足し
      `{ unprocessedRaw: { pending, ignored } }` を返す。`executeRollover` の契約は変えない
- [x] 4.3 テスト: 未処理が残っていても `POST /closing/rollover` が成功すること（警告はブロックしない）

## 5. UI（D6）

- [x] 5.1 `packages/web/src/lib/format.ts` に `inScope(iso, fy: DateScope): boolean` を出し、
      `listDate` をそれ経由にする（判定式を1つにする）。テストを追加する
- [x] 5.2 `packages/web/src/api.ts` の `rawTransactions` に `years` 引数と `outOfYearTotal` を足す。
      `rolloverPrecheck` を足す
- [x] 5.3 `RawTransactionsTab` に「過年度も表示」のチェックボックスを状態フィルタの隣に置き、
      `years=all` を切り替える
- [x] 5.4 `RawTransactionsTab` で `outOfYearTotal > 0` のとき「他の年度に N 件」を件数表示の並びに出す
      （0 のときは何も出さない）
- [x] 5.5 `RawTransactionsTab` の「復帰」を、行が開いている会計年度の範囲外なら `disabled` にし、
      `title` に理由（会計年度の範囲外・繰越取消か手入力が要る旨）を入れる
- [x] 5.6 `ClosingTab` の繰越パネルで `rolloverPrecheck` を引き、0件でなければ確認の前に
      「当期に未処理の取込明細が N 件（未仕訳 M / 除外 K）」を出す。繰越ボタンは無効化しない

## 6. ドキュメントと受入確認

- [x] 6.1 `docs/` の該当箇所（`data-model.md` の raw ライフサイクル・`csv-format.md` C-8 の
      期間ゲートの記述）に、仕訳化にも同じゲートが効くことを追記する
- [x] 6.2 `pnpm lint` / `pnpm typecheck` / `pnpm test` を通す
- [x] 6.3 検証用の帳簿（`DATA_DIR` を分けたコピー）で繰越を1回実行し、前年度の pending / ignored が
      (1) 既定の一覧に出ない (2) 「過年度も表示」で出したとき復帰が押せない
      (3) `curl` で `/restore` を叩いても 400 (4) 隠れた件数が画面に出る、を確認する
- [x] 6.4 GitHub issue #108 / #109 に対応内容を書いて閉じる
