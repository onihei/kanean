# アーキテクチャ設計書 — Kanean

> [PRD.md](./PRD.md) / [data-model.md](./data-model.md) を実装する技術設計。
> 既存プロジェクト（`../nasbi` `../kaeru`）の構成を踏襲し、DX を統一する。

---

## 1. 技術選定（確定）

| 領域 | 採用 | 理由 |
|---|---|---|
| 言語 | **TypeScript（strict, ESM）** | 既存DX統一。strict型＋規律で金融系の「固さ」を確保 |
| モノレポ | **pnpm@10 + turbo** | nasbi/kaeru踏襲 |
| サーバ | **Hono + @hono/node-server** | nasbi/kaeru踏襲。軽量・型安全 |
| Web | **React 18 + Vite** | nasbi/kaeru踏襲。状態は React 標準（useState/useSyncExternalStore）で足りており外部ストアは持たない |
| DBアクセス | **Drizzle ORM + better-sqlite3** | TSスキーマ・型安全・マイグレーション生成。per-user SQLiteに最適 |
| テスト | **vitest** | nasbi/kaeru踏襲。会計計算はゴールデンテスト |
| 規約 | eslint9 flat + prettier、openspec（仕様駆動） | 既存踏襲 |
| バリデーション | **zod**（API境界） | 入力検証・型生成 |

> 金融系の「固さ」は言語でなく **(1)計算の正確性=テスト (2)整合性=トランザクション/制約 (3)金額=整数規律** で担保（§7）。

---

## 2. モノレポ構成

```
kanean/
├ package.json            (turbo scripts)
├ turbo.json
├ pnpm-workspace.yaml     packages/*
├ tsconfig.base.json
├ openspec/               仕様駆動（既存踏襲）
├ docs/                   本設計群
└ packages/
   ├ shared/      @kanean/shared      : DTO型・enum・API/プロセス間契約（server⇔web⇔desktop⇔mcp で共有）
   ├ core/        @kanean/core        : ★会計ドメイン（純関数・I/Oなし・高被覆テスト）
   ├ server/      @kanean/server      : Hono API・DBルーティング・帳票生成・バックアップ
   ├ web/         @kanean/web         : React + Vite SPA
   ├ acquisition/ @kanean/acquisition : 巡回コア（sites=巡回手順の唯一の実体＋playwright/electron の2実行殻。§9）
   ├ desktop/     @kanean/desktop    : Electron シェル（カスタムプロトコル配信・unix socket。§12.0）
   └ mcp/         @kanean/mcp        : MCP ブリッジ（.mcpb 同梱配布。unix socket 経由で server の API を呼ぶ）
```

依存方向（一方向のみ）:
```
web / core ─→ shared
server ─→ core / shared / acquisition（巡回の宣言。実行殻は desktop が差し込む）
desktop ─→ server / acquisition / shared
mcp ─→ shared（＋server の型のみ）
server ─→ (drizzle, better-sqlite3, hono)
```
- **core は I/O を持たない**（DB/HTTP/ファイル禁止）。入力＝数値・区分、出力＝計算結果のみ。最重要資産なので隔離して徹底テスト。
- shared は型＋小さな純粋実装（`Yen`・CSV・アプリリンク。Node 依存は `./node` サブパスに隔離）。web は server の API を shared 型経由で呼ぶ。

---

## 3. レイヤリング（server内）

```
HTTP (Hono routes)
  └ handlers      … zod検証・DTO変換
      └ services  … ユースケース（取込→仕訳、決算、帳票生成）。トランザクション境界
          ├ core      … 純粋計算（税・償却・残高）
          └ repositories … Drizzle経由のDBアクセス（control/data plane）
```
- **トランザクション境界は service 層**（better-sqlite3 同期トランザクション）。
- repositories は user ごとのDB接続を受け取る（§4）。

---

## 4. データアーキテクチャ実装（2層＋ルーティング）

[data-model §1/§2] の control plane / data plane を物理分離。

