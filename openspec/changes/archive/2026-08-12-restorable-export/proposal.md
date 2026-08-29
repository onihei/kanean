## Why

**フルデータエクスポートした zip を、実際には復元できない。**

`electron-desktop-shell` の回帰確認（§7.5）で実測して判明した。zip の中身は
`manifest.json` ＋ `books/{bookId}.sqlite` だけで、**帳簿レジストリを持つ control plane を含まない**。
そのため解凍して `books/` を別環境の `$DATA_DIR` に置いても:

```
books/{id}.sqlite を配置
      ↓
control.sqlite の books テーブルに登録が無い
      ↓
ensureAtLeastOneBook が「帳簿0冊」と判断して新しい空帳簿を作る
      ↓
エクスポートした帳簿は画面から**不可視**（ファイルは在るのに開けない）
```

孤児の `books/*.sqlite` を拾う仕組みは存在しない（`listBookDbFiles` を使うのは `migrate.ts` と
`ops/backup.ts` だけで、帳簿解決の経路にはいない）。

これは [[data-ops]] の既存シナリオ「**セルフホストへそのまま復元できる形にする**」に反する。
そして単なる仕様不整合ではなく、**「解約＝データ人質にしない」という製品の柱そのものが
機能していない**ことを意味する（[docs/roadmap.md] Phase 5 slice11）。データは手元にあるのに
自分のアプリで開けないなら、エクスポートは実質的な保険になっていない。

利用者の環境で**データが失われる不具合ではない**（エクスポート元は無傷）が、
いざ復元が必要になった局面で初めて露見する種類の欠陥なので、その前に直す。

## What Changes

- **取り込み（インポート）経路を用意する**。エクスポート zip を受け取り、
  帳簿として登録した上で data plane を配置する。`manifest.json` は既に `bookId` / `bookName` /
  `database.sha256` / `byteSize` を持っており、登録に必要な情報は揃っている。
- **`sha256` を検証してから配置する**（壊れた zip を黙って取り込まない）。
- **bookId の衝突を扱う**。同じ `bookId` が既に登録済みの場合に黙って上書きしない
  （復元は「新しい帳簿として取り込む」か「明示的な置換」かを区別する）。
- **`restore` CLI との役割を整理する**。既存の restore はバックアップ世代（control 込みの
  スナップショット）を戻すものであり、**別環境への持ち出し**とは用途が異なる。両者を混同させない。

### Non-goals

- バックアップ／世代管理（`ops/backup.ts`・`restore` CLI）の仕様変更。あれは control 込みなので現状で機能している。
- 帳簿のマージ。取り込みは帳簿単位であり、既存帳簿への合流は扱わない。
- 証憑を含まないエクスポートの互換性維持以外の、zip フォーマットの拡張。

## Capabilities

### Modified Capabilities

- `data-ops` — 「セルフホストへそのまま復元できる形にする」が現状の実装で満たされていない。
  エクスポートの復元可能性を、**取り込み経路の存在**として要件化し直す。

## Impact

- `packages/server/src/ops/exportBook.ts`（エクスポート側。manifest は概ね流用可）
- 取り込み処理の新設（control plane への帳簿登録 ＋ data plane 配置 ＋ `integrity_check`）
- `packages/server/src/books/resolve.ts`（`ensureAtLeastOneBook` との関係整理）
- UI（設定 → データ管理。エクスポートの隣に取り込み導線）
- [[data-ops]] spec

## 発見の経緯

`electron-desktop-shell` §7.5 で、エクスポート zip を解凍して別 `$DATA_DIR` に置き、
`pnpm --filter @kanean/server start` で開いたところ、**新しい空帳簿（別 ULID）が作られ、
エクスポートした固定資産・仕訳が一切見えなかった**。本 change の作業対象はこの1点である。
