// ── StatsPanel ────────────────────────────────────────────────────────────────
// Displays descriptive statistics for one or more series of EGC values.
// Shown/hidden via the "Σ Stats" toggle button in each chart card header.
//
// Two modes:
//   vals:   number[]                        -- one set of values, one stats row.
//   series: { label, vals: number[] }[]      -- multiple series, one row each.
//
// W25 (docs/AUDIT-2026-09-22.md): MultiEgcChart used to pool every series'
// values into one flat array before this existed, so comparing e.g. COG0055
// against K02568 reported a single meaningless blended mean (mixing a 4.8e-4
// series with a 7.8e-6 series into one 2.4e-4 "mean" that describes neither).
// `series` mode gives each annotation its own row instead.
//
// Statistics computed per row:
//   n, mean, median, std dev (sample, ÷n-1), CV, min, Q1, Q3, max
//
// Formatting:
//   Values < 0.01 or > 9999 are shown in scientific notation (3 sig figs).
//   All others use toPrecision(4) for consistent significant figures.
//
// Usage:
//   <StatsPanel vals={egcVals} yLabel="EGC" standardize={standardize} />
//   <StatsPanel series={[{ label, vals }, ...]} yLabel="EGC" standardize={standardize} />

import { useMemo } from 'react'
import { computeStats } from '../../utils/stats'
import type { DescStats } from '../../types'

// CV = std / mean is numerically meaningless once the mean is negligible
// relative to the spread -- division by a near-zero denominator produces
// enormous, uninterpretable numbers. Confirmed live: pooling two Z-scored
// series (mean forced to ~0 by construction) gave CV "-57308638803537928192.0%".
// This isn't only a Z-score problem -- any distribution whose mean is
// negligible next to its own std dev hits the same instability, so the
// guard is a relative-magnitude check, not a `standardize` flag lookup.
function cvDisplay(stats: DescStats, standardize: boolean): string {
  if (standardize) return '—'
  if (Math.abs(stats.mean) < Math.abs(stats.std) * 1e-6) return '—'
  return (stats.cv * 100).toFixed(1) + '%'
}

function fmt(v: number): string {
  return Math.abs(v) < 0.01 || Math.abs(v) > 9999
    ? v.toExponential(3)
    : v.toPrecision(4)
}

function StatsGrid({ stats, standardize }: { stats: DescStats; standardize: boolean }) {
  const rows: [string, string][] = [
    ['n',         String(stats.n)],
    ['Mean',      fmt(stats.mean)],
    ['Median',    fmt(stats.median)],
    // 's' = sample std dev (÷ n-1), not population σ
    ['Std Dev s', fmt(stats.std)],
    ['CV',        cvDisplay(stats, standardize)],
    ['Min',       fmt(stats.min)],
    ['Q1',        fmt(stats.q1)],
    ['Q3',        fmt(stats.q3)],
    ['Max',       fmt(stats.max)],
  ]
  return (
    <div className="stats-grid">
      {rows.map(([label, value]) => (
        <div className="stat-cell" key={label}>
          <span className="stat-cell-label">{label}</span>
          <span className="stat-cell-value">{value}</span>
        </div>
      ))}
    </div>
  )
}

export function StatsPanel({
  vals,
  series,
  yLabel,
  standardize = false,
}: {
  vals?:        number[]
  series?:      { label: string; vals: number[] }[]
  yLabel:       string
  standardize?: boolean
}) {
  const singleStats = useMemo(
    () => (vals ? computeStats(vals) : null),
    [vals],
  )

  if (series) {
    const blocks = series
      .map(s => ({ label: s.label, stats: computeStats(s.vals) }))
      .filter((b): b is { label: string; stats: DescStats } => b.stats !== null)
    if (blocks.length === 0) return null

    return (
      <div className="stats-panel">
        <div className="stats-panel-title">
          Descriptive Statistics · {yLabel} · one row per annotation
        </div>
        {blocks.map(({ label, stats }, i) => (
          <div className="stats-panel-series" key={`${label}::${i}`}>
            <div className="stats-panel-series-label" title={label}>{label}</div>
            <StatsGrid stats={stats} standardize={standardize} />
          </div>
        ))}
      </div>
    )
  }

  if (!singleStats) return null
  return (
    <div className="stats-panel">
      <div className="stats-panel-title">
        Descriptive Statistics · {yLabel}
      </div>
      <StatsGrid stats={singleStats} standardize={standardize} />
    </div>
  )
}