```
$DATA_DIR/
  control.sqlite              … books（帳簿レジストリ・archived_at）/ backup_status / app_settings（アプリモード）
  books/{book_id}.sqlite      … 会計データ一式（帳簿ごと）
  books/{book_id}/attachments/… 証憑ファイル（Phase5 slice8・DBと並ぶper-book隔離）
  backups/{timestamp}/        … WAL整合スナップショット（control + 全 books/*.sqlite + attachments。Phase5 slice10）
  pre-restore-{timestamp}/    … restore --apply が現行データを退避した先（確認後に手動削除）
  pre-import-{timestamp}/     … 取り込み（--mode=replace）が置換前データを退避した先（同上）
```

- バックアップは CLI `pnpm --filter @kanean/server backup [retention]`（better-sqlite3 `.backup()`＝WAL整合オンライン・integrity_check 検証・証憑同梱・世代保持）。**月次 cron ＋ deploy 前に自動実行**（§12.3）。リストアは CLI `pnpm --filter @kanean/server restore`。メール通知・保存時暗号化は未実装（A-3 鍵管理は人間決定）。

- **配置パスは `DATA_DIR` 環境変数で外出し**（開発・本番で値だけ変える）。未設定時の既定は `./data`。
- **データはコード配下に置かない**。deploy は dist を `rm -rf`→置換するため、コード配下のDBは再デプロイで消える（§11）。
  - 開発: `DATA_DIR=./data`（リポジトリ直下、`.gitignore` 済み）。
  - 本番: `DATA_DIR=~/data/kanean`（コード `~/workspace/kanean` と物理分離。deploy が触れない永続領域）。
- WAL運用のため `*.sqlite-wal` / `*.sqlite-shm` も同ディレクトリに生成される（バックアップ対象。§10）。

### 4.1 接続ファクトリ `DbRouter`
```ts
// 概念
class DbRouter {
  private control: DrizzleDB
  private cache = new Map<string, DrizzleDB>()        // book_id -> conn (LRU)

  controlDb(): DrizzleDB { return this.control }

  bookDb(bookId: string): DrizzleDB {
    let db = this.cache.get(bookId)
    if (!db) {
      const file = `data/books/${bookId}.sqlite`
      const sqlite = new Database(file)
      sqlite.pragma('journal_mode = WAL')             // [PRD §5 WAL]
      sqlite.pragma('foreign_keys = ON')
      db = drizzle(sqlite, { schema: dataSchema })
      runDataMigrations(db)                            // 初回オープン時に最新へ
      this.cache.set(bookId, db)
    }
    return db
  }
}
```
- **クエリに帳簿の条件が不要**＝物理分離なので他帳簿への到達が構造的に起きない（[data-model M-5]）。
- 接続はLRUキャッシュ（同時オープン上限）。各帳簿は実質シングルライター＝SQLiteの得意形。

### 4.2 Drizzle スキーマ（plane別）
- `packages/server/src/db/control/schema.ts` … control plane（[data-model §1]）
- `packages/server/src/db/data/schema.ts` … data plane（[data-model §2]）
- 金額列は `integer`（円）、比率は `real`、日付は `text`（ISO8601）。

### 4.3 マイグレーション（N個DBへ適用）★最重要基盤
- control plane: 起動時に1回適用。
- data plane: **全 `books/*.sqlite` を走査して順次適用**するランナー（[data-model R-6]）。
  - `drizzle-kit generate` でSQL生成 → ランナーが各ユーザーDBへ `migrate()`。
  - 新規ユーザーは初回オープン時に最新まで適用。
  - 失敗時はそのDBをスキップ＋記録し、運用で再実行可能に。

### 4.4 標準シード
勘定科目・税区分・償却率/耐用年数表は `is_system` データとして、帳簿の新規作成時に投入（[data-model D-6], [accounting-spec], [depreciation-spec]）。

---

## 5. アクセス境界（認証は持たない）

[PRD F-AUTH]。**認証機構は存在しない**。ローカル単一ユーザーのデスクトップアプリであり、
アクセス制御は**ネットワーク到達性**そのもので行う。

