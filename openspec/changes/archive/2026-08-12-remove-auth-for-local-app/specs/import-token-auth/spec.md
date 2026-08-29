## REMOVED Requirements

### Requirement: import トークンの発行と保存形式

**Reason**: import トークンは「取込スキルがインターネット越しに VPS の API を叩く」ために存在した。
サーバとスキルが同一マシンに閉じ、待ち受けが 127.0.0.1 に固定される時点で、Bearer トークンは
到達性の制御を何も追加しない。

**Migration**: `import_tokens` テーブルを DROP し、`POST/GET/DELETE /api/import-tokens` を削除する。
web の取込トークン管理パネルも削除する。

### Requirement: import トークンによる API 認証

**Reason**: `/skill` 配下の保護をトークンからループバック到達性に置き換える。

**Migration**: [[local-access]] の「取込スキルの呼び出し境界」が置き換える。
`Authorization: Bearer` ヘッダは無視され、要求もされない。5MB のボディ上限は
[[local-access]] 側に引き継ぐ。

### Requirement: ブラウザ認証によるトークン自動受け渡し

**Reason**: 引き渡すトークンが存在しなくなる。加えて同意画面は Web セッションに依存しており、
セッション廃止と同時に成立しなくなる。

**Migration**: `/skill/auth/authorize`（GET/POST）を削除する。スキル側はトークン取得フローを廃し、
`http://127.0.0.1:<port>/skill/*` を直接呼ぶ。

### Requirement: authorization code の交換

**Reason**: 交換すべき code もトークンも存在しなくなる。

**Migration**: `/skill/auth/token` とプロセス内 authorization code ストアを削除する。

### Requirement: リダイレクト先の制限

**Reason**: リダイレクトを伴うフローが消滅する。

**Migration**: ループバック限定の `redirect_uri` 検証を削除する。
オープンリダイレクトの攻撃面は、リダイレクトが存在しないことによって消える。
