## 1. 決めること（実装前）

- [x] 1.1 取り込みの入口 → **API＋UI のみ**（`POST /api/import` ＋ 設定→データ管理）。CLI は作らない。
      取り込みの局面でアプリは起動する（空帳簿しか無いだけ）ので、停止中運用の `restore` とは要件が違う。design.md §4
- [x] 1.2 `bookId` 衝突時の既定 → **`bookId` は保持**し、衝突時のみ **409 で中止**して
      `?mode=new`（別 ULID で新規）／`?mode=replace`（明示的に置換）を利用者が選ぶ。
      [docs/roadmap.md] の帳簿受け渡しプロトコル（封筒に `book_id` を焼き込んで取り違えを防ぐ）と整合。design.md §5

## 2. 現状の固定（回帰を作る）

- [x] 2.1 往復（エクスポート → 別 `$DATA_DIR` へ取り込み → 帳簿一覧・固定資産・証憑が一致）を
      `ops/__tests__/importBook.test.ts` で固定。「取り込んだ帳簿は再起動後も残り、空の帳簿を新規作成しない」が
      §7.5 の失敗そのものの回帰テスト
- [x] 2.2 `ensureAtLeastOneBook` が control plane のみを見ている契約を
      `books/__tests__/resolve.test.ts`「data plane のファイルが在るだけでは帳簿と見なさない」で明示

## 3. 取り込みの実装

- [x] 3.1 zip を読み `manifest.json` を検証する（`format` / `formatVersion` / 必須フィールド）
      … `ops/importBook.ts` `readManifest`。zip リーダは `ops/zip.ts` `openZip`（自前・STORE＋DEFLATE）
- [x] 3.2 `database.sha256` と実体を突合し、不一致なら中止して理由を返す（既存帳簿に触れない）
- [x] 3.3 `PRAGMA integrity_check` を通してから配置する（`ops/restore` と同じ流儀）
      … あわせて配置前に `migrateBookDb` も通す（旧バージョンの zip をスキーマ更新失敗のまま置かない）
- [x] 3.4 control plane へ帳簿を登録し、data plane を `books/{bookId}.sqlite` へ配置する
- [x] 3.5 証憑（`books/{bookId}/attachments/**`）を配置する
- [x] 3.6 `bookId` 衝突時の扱いを 1.2 の決定どおりに実装する（黙って上書きしない）
      … レジストリに無くても data plane ファイルが在る場合も踏まない
- [x] 3.7 途中で失敗したときに中途半端な状態を残さない
      … 全て `$DATA_DIR/tmp/` で組み立てて検証し、通ったものだけを rename で配置。
      置換は `pre-import-{stamp}/` へ退避してから行い、配置に失敗したら退避物を戻す
      （退避と巻き戻しは spec のシナリオとして固定し、`fs.renameSync` を1回だけ失敗させる
      テストで裏付ける。巻き戻しを外すとそのテストが落ちることも確認済み）。
      置換前に `DbRouter.closeBook` で接続を閉じる（開いた DB の下でファイルを差し替えると WAL が破損する）

## 4. 導線

- [x] 4.1 `POST /api/import`（`http/import.ts`）。**`withBook` と `bodyLimit` より前**にマウント＝
      帳簿の指定を要さず、証憑込みの大きな zip も通る（生ボディをディスクへストリーム）
- [x] 4.2 設定→データ管理にエクスポートと並べて配置し、
      「いま開いている帳簿は書き換わらない」「巻き戻し（restore）とは用途が別」を画面上に明記

## 5. 確認

- [x] 5.1 エクスポート → 別 `$DATA_DIR` へ取り込み → 帳簿一覧・固定資産が一致することを**2プロセスで実測**
      （§7.5 の失敗経路そのもの。`GET /api/fixed-assets` にマツダ2 が償却計算つきで現れる）
- [x] 5.2 証憑つきで往復し、取り込み後に配置されていることを確認（30MB＋日本語名。bodyLimit 25MB 超も通る）
- [x] 5.3 壊した zip（sha256 不一致・manifest 欠損・zip でない・integrity NG）で中止し、既存帳簿が無傷
- [x] 5.4 `bookId` 衝突時に 409 で中止し、黙って上書きされない
- [x] 5.5 `pnpm build` / `test`（569 passed）/ `lint` / `typecheck` が緑
- [x] 5.6 `restore` CLI が従来どおり動く（取り込んだ帳簿込みで backup → restore --apply → 両帳簿が健在）

## 6. ドキュメント

- [x] 6.1 [docs/architecture.md] §11.1「持ち出し」と「巻き戻し」は別物（対照表・control を入れない理由・
      孤児ファイルを自動登録しない理由）。§4 のデータ配置に `pre-import-{timestamp}/` を追記
- [x] 6.2 [docs/roadmap.md] Phase 5 slice11 に復元可能性の成立を追記し、デスクトップ化の「派生」を対応済みに更新