```
[起動] serve({ hostname: '127.0.0.1' })   ← 唯一の防壁
  → ensureAtLeastOneBook(): アクティブが0冊なら「マイ帳簿」を1冊作成＋data plane 初期化
                            1冊以上ならそのまま（N 冊は正常。税理士が顧問先を N 冊持つ）
  → withBook(router) が対象帳簿を解決して c.set('bookId', ...) して各ハンドラへ:
      1. X-Book-Id ヘッダ            … 通常の API 呼び出し
      2. ?bookId= クエリ             … ブラウザネイティブの GET（エクスポート zip・証憑）
      3. アクティブが1冊ならその帳簿  … 単一帳簿運用・curl・取込スキルが無改造で動く
      4. どれでも定まらない → 400    … どの帳簿か推測しない（選択肢を応答に含める）
    ＋ 解決先がアーカイブ済みなら、参照系は通し更新系（POST/PUT/PATCH/DELETE）は 409
      （この1箇所に集約する。ルートごとに書くと漏れ、漏れた1本が「アーカイブしたはずの帳簿が
        書き換わる」を生む）
```

**帳簿のアーカイブ**: `books.archived_at`（ISO8601・NULL=アクティブ）。control plane の状態変更のみで、
data plane のファイル・証憑には触れない（**削除は提供しない**の代替であって、削除ではない）。
暗黙解決（3）と 400 の候補（4）は**アクティブだけ**を数える＝アーカイブ済みは選択候補ではない。
最後のアクティブ帳簿はアーカイブできない（アクティブ0冊は上の自動作成を誘発し、空の帳簿が生える）。

**アプリモード**（`app_settings.app_mode` = `personal` / `office`）: 1インスタンスが「自分の帳簿1冊」と
「顧問先 N 冊」のどちらとして振る舞うかを表す。**起動導線と UI の露出範囲だけ**を決め、上の帳簿解決の規約は
一切上書きしない（モードは規約を変えるのではなく、規約が既に言っていることを UI で見せる）。

```
web 起動 → GET /api/app-mode
  ├ 未設定    → モード選択（選ぶまで進まない。既定へ倒さない）
  ├ personal → アクティブ1冊へ直行（切替・作成を出さない。2冊以上なら修復導線）
  └ office   → 帳簿選択画面（必ず選ぶ。前回分はハイライトのみで自動では開かない）
```

- **待ち受けは `127.0.0.1` 固定**（`config.ts` の `LOOPBACK_HOST`）。環境変数で上書きできない。
  外部公開できる口が残ると、認証がないことと組み合わさって事故が致命的になるため、
  選択肢自体を提供しない。
- パスワード認証は**採用しない**。アプリの入口を塞いでも `sqlite3 $DATA_DIR/books/*.sqlite` で
  同じデータが平文で読める以上、脅威モデル上ほぼ意味がない。追加防御が必要になった場合の
  正しい打ち手は認証ではなく**保存時暗号化**（§14）。
- `/skill`（取込スキル）も同じ境界。Bearer トークンは廃止し、同一マシンから直接呼ぶ。
- 帳簿は物理ファイル分離。クエリに帳簿の条件は不要＝他帳簿への到達が構造的に起きない。
- **帳簿の削除 API は提供しない**（不可逆で消えるのは税務データ。ファイルの手動削除に委ねる）。
- シードの後追加は `DbRouter.bookDb()` の冪等 `seedDataPlane`（開くたびに最新へ追いつく
  self-healing）で吸収する。

---

## 6. ドメイン層 `packages/core`（最重要）

純関数のみ。[accounting-spec] [depreciation-spec] のロジックを実装。

| モジュール | 内容 | 仕様 |
|---|---|---|
| `money` | 円＝整数の型・四則・端数処理（floor/round/ceil） | data-model D-1 |
| `tax` | 消費税区分判定・簡易課税の納付税額（みなし仕入率） | accounting §2,3 |
| `depreciation` | 定額法（月割・備忘1円）・一括/少額特例・按分 | depreciation 全般 |
| `ledger` | 仕訳の貸借一致検証・残高/試算表の集計 | accounting §1,9 |
| `proration` | 家事按分の仕訳算出 | accounting §7 |
| `statements` | 損益/貸借/申告書値の組成（帳票マッピング） | form-mapping |

- すべて入力→出力の純関数。**ゴールデンテスト**（参照データのマツダ2＝償却439,919/経費219,960/残高1 等）で回帰防止。

---

## 7. 金額・型の規律（金融系の固さの本体）

