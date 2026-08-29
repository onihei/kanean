# acquisition-partial-recovery — 部分失敗の可視化と取りこぼしの自動回復

## Why

EC 取込（Amazon 等）では、注文単位の取得失敗（請求書PDFリンクが現れない・突合NG・PDF取得失敗 等）を
`failedOrders` として記録し部分成功（partial）にする設計だが、**その情報がジョブ結果のどこにも出ない**。
ジョブは `done`・「N 件を取り込みました」と成功表示になり、人は失敗に気づけない（「黙って落とさない」
規約と、acquisition spec「不一致を警告として残す」に反する）。

さらに watermark（連続取得の終端）は partial では前進しないが、**初回一括取込**（watermark 未設定）で
部分失敗すると、差分起点のフォールバック `fetchSince` が「取込済み明細の最大日付」へ飛ぶため、
失敗した古い注文を既定範囲が二度とカバーしない。次の完走で watermark が終端まで進み、**穴が恒久化する**。
実際に Electron 殻では領収書ポップオーバーの不安定（22注文中14件しか通らなかった実測）が既知で、
このシナリオは現実に踏み得る。

## What Changes

- **部分失敗の可視化**: partial のとき、取得できなかった注文の件数と理由（注文ID・注文日付き）を
  ジョブ結果（counts）に含め、完了メッセージにも「うち M 件は取得できず（再実行で再取得を試みます）」を出す。
  UI は既存の警告表示欄で理由一覧を見せる。
- **連続終端の正確な記録**: 巡回は古い順処理が規約なので、partial のときは watermark を
  「**最初に失敗した注文の日付の前日**」まで前進させる（現行は一切前進しない）。
  これにより watermark 未設定の初回取込で部分失敗しても、次回の既定範囲が失敗注文を含んで再カバーする。
  取込済み分は dedup で重複スキップされるため再カバーは安全。
- 成功注文が 0 件の partial、および失敗注文が範囲先頭に位置し前進の余地が無い場合は、前進させない（現行維持）。

## Capabilities

### New Capabilities

（なし）

### Modified Capabilities

- `acquisition`:
  - 「長時間ジョブとしての進行」— 完了時、取得できなかった明細（注文）の件数と理由を結果に示す。
  - 「取得範囲と取りこぼしの防止」— 部分成功時の差分起点は「連続して取得できた終端」まで前進し、
    失敗した明細が次回の既定範囲に残ることを保証する。

## Impact

- `packages/server/src/acquisition/jobs.ts` — `runImport`（failedOrders → counts へ）、`describe`（メッセージ）、
  `advanceIfContinuous`（partial 時の連続終端前進）。
- `packages/server/src/acquisition/types.ts` — `ImportCounts` に失敗件数を追加。
- `packages/server/src/acquisition/watermark.ts` — 前進ガードは現行のまま利用（穴を作る前進はしない）。
- `packages/acquisition`（ScrapeResult）— `failedOrders`（orderId / orderDate / reason）は既にあり、変更なし。
- `packages/web/src/components/AcquisitionPanel.tsx` — counts.warnings 表示は既存。失敗件数の一行を追加。
- 銀行/カード経路 — 現状 partial を作る実装は無いが、同じ規則（失敗地点の手前まで前進）を共通処理に置く。
- `fetchSince` フォールバック（`ecServices.accountTimeline`）自体は変更しない（スキル経路が利用）。
  watermark が partial でも記録されるようになるため、アプリ経路でこのフォールバックが穴を作る余地が消える。
