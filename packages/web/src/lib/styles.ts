/**
 * 共有スタイル（色トークン・セクション枠・選択カード行）。
 * ボタン・タブ・ナビは styles/app.css のクラス（.btn/.btn-link/.seg-tab/.sub-tab/.nav-item・issue #275）、
 * テーブルは .tbl と .num/.ellipsis/.sticky（issue #276）へ移行済み
 * （hover/focus-visible はクラスでしか書けない）。
 */

/**
 * 色トークン（issue #130）。色は**意味で**選ぶ — 同じ意味の色を微妙に違う値で増やさない
 * （エラー赤3値・警告枠5値のような分裂を防ぐ）。新しい色が欲しくなったら、まず既存トークンで
 * 済まないか確認し、足すときは styles/app.css の --c-* に実体を定義してここに参照を足す（issue #274）。
 *
 * 注意: SVG のプレゼンテーション属性（fill= / stroke=）には var() が効かないため、
 * SVG では style prop（style={{ fill: COLORS.muted }}）で使うこと（components/charts.tsx）。
 */
export const COLORS = {
  /** 成功・確定・アクティブ（緑）。 */
  ok: 'var(--c-ok)',
  okBg: 'var(--c-ok-bg)',
  okBorder: 'var(--c-ok-border)',
  /** 注意・下書き・確認待ち（アンバー）。 */
  warn: 'var(--c-warn)',
  warnBg: 'var(--c-warn-bg)',
  warnBorder: 'var(--c-warn-border)',
  /** エラー・破壊的操作（赤）。 */
  error: 'var(--c-error)',
  errorBg: 'var(--c-error-bg)',
  errorBorder: 'var(--c-error-border)',
  /** リンク・情報・進行中（青）。 */
  accent: 'var(--c-accent)',
  accentBg: 'var(--c-accent-bg)',
  accentBorder: 'var(--c-accent-border)',
  /** 本文。 */
  text: 'var(--c-text)',
  /** ラベル・補足（本文より弱い）。 */
  sub: 'var(--c-sub)',
  /** 注記・ヒント（さらに弱い。白面 AA を満たす）。 */
  muted: 'var(--c-muted)',
  /** 無効・打ち消しの**状態表現**（行のグレーアウト）専用。AA 未満のため本文には使わない（issue #281）。 */
  faint: 'var(--c-faint)',
  /** 枠線。 */
  border: 'var(--c-border)',
  /** 弱い罫線（表の行区切り・小さな区切り）。 */
  borderFaint: 'var(--c-border-faint)',
  /** 淡い面（行の展開・集計行・サイドバー地）。 */
  bgSubtle: 'var(--c-bg-subtle)',
  /** 白サーフェス（カード・ボタン地・sticky セルの地。issue #255）。 */
  surface: 'var(--c-surface)',
} as const

/**
 * データ系列のカテゴリカル配色（issue #279）。グラフの系列は必ずこちらを使い、
 * COLORS の状態色（ok/warn/error）を系列に流用しない（意味の衝突。実体と検証根拠は app.css）。
 */
export const VIZ = {
  s1: 'var(--viz-1)',
  s2: 'var(--viz-2)',
  s3: 'var(--viz-3)',
} as const

/**
 * 一覧行の中に置く select（[[web-app]]「一覧行の折り返し」）。
 *
 * select の閉状態は既定で**最長 option の幅**になるため、勘定科目マスタが増えるほど行が広がって
 * 折り返す。幅を固定して科目数と行幅を切り離す。開いたドロップダウンは全文のままなので選択には困らない。
 * 選択中の値が切れうるので、使う側は title に選択中のラベルを入れること。
 */
export const SELECT_FIXED: React.CSSProperties = { width: 132, flexShrink: 0 }

/** 警告バナー（注意書きの帯。issue #255 で手組み6箇所を統一）。 */
export const WARN_BANNER: React.CSSProperties = {
  background: COLORS.warnBg,
  border: `1px solid ${COLORS.warnBorder}`,
  borderRadius: 'var(--rad-m)',
  padding: '8px 12px',
  color: COLORS.warn,
  fontSize: 'var(--fs-m)',
}
/** カード/セクション枠（ホームのカード・各画面のセクション共通。幾何は app.css のトークン。issue #278）。 */
export const SECTION: React.CSSProperties = { border: `1px solid ${COLORS.border}`, borderRadius: 'var(--rad-l)', padding: 16, margin: '0 0 16px' }
export const FIELD: React.CSSProperties = { padding: '4px 6px' }

/**
 * 「1つ選ぶ」カード行（帳簿選択・アプリモード・連携サービス一覧。issue #130 で5実装を統一）。
 * 選択中は緑の枠＋淡い緑地。レイアウト差は使う側が spread で上書きする。
 */
export const selectableRow = (active: boolean): React.CSSProperties => ({
  display: 'flex',
  alignItems: 'center',
  gap: 10,
  width: '100%',
  // button は UA 既定で border-box だが label は content-box なので、width:100% が枠からはみ出す。
  boxSizing: 'border-box',
  textAlign: 'left',
  border: '1px solid',
  borderColor: active ? COLORS.ok : COLORS.border,
  background: active ? COLORS.okBg : COLORS.surface,
  borderRadius: 'var(--rad-l)',
  padding: '12px 12px',
  cursor: 'pointer',
})