```ts
// 円は整数。浮動小数を会計金額に使わない
type Yen = number & { readonly __brand: 'Yen' }   // branded type
// 比率(事業利用比率・償却率)はrealだが、金額算出は整数演算＋明示的端数処理
const businessAmount = floor(mul(depreciation, ratioPercent, 100)) // 例
```
- ESLintルールで core 内の `/` 直書きや float混入を抑止（レビュー指針）。
- DB制約：`journal_entries` 単位の貸借一致は service のトランザクション内で検証（confirmed化の前提, data-model D-10）。

---

## 8. 帳票・PDF・CSV

| 出力 | 方式 |
|---|---|
| 帳簿CSV（仕訳帳/総勘定元帳） | core で行生成 → CSV（[form-mapping §5.2/5.3] のヘッダ準拠） |
| 決算書/申告書PDF（Phase 3） | **pdf-lib** で公式様式PDFテンプレートに座標差し込み（日本語フォント埋込）。[form-mapping] の box にマッピング |
| 代替 | HTML→PDF（Playwright）も候補だが、官製様式の忠実再現は pdf-lib オーバーレイが有利 |

> 様式テンプレート（座標定義）は外部データ化し、年度様式の差替えに対応。

---

## 9. 連携サービスの明細取得（巡回コアの一元化・2つの実行殻）

明細の取得（巡回）は **`packages/acquisition` に一元化**し、実行殻だけを2つ持つ。
本体（`packages/server`）は取得手段に依存せず、受け口＋importer だけを持つ点は変えない
（[PRD F-IMP-5/6], [csv-format §4]）。

```
                     packages/acquisition/src/sites/*.mjs   ← 巡回手順（唯一の実体）
                                    ▲                 ▲
        runtime/playwright.mjs ─────┘                 └───── runtime/electron.mjs
        （Claude Code スキル経路・Chrome）                  （アプリ内・Electron の窓）
                    │                                              │
                    └──── /skill/* ─────▶ packages/server ◀── 直接 importer ────┘
                                          （期間ゲート・冪等・科目検証は共通）
```

- **アプリ内経路が既定**。Chromium はアプリが既に持っているので、Chrome も Playwright も要らない。
  巡回窓は既定セッションではない専用区画で開くので、`kanean://` のアプリ内 API へは到達しない。
- **スキル経路は残す**。開発時の較正と、較正データでは直らない深い修復（巡回手順そのものの変更）に要る。
- どちらの経路でも通る検証・importer は同一（`/skill/*` のハンドラと同じ関数を共有する）。
  「経路が違っても結果が同じ」を保つのはここ。
- サイト較正（`SEL`）はコードから外し、`$DATA_DIR/acquisition/selectors/<source>.json` で
  **アプリの更新なしに**差し替えられる。受け付けるのはデータのみ（[acquisition-skill-spec §2.5.2]）。
- 巡回のログイン状態は `userData` 側のセッション区画に置き、`$DATA_DIR` の会計データと分ける
  （秘密を会計データ側に持ち込まない。エクスポート・バックアップの対象外）。

Amazon/楽天の商品明細取得を **本体の会計ロジックに内蔵しない**方針は不変（[csv-format §4]）。

| 論点 | 方針 |
|---|---|
| 契約 | 取得層は [csv-format §4.2] の**正規化EC明細（JSON/CSV）**を出力するだけ。本体は **importer＋受け口**のみで取得手段に非依存 |
| 現在の本命 | **アプリ内巡回（Electron）＋ Claude Desktop（MCP）による分類**。取得は決定的なサイトスクリプト、分類だけ AI。スキル経路（Claude Code）は較正・深い修復用に残す |
| 製品配布 | **アプリに同梱**（巡回コア＋同梱較正）。利用者に必要なのは Kanean と Claude Desktop だけで、Chrome も Node も要らない。較正はデータなのでアプリ更新なしに追随できる |
| 金額の正確性 | LLM抽出を鵜呑みにしない。取得層が**生証跡（HTML/スクショ/メール）を保存**（`evidence_ref`）→ 取込は **draft 仕訳**として人が承認（[csv-format §4/§5]）。電子帳簿保存にも資する |
| 代替取得層 | 注文確認メール解析（ToS堅い）／Amazon公式CSV（遅延・予備）／手動入力（フォールバック）。すべて同じ中間フォーマットに合流 |
| 隔離 | 巡回窓は外部サイト用の専用セッション区画（preload なし・sandbox）で開き、アプリ内 API に到達しない。本体側は zod 検証＋ importer サービスのみ |
| 運用モデル | **無人cron不可**（2FA/CAPTCHA・認証情報をAIに渡さない）。`/schedule`＝リマインドのみ→**人が起動**→ヘッドフル→**認証だけ人**→抽出AI→draft承認。セッションは保存・再利用し2回目以降ほぼワンクリック |

