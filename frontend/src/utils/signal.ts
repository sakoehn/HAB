// ── Signal Processing Utilities ───────────────────────────────────────────────
// Time-series transformation functions applied to EGC data before charting.
// All functions are pure — they return new arrays and never mutate input.
// No React imports — fully testable in Node.

// ── applyL1Normalize ──────────────────────────────────────────────────────
// Depth-normalise EGC values using pre-computed norm_egc when available.
//
// Two modes depending on whether timepointTotals is supplied:
//
//   With timepointTotals (per-timepoint sum across all displayed series):
//     egc_norm = egc / total_egc_at_that_timepoint
//     Used in MultiEgcChart for cross-series comparison.
//
//   Without timepointTotals (fallback for GroupedEgcChart summed series):
//     egc_norm = egc / sum_of_all_egc_in_series
//     Note: this denominator is arbitrary (depends on which annotations are
//     loaded) so the result is relative within the group, not an absolute
//     depth-normalised abundance.  A ⚠ warning is shown in the UI.
//
// In EgcChart (single annotation), L1 mode bypasses this function entirely
// and reads the pre-computed norm_egc field directly from the annotation JSON.

export function applyL1Normalize(
  data: { egc: number | null; datetime?: string }[],
  timepointTotals?: Map<string, number>,
): { egc: number | null; datetime?: string }[] {
  if (timepointTotals && timepointTotals.size > 0) {
    return data.map(d => {
      if (d.egc === null) return d
      const total = d.datetime ? (timepointTotals.get(d.datetime) ?? 0) : 0
      return { ...d, egc: total > 0 ? d.egc / total : null }
    })
  }

  // Fallback: divide by series total
  const total = data.reduce((s, d) => s + (d.egc ?? 0), 0)
  if (total === 0) return data
  return data.map(d => ({ ...d, egc: d.egc !== null ? d.egc / total : null }))
}

// ── applyZScore ────────────────────────────────────────────────────────────
// Z-score standardisation per series.
// Subtracts the series mean and divides by sample std dev (÷ n-1).
//
// Result: all series centred at 0, scaled by their own variance.
// Best for comparing trend shapes across annotations with very different
// EGC magnitudes.
//
// Returns 0 for all points when std dev = 0 (flat series — no variation).

export function applyZScore(
  data: { egc: number | null }[],
): { egc: number | null }[] {
  const vals = data
    .map(d => d.egc)
    .filter((v): v is number => v !== null)

  if (vals.length < 2) return data

  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const std  = Math.sqrt(
    vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length,
  )

  if (std === 0) {
    return data.map(d => ({ ...d, egc: d.egc !== null ? 0 : null }))
  }

  return data.map(d => ({
    ...d,
    egc: d.egc !== null ? (d.egc - mean) / std : null,
  }))
}

// ── applyLowess ────────────────────────────────────────────────────────────
// Locally Weighted Scatterplot Smoothing (LOWESS).
//
// At each point, fits a weighted linear model using the nearest `span`
// neighbours.  Closer points receive higher weight via the tricube kernel:
//   w = (1 − |u|³)³   where u = distance / max_distance_in_window
//
// bandwidth: fraction of data used as neighbours per fit (0.01 – 0.05).
//   Lower → tighter fit to local fluctuations.
//   Higher → smoother global trend.
//
// Points with egc = null are excluded from the fit but retained in the
// output array so the chart's x-axis alignment is preserved.
//
// Requires at least 3 non-null points; returns data unchanged otherwise.

export function applyLowess(
  data: { egc: number | null }[],
  bandwidth: number,
): { egc: number | null }[] {
  const pts = data
    .map((d, i) => ({ i, x: i, y: d.egc }))
    .filter((p): p is { i: number; x: number; y: number } => p.y !== null)

  if (pts.length < 3) return data

  const n    = pts.length
  const span = Math.max(2, Math.ceil(bandwidth * n))
  const smoothed = new Map<number, number>()

  for (const pt of pts) {
    const dists    = pts.map(p => ({ p, d: Math.abs(p.x - pt.x) }))
    dists.sort((a, b) => a.d - b.d)
    const neighbors = dists.slice(0, span)
    const maxDist   = neighbors[neighbors.length - 1].d || 1

    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0
    for (const { p, d } of neighbors) {
      const u = d / maxDist
      const w = Math.pow(1 - Math.pow(u, 3), 3)
      sw   += w
      swx  += w * p.x
      swy  += w * p.y
      swxx += w * p.x * p.x
      swxy += w * p.x * p.y
    }

    const denom = sw * swxx - swx * swx
    const b     = denom !== 0 ? (sw * swxy - swx * swy) / denom : 0
    const a     = (swy - b * swx) / sw
    smoothed.set(pt.i, a + b * pt.x)
  }

  return data.map((d, i) => ({
    ...d,
    egc: smoothed.has(i) ? smoothed.get(i)! : d.egc,
  }))
}

// ── buildTimepointTotals ───────────────────────────────────────────────────
// Compute the sum of EGC across all displayed series at each timepoint.
// Used by MultiEgcChart to provide per-timepoint denominators for L1 mode,
// giving a true cross-series depth-normalised abundance.

import { extractEgc } from './stats'
import type { AnnotationItem } from '../types'

export function buildTimepointTotals(
  allSeries: { data: AnnotationItem[] }[],
): Map<string, number> {
  const totals = new Map<string, number>()

  for (const s of allSeries) {
    for (const d of s.data) {
      const dt = d.timepoint?.datetime ?? ''
      if (!dt) continue
      const egc = extractEgc(d.value)
      if (egc === null) continue
      totals.set(dt, (totals.get(dt) ?? 0) + egc)
    }
  }

  return totals
}
