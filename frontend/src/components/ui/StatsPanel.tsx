// ── StatsPanel ────────────────────────────────────────────────────────────────
// Displays descriptive statistics for a series of EGC values.
// Shown/hidden via the "Σ Stats" toggle button in each chart card header.
//
// Statistics computed:
//   n, mean, median, std dev (sample, ÷n-1), CV, min, Q1, Q3, max
//
// Formatting:
//   Values < 0.01 or > 9999 are shown in scientific notation (3 sig figs).
//   All others use toPrecision(4) for consistent significant figures.
//
// Usage:
//   <StatsPanel vals={egcVals} yLabel="EGC" />

import { useMemo } from 'react'
import { computeStats } from '../../utils/stats'

export function StatsPanel({
  vals,
  yLabel,
}: {
  vals:   number[]
  yLabel: string
}) {
  const stats = useMemo(() => computeStats(vals), [vals])
  if (!stats) return null

  const fmt = (v: number) =>
    Math.abs(v) < 0.01 || Math.abs(v) > 9999
      ? v.toExponential(3)
      : v.toPrecision(4)

  const rows: [string, string][] = [
    ['n',         String(stats.n)],
    ['Mean',      fmt(stats.mean)],
    ['Median',    fmt(stats.median)],
    // 's' = sample std dev (÷ n-1), not population σ
    ['Std Dev s', fmt(stats.std)],
    ['CV',        (stats.cv * 100).toFixed(1) + '%'],
    ['Min',       fmt(stats.min)],
    ['Q1',        fmt(stats.q1)],
    ['Q3',        fmt(stats.q3)],
    ['Max',       fmt(stats.max)],
  ]

  return (
    <div className="stats-panel">
      <div className="stats-panel-title">
        Descriptive Statistics · {yLabel}
      </div>
      <div className="stats-grid">
        {rows.map(([label, value]) => (
          <div className="stat-cell" key={label}>
            <span className="stat-cell-label">{label}</span>
            <span className="stat-cell-value">{value}</span>
          </div>
        ))}
      </div>
    </div>
  )
}