> 取得スキルの自動化レベル・実行フロー・一時停止ポイント・出力契約・セキュリティは [acquisition-skill-spec.md](./acquisition-skill-spec.md) に定義。

---

## 10. e-Tax 連携（Phase 5・分離設計）

[etax-api-notes] のとおり責務を分割。当面は未実装、PDF手動提出を実用ゴール。

| 機能 | 実装方針 |
|---|---|
| XTX組成 | core/server でXML組成（[etax-api-notes §6] 封筒構造）。様式別仕様の入手が前提 |
| 電子署名 XMLDSig | `xml-crypto` 等。マイナンバーカード署名 |
| NFC読取 | ブラウザ単体では困難 → **別の署名/NFCヘルパー**（ネイティブ/専用アプリ）に委譲 |
| 受付API（受信通知等） | `UF_API/v1` を server から呼ぶ（[etax-api-notes §2]）。F-SUB-4 |

> e-Tax連携は `packages/server` 内の独立モジュール（feature flag）として隔離。

---

## 11. バックアップ（[PRD §5]）

- バックアップは UI / CLI（`ops/backup.ts`・`scripts/backup.ts`）からのオンデマンド実行。月次の自動実行・メール送付は未実装（将来課題。§2.5 の通知＝リマインドで代替）。
- **WAL整合スナップショット**で取得する: 単純 `cp` は WAL 未反映で不整合になり得るため、`sqlite3 <db> ".backup <dest>"` または `VACUUM INTO` を使う（`$DATA_DIR` 配下の `control.sqlite`・`books/*.sqlite` が対象）。
- 単一ファイル＝スナップショットで完結（per-user SQLiteの利点）。`backup_status`（control plane）に記録。
- 運用手順（cron・restore CLI・注意点）は §12.3。
- 将来の有料プラン：継続レプリ（Litestream）・世代管理（F-PLAN-2）。

### 11.1 「持ち出し」と「巻き戻し」は別物

データを退避・復帰させる仕組みが2組あり、**用途が違うので混ぜない**。
UI とドキュメントで書き分ける（利用者が取り違えると、戻したいときに戻せない）。

| | エクスポート／取り込み | バックアップ／リストア |
|---|---|---|
| 対象 | **帳簿1冊**（DB＋証憑＋manifest の zip） | **環境まるごと**（control ＋ 全帳簿のスナップショット） |
| control plane | **含まない** | 含む |
| 用途 | **別環境**へ持ち出す・持ち込む | **同一環境**を時点まで巻き戻す |
| 実行 | アプリ起動中（設定→データ管理） | サーバ停止中（CLI） |
| 入口 | `GET /api/export` / `POST /api/import` | `pnpm … backup` / `pnpm … restore` |
| 退避先 | `pre-import-{timestamp}/`（置換時のみ） | `pre-restore-{timestamp}/` |

エクスポート zip に control plane を**入れない**のは、control がその環境固有のレジストリ
（複数帳簿・アプリモード・バックアップ記録）だからで、持ち込むと取り込み先の他の帳簿を壊しうる
（事務所モードで顧問先を複数持つ環境が典型）。代わりに**取り込み側が自分のレジストリへ登録する**。

そのため **`books/{id}.sqlite` を手でコピーしても帳簿にはならない**。帳簿の在否は control plane の
レジストリだけが決め、起動時の孤児ファイル自動登録は行わない（退避目的で置いたコピーや
`pre-restore-*` の中身を意図せず帳簿にしてしまうため。**ファイルの存在は意図ではない**）。
別環境から持ち込むときは必ず取り込み（`POST /api/import`）を通す。

