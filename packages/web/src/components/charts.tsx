/** 依存追加なしのインライン SVG チャート部品（ホームの月次収支グラフ）。 */
import { COLORS } from '../lib/styles.js'
import { yen } from '../lib/format.js'

// --- スケール計算（純関数・テスト対象） --------------------------------------

/** 目盛り間隔を 1-2-5 系列に丸める（rough 以上で最小の切りの良い間隔）。 */
export function niceStep(rough: number): number {
  if (!Number.isFinite(rough) || rough <= 0) return 1
  const pow = Math.pow(10, Math.floor(Math.log10(rough)))
  const frac = rough / pow
  return (frac <= 1 ? 1 : frac <= 2 ? 2 : frac <= 5 ? 5 : 10) * pow
}

export interface ChartScale {
  /** 目盛りの下端（0 と全値の最小値を含む切りの良い値）。 */
  min: number
  /** 目盛りの上端（0 と全値の最大値を含む切りの良い値）。 */
  max: number
  /** 下端→上端の目盛り値（昇順・0 を必ず含む）。 */
  ticks: number[]
  /** 値 → Y 座標（SVG は下が正なので min→bottom / max→top に写す）。 */
  toY: (v: number) => number
  /** 0 基線の Y 座標。 */
  zeroY: number
}

/**
 * 値の集合から 0 基線を含む縦スケールを作る（負値対応）。
 * 全ゼロ・空配列でも 0..1 の退避ドメインで有効な座標を返す（NaN を出さない）。
 */
export function chartScale(values: number[], top: number, bottom: number, tickCount = 4): ChartScale {
  let lo = 0
  let hi = 0
  for (const v of values) {
    if (!Number.isFinite(v)) continue
    if (v < lo) lo = v
    if (v > hi) hi = v
  }
  if (lo === 0 && hi === 0) hi = 1 // 全ゼロ: 基線が bottom に来る最小ドメイン
  const step = niceStep((hi - lo) / Math.max(1, tickCount))
  const min = Math.floor(lo / step) * step
  const max = Math.ceil(hi / step) * step
  const ticks: number[] = []
  const n = Math.round((max - min) / step)
  for (let i = 0; i <= n; i++) ticks.push(min + i * step)
  const toY = (v: number) => bottom - ((v - min) / (max - min)) * (bottom - top)
  return { min, max, ticks, toY, zeroY: toY(0) }
}

/** Y 軸目盛りの短縮表示（億・万単位。1万未満はカンマ区切り）。 */
export function axisLabel(v: number): string {
  const fmt = (x: number) => {
    const r = Math.round(x * 10) / 10
    return Number.isInteger(r) ? r.toLocaleString() : r.toFixed(1)
  }
  const abs = Math.abs(v)
  if (abs >= 1e8) return `${fmt(v / 1e8)}億`
  if (abs >= 1e4) return `${fmt(v / 1e4)}万`
  return v.toLocaleString()
}

/**
 * グループ棒の X 座標と幅（i=月 index / j=系列 index）。
 * 棒間 2px・棒幅は最大 24px。グループはバンド中央に寄せる。
 */
export function barX(
  i: number,
  j: number,
  monthCount: number,
  seriesCount: number,
  left: number,
  right: number,
): { x: number; w: number } {
  const gap = 2
  const band = (right - left) / Math.max(1, monthCount)
  const pad = Math.max(2, band * 0.15)
  const w = Math.min(24, Math.max(1, (band - pad * 2 - gap * (seriesCount - 1)) / seriesCount))
  const groupW = w * seriesCount + gap * (seriesCount - 1)
  const x0 = left + band * i + (band - groupW) / 2
  return { x: x0 + j * (w + gap), w }
}

/** 0 基線から値方向へ伸びる棒の path（データ端のみ角丸・基線側は直角）。 */
export function barPath(x: number, w: number, zeroY: number, y: number, radius = 3): string {
  const r = Math.min(radius, w / 2, Math.abs(zeroY - y))
  const s = y <= zeroY ? 1 : -1 // 1=正の棒（上に伸びる）
  return (
    `M${x},${zeroY} L${x},${y + s * r} Q${x},${y} ${x + r},${y} ` +
    `L${x + w - r},${y} Q${x + w},${y} ${x + w},${y + s * r} L${x + w},${zeroY} Z`
  )
}

// --- コンポーネント ----------------------------------------------------------

export interface BarSeries {
  label: string
  color: string
  /** 月毎の値（labels と同じ長さ。負値可）。 */
  values: number[]
}

/**
 * 月次のグループ棒グラフ（負値対応・0 基線・目盛り数個・title 要素ツールチップ）。
 * 凡例は常時表示。値ラベルは付けずツールチップと Y 軸目盛りに任せる。
 */
export function BarChart({
  labels,
  series,
  height = 240,
  valueFormat = yen,
}: {
  labels: string[]
  series: BarSeries[]
  height?: number
  valueFormat?: (v: number) => string
}) {
  const width = 720
  const pad = { top: 10, right: 8, bottom: 24, left: 56 }
  const scale = chartScale(
    series.flatMap((s) => s.values),
    pad.top,
    height - pad.bottom,
  )
  const bandW = (width - pad.left - pad.right) / Math.max(1, labels.length)
  return (
    <div>
      <div style={{ display: 'flex', gap: 16, flexWrap: 'wrap', fontSize: 13, color: COLORS.sub, margin: '0 0 6px' }}>
        {series.map((s) => (
          <span key={s.label} style={{ display: 'inline-flex', alignItems: 'center', gap: 4 }}>
            <span style={{ width: 10, height: 10, borderRadius: 4, background: s.color }} />
            {s.label}
          </span>
        ))}
      </div>
      <svg
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: '100%', maxWidth: width, display: 'block' }}
        role="img"
        aria-label={series.map((s) => s.label).join('・')}
      >
        {scale.ticks.map((t) => (
          <g key={t}>
            <line
              x1={pad.left}
              x2={width - pad.right}
              y1={scale.toY(t)}
              y2={scale.toY(t)}
              // SVG のプレゼンテーション属性には var() が効かないため style で指定（issue #274）
              style={{ stroke: t === 0 ? COLORS.border : COLORS.borderFaint }}
              strokeWidth={1}
            />
            <text x={pad.left - 6} y={scale.toY(t) + 3.5} textAnchor="end" fontSize={10.5} style={{ fill: COLORS.muted }}>
              {axisLabel(t)}
            </text>
          </g>
        ))}
        {labels.map((l, i) => (
          <text
            key={l}
            x={pad.left + bandW * (i + 0.5)}
            y={height - 8}
            textAnchor="middle"
            fontSize={10.5}
            style={{ fill: COLORS.muted }}
          >
            {l}
          </text>
        ))}
        {series.map((s, j) =>
          s.values.map((v, i) => {
            if (v === 0) return null
            const { x, w } = barX(i, j, labels.length, series.length, pad.left, width - pad.right)
            let y = scale.toY(v)
            if (Math.abs(scale.zeroY - y) < 1) y = scale.zeroY + (v > 0 ? -1 : 1) // 極小値も 1px は見せる
            return (
              <path key={`${s.label}-${i}`} d={barPath(x, w, scale.zeroY, y)} style={{ fill: s.color }}>
                <title>{`${labels[i]} ${s.label} ${valueFormat(v)}`}</title>
              </path>
            )
          }),
        )}
      </svg>
    </div>
  )
}
