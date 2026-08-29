## 1. 日付整形（D1）

- [x] 1.1 `packages/web/src/lib/format.ts` に一覧用の日付整形を追加する。開いている会計年度の
      範囲を受け取り、範囲内なら `MM-DD`、範囲外なら `YYYY-MM-DD` を返す純関数にする
- [x] 1.2 `packages/web/src/__tests__/` に上記のテストを追加する（範囲内・範囲外・境界日
      = 期首と期末ちょうど・会計年度が未取得のときのフォールバック）
- [x] 1.3 開いている会計年度を `ServicesTab` / `RawTransactionsTab` から参照できるようにする
      （`Workbench` の `openFy` を props で流すか、各タブで `api.fiscalYears()` を使うかを決めて統一する）

## 2. draft 一覧の行レイアウト（D2）

- [x] 2.1 `ConfidenceBadge` から `確信度: ` の前置きを外し、色と `高`/`中`/`低` のみにする。
      `title` の証跡は現状のまま残す
- [x] 2.2 `借 ¥3,280（相手: 普通預金）` を符号付き金額の右寄せ固定幅に置き換える
      （出金 `−` / 入金 `+`、`fontVariantNumeric: 'tabular-nums'`）。相手科目はサービス見出しに
      既出のため行から落とす
- [x] 2.3 `DraftRow` の日付を 1.1 の整形関数経由にする
- [x] 2.4 税区分 select と税額を従属行（根拠行）へ移す。従属行は `origin.reason` の有無に関わらず、
      税区分を表示する必要があるときは出す（design D2 の既定）
- [x] 2.5 主行から `flexWrap: 'wrap'` を外し、折り返さない構成にする。従属行のインデントを
      主行のチェックボックス＋日付の幅に合わせ、全行で同じ位置から始まるようにする

## 3. select の幅（D3）

- [x] 3.1 `packages/web/src/lib/styles.ts` に固定幅 select の共有スタイルを追加する
- [x] 3.2 `DraftRow` の勘定科目 select と税区分 select に適用する。選択中の値が切れうるため
      `title` に選択中のラベルを入れる

## 4. 取込明細のテーブル（D4）

- [x] 4.1 `RawTransactionsTab` のテーブルを `table-layout: fixed` にし、`<colgroup>` で
      日付・口座/形式・摘要・金額・状態・操作の各列幅を宣言する
- [x] 4.2 `packages/web/src/lib/styles.ts` に省略セル（`nowrap` + `overflow: hidden` +
      `textOverflow: 'ellipsis'`）の共有スタイルを追加し、摘要セルに適用する。`title` に全文を入れる
- [x] 4.3 取込明細の日付を 1.1 の整形関数経由にする（過年度の行は年付きで出る）

## 5. 幅の上限（D5）

- [x] 5.1 `packages/web/src/App.tsx:211` の `maxWidth: 1120` を引き上げる。
      **これを戻しても 6.1 が通ることを確認する**（既定サイズでの受入は maxWidth に依存しない）

## 6. 受入確認

- [x] 6.1 既定ウィンドウ 1280×860 で `pnpm --filter @kanean/desktop start` し、連携サービスの
      draft 一覧と取込明細のどの行も意図しない折り返しを起こさないことを目視で確認する
- [x] 6.2 draft 一覧で、提案理由・確信度・証跡参照がすべて確認できることを確認する
      （[[web-app]]「例外ベースの取込レビュー」の要求を落としていない）
- [x] 6.3 取込明細で摘要が切り詰められた行の全文が `title` で読めること、行高が一定であることを確認する
- [x] 6.4 `pnpm lint` / `pnpm typecheck` / `pnpm test` を通す