取り込みは「全部 `$DATA_DIR/tmp/` に組み立てて検証し、通ったものだけを配置する」。
manifest の `sha256` 突合 → `PRAGMA integrity_check` → 最新スキーマへの migrate を
**配置前**に済ませるので、検証で落ちた時点では既存の帳簿に一切触れていない。
帳簿IDが衝突したときは 409 で中止し、`?mode=new`（別 ULID で新規）か `?mode=replace`
（`pre-import-*` へ退避してから置換）を利用者が選ぶ。**黙って上書きも採番もしない**。

---

## 12. デプロイ・運用

- **単一マシン運用**（[PRD 非スコープ：マルチマシン]）。
- **配布形態は Electron デスクトップアプリ**（`packages/desktop`）。§12.0 が正。
- 以下の VPS / pm2 の記述（§12.1〜12.2）は**旧構成の経緯**であり、デスクトップ版には適用されない。
  デプロイスクリプト自体はリポジトリから除去済みで、以下は当時の手順の記録である。

### 12.0 デスクトップアプリ（現行）

```
                          Claude Desktop
                                │ stdio（クライアントが起動する）
                                ▼
                    kanean-mcp（packages/mcp・.mcpb で配布）
                                │ 会計ロジックは持たず HTTP へ中継するだけ
                                ▼
Electron main プロセス ── アプリ起動中のみ存在（常駐しない）
 │
 ├── Hono app（createApp()。Request → Response の関数）
 │     ├─◀── protocol.handle('kanean', …)    ← UI と /api。**TCP ポートを開かない**
 │     ├─◀── unix socket $DATA_DIR/kanean.sock ← 取込スキル / MCP（起動中のみ・0600）
 │     └──── /api/desktop/*                    ← Finder 提示など Electron 固有の操作（desktop が追加登録）
 │
 └── better-sqlite3 ──▶ $DATA_DIR/books/{id}.sqlite

ウィンドウを閉じる → プロセス終了 → ソケット削除 → 何も残らない
```

- **MCP ブリッジ（`packages/mcp`）はソケットにだけ繋ぐ**。既定で TCP ポートを探しに行かない
  （開発時は `KANEAN_BASE_URL` を明示したときだけ TCP を使う）。ソケットが無い＝アプリ未起動と
  判別し、利用者の承諾を得てから起動して1回だけ再試行する。
- 露出する動詞は読み取り中心の十数本に絞る。**仕訳の確定・承認とマスタ編集はツールとして持たない**
  （承認は UI に残す）。到達性の境界（[[local-access]]）と露出範囲は別の問題として扱う。
- 外部から `kanean://local/#<tab>` を開くと該当画面が出る（旧 `?tab=` 形式は片方向でハッシュへ正規化）。**リンクは画面遷移のみ**を担う。

- **UI 経路に TCP は無い**。UI も業務 API も同一スキーム `kanean://local/` から配るので同一オリジンとなり CORS 不要。
  `packages/web` は相対パス（`/api/…`）のままブラウザ実行時（Vite proxy）とデスクトップ実行時の両方で動く。
- **`DATA_DIR` の既定は `<userData>/data`**（macOS: `~/Library/Application Support/Kanean/data`）。
  `userData` 直下は Chromium が Cache/Local Storage を作る領域なので、会計データは必ず `data/` に隔離する。
  環境変数 `DATA_DIR` があればそちらが優先（開発・検証用）。
- **アプリ名は `app.setName('Kanean')` で明示する**。既定では package.json の `name`（`@kanean/desktop`）が
  使われ、データ置き場が `~/Library/Application Support/@kanean/desktop/` になってしまう。
- **`better-sqlite3` は 13.x（Node-API）**。ABI 安定なので Node と Electron で同一バイナリが動き、
  `@electron/rebuild` によるリビルド機構を持たない。
- パッケージ（`electron-builder`）で同梱が要るもの:
  `web/dist` → `resources/web`、`@kanean/server` の `migrations/` と `assets/`
  （`import.meta.url` からの相対 `../../` で読むため**相対位置を保つ**）、
  `asarUnpack` で `better-sqlite3`（asar 内からは `.node` を dlopen できない）。
- 配布には **`Developer ID Application` 証明書**が要る（`Apple Distribution` は App Store 専用で使えない）。

