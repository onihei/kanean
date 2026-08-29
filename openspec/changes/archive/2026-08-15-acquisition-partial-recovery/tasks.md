# Tasks — acquisition-partial-recovery

## 1. サーバ: 失敗の可視化（counts / message）

- [x] 1.1 `types.ts` の `ImportCounts` に `failed: number` を追加し、既存の生成箇所（`runImport` / `empty`）と
      jobs JSON の読み込みで欠損を `?? 0` で吸収する
- [x] 1.2 `jobs.ts` の `runImport` で `scrape.failedOrders` を消費する:
      `failed = failedOrders.length`、warnings へ「注文 <orderId>（<orderDate>）: <reason>」を
      SAMPLE 上限まで積み、超過分は「ほか N 件」を1行足す
- [x] 1.3 `describe(counts)` を拡張し、`failed > 0` のとき
      「うち M 件は取得できず（再実行で再取得を試みます）」を完了メッセージに含める
- [x] 1.4 `jobs.test.ts` に partial 結果のテストを追加:
      failed 件数・warnings の内容・メッセージ文言・全件成功時に失敗表示が無いこと

## 2. サーバ: 連続終端までの watermark 前進

- [x] 2.1 `watermark.ts` に `prevDay` を追加（`nextDay` の対。UTC 日付演算で統一）
- [x] 2.2 `jobs.ts` の `advanceIfContinuous` を拡張:
      rangeLimited は現行どおり前進しない → partial かつ成功 0 件は前進しない →
      partial なら `until' = prevDay(min(failedOrders.orderDate))` を計算し、
      `until' >= since` のときだけ `advanceWatermark(…, {since, until: until'})` を呼ぶ →
      partial でなければ現行どおり全範囲で前進
- [x] 2.3 テスト追加（`jobs.test.ts` または watermark テスト）:
      初回取込（watermark 無し）の partial で watermark が「最初の失敗の前日」になること／
      次回 `resolveRange` の既定 since が失敗注文の日付を含むこと（fetchSince へ飛ばないこと）／
      最初の失敗が範囲先頭なら前進しないこと／同日に成功と失敗が混在しても失敗側に倒れること

## 3. Web UI

- [x] 3.1 `api.ts` の counts 型に `failed` を追加
- [x] 3.2 `AcquisitionPanel.tsx` の `Counts` に「取得できず M 件」を追加し、
      failed > 0 のとき再実行で再取得を試みる旨の一行を出す（理由一覧は既存の warnings 表示を使う）

## 4. 検証

- [x] 4.1 `pnpm build && pnpm test && pnpm lint && pnpm typecheck` を通す
- [x] 4.2 scratch DATA_DIR + フィクスチャで partial ジョブを再現し、
      Electron/web の画面に失敗件数・理由・メッセージが出ること、watermarks.json が
      「最初の失敗の前日」を指すことを目視確認する
