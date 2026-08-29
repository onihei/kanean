# Design — acquisition-partial-recovery

## Context

動機は proposal.md「Why」を参照。現状の関連コード:

- `packages/acquisition/src/sites/amazon.mjs` — 注文単位の失敗を `failedOrders`（`{orderId, orderDate, reason}`）
  に積み、`ScrapeResult.partial = failedOrders.length > 0` を返す。注文は**古い順**に処理する（watermark 規約）。
- `packages/server/src/acquisition/jobs.ts` — `runImport` は `scrape.orders` / `scrape.warnings` だけを使い、
  `failedOrders` を捨てている。`describe(counts)` のメッセージにも出ない。
  `advanceIfContinuous` は `result.partial` なら watermark を一切前進させない。
- `packages/server/src/acquisition/watermark.ts` — `advanceWatermark` は「穴を作る前進はしない」ガードを持つ
  （`fetched.since > nextDay(current)` / `fetched.until <= current` なら前進しない）。
- `packages/server/src/acquisition/range.ts` — 次回の既定起点は `watermark+1日 → fetchSince → 期首`。
  `fetchSince`（`ecServices.accountTimeline`）は「取込済み明細の最大 txn_date」なので、
  watermark 不在の部分失敗後はここが失敗注文を飛び越える（＝恒久化の穴）。
- `packages/web/src/components/AcquisitionPanel.tsx` — `counts.warnings` が非空なら一覧表示する（既存）。

## Goals / Non-Goals

**Goals**

- partial の失敗内容（件数・注文ID・日付・理由）をジョブ結果と完了メッセージに出す。
- partial 時に watermark を「連続して取得できた終端」= 最初の失敗注文の前日まで前進させ、
  初回取込の部分失敗でも次回既定範囲が失敗注文を再カバーするようにする。

**Non-Goals**

- `fetchSince` フォールバック（`accountTimeline`）の変更はしない。スキル経路（`/skill/*`）が使う契約で、
  watermark が partial でも記録されるようになればアプリ経路の穴はこれで塞がるため。
- 一覧ページング途中の黙った打切り（`!cards.length` break）や一覧件数との突合など、
  **一覧レベル**の取り漏らし検知は別 change とする（failedOrders にすら乗らない層で、対策の形が別物）。
- 領収書ポップオーバーの Electron 殻での不安定さ（tasks 10.4a）自体の修理はしない。
  本 change は「失敗しても気づける・自動で再挑戦される」を保証する側。

## Decisions

### D1: 失敗件数は `ImportCounts.failed` として持ち、理由は warnings に載せる

`ImportCounts` に `failed: number` を追加し、`runImport` で
`warnings` へ `「注文 <orderId>（<orderDate>）: <reason>」` を（既存の SAMPLE 上限に合わせて）積む。
`describe` は failed > 0 のとき「うち M 件は取得できず（再実行で再取得を試みます）」を末尾に足す。

- 代替案: warnings だけに載せて件数を持たない → 件数は UI とテストの一次情報なので独立フィールドが正。
- 代替案: JobView に `failedOrders` 配列をそのまま生やす → UI に新しい表示部品が要る。
  既存の warnings 一覧で理由まで見えるので、最小の形（件数 + warnings）で足りる。
- 互換性: `counts` は jobs JSON（`$DATA_DIR/acquisition/jobs/*.json`）に永続化される。
  旧レコードに `failed` が無いのは `?? 0` で読む（migration 不要）。

### D2: 連続終端の計算は jobs.ts（殻の外）で行う

`advanceIfContinuous` を拡張し、partial のときは
`until' = prevDay(min(failedOrders.orderDate))` として `advanceWatermark(…, {since, until: until'})` を呼ぶ。
`until' < since`（最初の失敗が範囲先頭）なら呼ばない。成功注文 0 件でも同様に呼ばない。

- サイトモジュール（amazon.mjs 等）に `contiguousUntil` を計算させる案もあるが、
  「古い順に処理する」規約と `failedOrders.orderDate` から**一意に導出できる**ので、
  各サイトに重複実装させず jobs.ts 一箇所に置く。銀行/カードが将来 partial を作る場合も同じ規則に乗る。
- `advanceWatermark` の既存ガード（穴を作らない・後退しない）はそのまま効くので、
  境界（`until' <= current` 等）の防御は増やさない。
- `prevDay` は `watermark.ts` に `nextDay` の対として追加する。

### D3: 「同日に成功と失敗が混在」は失敗側に倒す

`min(failedOrders.orderDate)` の前日まで、なので同日の成功注文分も次回範囲に含まれ再取得される。
dedup（`dedup_hash` + `onConflictDoNothing`）が吸収するため二重計上は起きない。
1 日ぶん余計に取り直す代わりに、取りこぼしゼロを優先する。

### D4: rangeLimited と partial の複合は「前進しない」を維持

人が範囲を限った取得（rangeLimited）は現行どおり一切前進させない。
D2 の連続終端前進は rangeLimited でない実行にだけ適用する（`advanceIfContinuous` の早期 return 順を保つ）。

## Risks / Trade-offs

- [warnings が SAMPLE 上限で切れて失敗理由が全件見えない] → 件数は `failed` で正確に出る。
  上限超過時は「ほか N 件」を warnings 末尾に足す。
- [同じ注文が恒久的に失敗し続けると、watermark がその手前で止まり続ける] → 意図した動作
  （取りこぼしを黙って確定させない）。UI に失敗理由が毎回出るので、人が範囲限定取得や
  スキル経路（MCP 補完）へ逃がす判断ができる。
- [失敗理由文字列に品名等が混ざる可能性] → failedOrders.reason は構造変化の診断文で品目情報を含まない
  （注文IDと日付のみ）。現状の生成箇所を確認済み。新たな露出は増やさない。

## Migration Plan

- データ migration なし（jobs JSON は追記フィールドのみ、watermarks.json は形式不変）。
- デプロイ後、過去に初回部分失敗で穴が空いている帳簿があれば、since を期首に指定した
  範囲取得で回復できる（dedup が重複を吸収）。本 change の UI 文言がその導線になる。

## Open Questions

（なし）