### 12.1 ディレクトリ（旧・VPS 構成。コードとデータを物理分離）
```
~/workspace/kanean/        ← deploy が dist を置換（揮発してよい）
  packages/*/dist
  node_modules               ← サーバ側で pnpm install（better-sqlite3 を Linux 向けにコンパイル）
  package.json / pnpm-lock.yaml
  .env                       ← repo外・手動配置（deploy対象外）。DATA_DIR 等
~/data/kanean/             ← deploy が触れない永続領域（$DATA_DIR）
  control.sqlite
  books/*.sqlite (+ -wal/-shm)
```

### 12.2 当時のデプロイスクリプトの流れ（記録）
1. ローカル `pnpm build`。
2. `shared/core/server/web` の `dist` を `rm -rf`→`scp`（兄弟と同じ）。
3. ★ **native依存**: `package.json`＋`pnpm-lock.yaml` を転送し、サーバで `pnpm install --prod --frozen-lockfile`（**better-sqlite3 はサーバ側ビルドが必須**。Mac の dist だけ送っても動かない）。
4. ★ **デプロイ前バックアップ**（migrate の*前*）: `node packages/server/dist/scripts/backup.js` で直前状態の復元点を確保。control.sqlite 不在（DATA_DIR 誤設定）や integrity_check 失敗は非0終了＝**deploy を中断**（壊れた状態へ migrate をかけない）。
5. ★ **マイグレーション**（`pm2 restart` の*前*）: `ssh <deploy-host> 'cd ~/workspace/kanean && node packages/server/dist/migrate.js'` で control＋全 `books/*.sqlite` に適用。冪等・失敗で停止＝**壊れたスキーマで起動させない**。
6. `pm2 restart kanean`。

- **`.env`・`data/` は deploy 対象外**（転送しない）。`DATA_DIR` で永続領域を指す。
- マイグレーションは二重化: deploy 時の明示実行（④）＋ 起動時/オープン時の `DbRouter` 自動適用（§4.3、新規ユーザー・保険）。
- 環境変数: `.env`（`DATA_DIR`、`PORT`、メール）。`.env.example` を用意。認証関連の変数は存在しない。
- ~~Dockerイメージによる配布~~ … **撤回**。`127.0.0.1` 限定バインド（§5）はコンテナのポートマッピングと噛み合わない。
- ~~配布形態は Tauri~~ … **Electron に変更**（§12.0）。Tauri は Rust 側に JS ランタイムが無く node をサイドカーで生やす必要があり、「終了後に何も残さない」要件と噛み合わないため。

### 12.3 バックアップ・リストア手順（runbook）

**バックアップ**（WAL整合スナップショット・integrity_check 検証・証憑同梱・世代保持既定30）

- 手動: `pnpm --filter @kanean/server backup [retention]`。結果は control の `backup_status` に per-user 記録。
- cron 例（毎月1日 4:00、本番）: `0 4 1 * * cd ~/workspace/kanean && node packages/server/dist/scripts/backup.js >> ~/backup.log 2>&1`
- 当時のデプロイスクリプトも migrate 前に自動実行していた（§12.2 ④）。
- **DATA_DIR 誤設定（control.sqlite 不在）は即エラー**＝空DBの偽バックアップを作らない。破損DB（integrity_check ≠ ok）はそのユーザーを失敗記録し、破損スナップショットを残さない。

**リストア**（**必ずサーバ停止中に**。稼働中に適用すると旧接続の WAL が混ざり破損する）

1. `pm2 stop kanean`
2. `pnpm --filter @kanean/server restore` … スナップショット一覧（timestamp・ユーザー数・integrity 検証結果）
3. `pnpm --filter @kanean/server restore <timestamp>` … dry-run（復元内容の確認のみ・現行データ無変更）
4. `pnpm --filter @kanean/server restore <timestamp> --apply` … 適用。現行の control.sqlite / books/（DB・WAL/SHM 残骸・attachments）を `$DATA_DIR/pre-restore-{now}/` へ退避してからスナップショットを**コピーで**配置（バックアップセットは温存＝やり直し可能）
5. `pm2 start kanean` → 動作確認 → 問題なければ `pre-restore-*` を手動削除（問題があれば中身を戻す）

- 破損スナップショット（integrity_check ≠ ok）は適用前に拒否され、現行データには一切触れない。
- スナップショットに無いユーザーの DB/証憑も退避される（時点復元＝スナップショット時点の世界に戻る）。

