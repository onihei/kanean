# 官製様式PDF（青色申告決算書 一般用）

`aoiro_r05.pdf` は国税庁「所得税青色申告決算書（一般用）令和5年分以降用」の **提出用4ページ**
（p1 損益計算書 / p2 月別売上仕入・各種内訳・特別控除額の計算 / p3 売上仕入明細・減価償却費の計算 /
p4 貸借対照表）。pdf-lib で座標オーバーレイ（金額差込）するテンプレートとして同梱する。

## 出典・ライセンス
- 出典: 国税庁 https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r05/10.pdf
- 国税庁の様式は政府標準利用規約に準じ、出典明示で複製・改変・再配布可。
- 様式は令和5年分以降共通。年度様式が変わったら下記手順で差し替える。

## 再生成手順
配布PDFは **暗号化（/Encrypt）＋圧縮xref** で pdf-lib が直接読めないため、ghostscript で
復号・正規化し提出用4ページを抽出する（控用5〜8ページは除外）。

```sh
curl -fsSL -o /tmp/aoiro_form.pdf \
  https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r05/10.pdf
gs -q -o packages/server/assets/forms/aoiro_r05.pdf -sDEVICE=pdfwrite \
  -dCompatibilityLevel=1.4 -dFirstPage=1 -dLastPage=4 /tmp/aoiro_form.pdf
```

正規化済みPDFをリポジトリに同梱するため、**本番・CI に ghostscript は不要**（再生成時のみ必要）。
座標定義は `src/pdf/templates/aoiroOverlay.ts`。

---

# 官製様式PDF（確定申告書 第一表・第二表 一般用）

`kakutei_r05.pdf` は国税庁「申告書第一表・第二表【令和5年分以降用】」の **提出用2ページ**
（p1 第一表 / p2 第二表）。控用（3〜4ページ・モノクロ）は除外。pdf-lib で座標オーバーレイする
テンプレートとして同梱する。

## 出典・ライセンス
- 出典: 国税庁 https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r05/01.pdf
- 政府標準利用規約に準じ、出典明示で複製・改変・再配布可。様式は令和5年分以降共通。

## 再生成手順
配布PDFは暗号化（/Encrypt）されており pdf-lib が直接読めないため、ghostscript で復号・正規化し
提出用2ページを抽出する。

```sh
curl -fsSL -o /tmp/shinkoku_form.pdf \
  https://www.nta.go.jp/taxes/shiraberu/shinkoku/yoshiki/01/shinkokusho/pdf/r05/01.pdf
gs -q -o packages/server/assets/forms/kakutei_r05.pdf -sDEVICE=pdfwrite \
  -dCompatibilityLevel=1.4 -dFirstPage=1 -dLastPage=2 /tmp/shinkoku_form.pdf
```

座標定義は `src/pdf/templates/kakuteiOverlay.ts`。万円単位の事前印字（0000）欄は value/10000 を
0000 の左へ右寄せ記入する（基礎控除㉔・扶養控除㉓）。扶養控除㉓には配偶者・扶養の lump 値を寄せる
（細目区別は未対応）。万円の倍数でない値は安全側でスキップ。事前印字のない欄は社保⑬/生命⑮/医療㉗。

---

# 官製様式PDF（消費税及び地方消費税確定申告書 簡易課税用 第一表）

`shohi_kani_r05.pdf` は国税庁「消費税及び地方消費税確定申告書（簡易課税用）」の **提出用 第一表 1ページ**
（控用は除外）。pdf-lib で座標オーバーレイするテンプレートとして同梱。

## 出典・ライセンス
- 出典: 国税庁 https://www.nta.go.jp/taxes/tetsuzuki/shinsei/shinkoku/shohi/yoshiki01/18.pdf
- 政府標準利用規約に準じ、出典明示で複製・改変・再配布可。

## 再生成手順
```sh
curl -fsSL -o /tmp/shohi_form.pdf \
  https://www.nta.go.jp/taxes/tetsuzuki/shinsei/shinkoku/shohi/yoshiki01/18.pdf
gs -q -o packages/server/assets/forms/shohi_kani_r05.pdf -sDEVICE=pdfwrite \
  -dCompatibilityLevel=1.4 -dFirstPage=1 -dLastPage=1 /tmp/shohi_form.pdf
```

座標定義は `src/pdf/templates/shohiOverlay.ts`。国税①〜⑪・地方（差引税額の基礎/譲渡割/納付）・合計60を記入。
事業区分別売上・付表4-3/5-3 は対象外（簡易課税の単一区分前提・数値層の制約を踏襲）。
