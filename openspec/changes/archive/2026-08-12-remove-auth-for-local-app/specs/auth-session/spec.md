## REMOVED Requirements

### Requirement: GitHub OAuth ログイン

**Reason**: 利用形態が「自分1人が自分のマシンで使う」に確定し、次段の Tauri デスクトップアプリ化では
GitHub OAuth が構造的に成立しない（client_secret の同梱・外部ブラウザ往復・オフライン起動不可）。
認証という境界を、ループバック限定の待ち受けというネットワーク境界に置き換える。

**Migration**: ログイン操作は廃止。`/auth/github`・`/auth/github/callback`・`/auth/logout` は削除され、
`GITHUB_CLIENT_ID` / `GITHUB_CLIENT_SECRET` / `GITHUB_CALLBACK_URL` / `POST_LOGIN_REDIRECT` は不要になる。
アクセス制御は [[local-access]] の「ループバック限定の待ち受け」が担う。

### Requirement: 初回ログイン時のデータプレーン初期化

**Reason**: 初回ログインという契機が消滅する。同等の振る舞いは起動時のオーナー解決へ移る。

**Migration**: [[local-access]] の「単一オーナーの自動解決」「シード追加への自己修復」が同じ保証を提供する。
data plane のパス・シード内容・自己修復の挙動は変わらない。

### Requirement: セッションによる API 保護

**Reason**: Cookie セッションを廃止する。`/api` の保護は認証ではなくループバック到達性で行う。

**Migration**: `sessions` テーブル・セッション Cookie・`requireAuth` のセッション検証を削除。
`GET /api/me` は [[local-access]] へ移り、オーナーの `users` 行を返す振る舞いのみ残る。

### Requirement: ユーザー間データ分離

**Reason**: ユーザーが1人になり、隔離すべき相手が存在しない。

**Migration**: per-user の物理ファイル分離という構造そのものは維持する（後続 change で
`books/{id}.sqlite` として再定義し、税理士側の複数帳簿に備える）。要件としての「ユーザー間分離」は削除する。

### Requirement: ログイン後の復帰先制御

**Reason**: ログインが存在しないため `return_to` の概念が消滅する。

**Migration**: `POST_LOGIN_REDIRECT` および `return_to` パラメータの取り扱いを削除する。

### Requirement: セッションの一括失効

**Reason**: セッションが存在しない。

**Migration**: `pnpm --filter @kanean/server invalidate-sessions` を削除する。
デプロイでセッションが失効しないという保証も、対象が消えるため不要になる。