---

## 13. テスト戦略

| 層 | 方針 |
|---|---|
| core | **ゴールデン/期待値テスト**（税・償却・残高）。参照データで回帰固定。最優先 |
| repositories | 一時SQLiteでマイグレーション→CRUD→整合性（貸借一致・dedup） |
| services | 取込→仕訳→帳簿→決算の結合テスト |
| api | Hono のルートテスト（検証・エラー形式） |
| migration | 旧バージョンDB→最新へ適用できるか（N個DBランナー） |

---

## 14. セキュリティ

| 項目 | 対応 |
|---|---|
| アクセス境界 | **`127.0.0.1` 限定バインド**（§5）。同一マシン以外から到達不能。これが唯一かつ最大の防壁 |
| 認証 | 持たない。「同一マシンで実行できること」＝全権限、と割り切る |
| 通信 | ループバックのみ。TLS・リバースプロキシは不要（外部公開しない） |
| 保存時暗号化 | **未対応・将来課題**。per-user SQLite は平文。ログイン中の macOS では同一ユーザーで動く任意のプロセスが読める。必要になれば **SQLCipher**（better-sqlite3-multiple-ciphers）＋起動時パスフレーズ（マイナンバー対応, [PRD §5]） |
| 秘密情報 | 外部サービスの認証情報を本体は保持しない（取込は別プロセスのスキルが担う） |
| データ分離 | 帳簿ごとの物理ファイル分離で構造的に担保（§4.1） |

---

## 15. ディレクトリ構成（server 抜粋）

```
packages/server/src/
  index.ts / app.ts        Hono起動・静的配信 / createApp（desktop が同一プロセスで使う入口）
  db/
    router.ts              DbRouter（§4.1）
    control/{schema,migrate}.ts
    data/{schema,migrate,seed}.ts
  books/ appMode/          帳簿レジストリ・アプリモード（control plane）
  import/ journal/ masters/ closing/ fixedAssets/ proration/ documents/ attachments/
  fiscalYear/ taxreturn/ services/   ドメインサービス
  acquisition/             巡回ジョブ・診断・較正（巡回手順の実体は @kanean/acquisition）
  mcp/                     MCP リンク（同梱バンドルの版検査）
  http/                    routes（handlers）
  reports/ pdf/            csv / pdf（pdf-lib）
  ops/ scripts/            バックアップ・restore・帳簿 zip 入出力（CLI 含む）
```

（認証は持たない。e-Tax 送信系はリポジトリ直下 `etaxapi/` で別トラック検証中）

---

## 16. 技術的リスク・未確定

| # | 項目 | メモ |
|---|---|---|
| A-1 | per-user DBマイグレーションの運用 | N個適用の失敗時リトライ・整合性監視（基盤として最優先実装） |
| A-2 | PDFの官製様式忠実再現 | 座標差し込みの工数・日本語フォント・年度様式差替え |
| A-3 | SQLCipher採否 | 暗号化の性能・鍵管理。MVPは平文＋ディスク暗号で代替も可 |
| A-4 | e-Tax送信系 | 様式別仕様・XMLDSig・NFCは別途。Phase 5に隔離 |
| A-5 | 直接法の按分仕訳整合 | [depreciation §8] 台帳全額 vs 経費按分の二重管理方針 |
| A-6 | 接続キャッシュ上限 | 多ユーザー時のSQLite接続数・メモリ。LRU上限とWAL運用 |
| A-7 | EC取得スキルの外部依存 | 取得は本体外（スキル＋LLM）。LLM抽出の金額誤りは生証跡保存＋draft承認で封じる。配布はスキル単位（§9） |

---

## 17. 次のアクション（初期フェーズ・すべて完了済み。履歴として残置）

- [x] openspec へ初期スペック（capabilities）登録
- [x] モノレポ雛形（packages/{shared,core,server,web}）作成
- [x] Drizzle スキーマ（control/data）を data-model から起こす
- [x] DbRouter + マイグレーションランナー（A-1）を最優先で実装
- [x] core の money/tax/depreciation をゴールデンテスト付きで実装（Phase 1基盤）
- [x] CSVフォーマット定義書（取込）の作成 → 取込サービス
