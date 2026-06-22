// ── Statistics Utilities ──────────────────────────────────────────────────────
// Pure functions for descriptive statistics and EGC value extraction.
// No React imports — all functions are fully testable in Node.

import type { DescStats } from '../types'

// ── EGC value extraction ───────────────────────────────────────────────────
// Annotation JSON values vary in shape across sources — some are bare numbers,
// others are objects with an egc or norm_egc field.  These two helpers
// normalise that into a single nullable number.

// extractEgc
// Extract raw EGC from an annotation value.
// Handles: bare number | { egc: number } | { EGC: number }

export function extractEgc(value: unknown): number | null {
  if (typeof value === 'number') return value
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.egc === 'number') return v.egc
    if (typeof v.EGC === 'number') return v.EGC
  }
  return null
}

// extractNormEgc
// Extract pre-computed norm_egc from an annotation value.
// norm_egc = egc / total_sample_depth — depth-normalised by the pipeline.
// Used by L1 mode so the chart shows true relative abundance without
// re-dividing by an arbitrary series total.

export function extractNormEgc(value: unknown): number | null {
  if (value && typeof value === 'object') {
    const v = value as Record<string, unknown>
    if (typeof v.norm_egc === 'number') return v.norm_egc
    if (typeof v.NORM_EGC === 'number') return v.NORM_EGC
  }
  return null
}

// ── computeStats ───────────────────────────────────────────────────────────
// Compute descriptive statistics on an array of numbers.
// Returns null for empty arrays.
//
// Std dev: sample (÷ n-1), Bessel-corrected.  Labelled "s" in the UI to
// distinguish from population σ.
//
// Q1/Q3: Type 7 linear interpolation (R default, numpy default).
// At index h = (n-1)*p:
//   value = sorted[floor(h)] + frac(h) * (sorted[ceil(h)] - sorted[floor(h)])
// This matches R's quantile() and numpy.percentile() so researchers can
// reproduce results outside the portal.

export function computeStats(vals: number[]): DescStats | null {
  if (vals.length === 0) return null

  const sorted = [...vals].sort((a, b) => a - b)
  const n      = sorted.length
  const mean   = sorted.reduce((a, b) => a + b, 0) / n

  const median = n % 2 === 0
    ? (sorted[n / 2 - 1] + sorted[n / 2]) / 2
    : sorted[Math.floor(n / 2)]

  // Sample std dev — Bessel-corrected (÷ n-1)
  const std = n > 1
    ? Math.sqrt(sorted.reduce((a, b) => a + (b - mean) ** 2, 0) / (n - 1))
    : 0

  // Type 7 linear interpolation for quartiles
  function quantile(p: number): number {
    const h    = (n - 1) * p
    const lo   = Math.floor(h)
    const hi   = Math.ceil(h)
    const frac = h - lo
    return lo === hi ? sorted[lo] : sorted[lo] + frac * (sorted[hi] - sorted[lo])
  }

  const q1 = quantile(0.25)
  const q3 = quantile(0.75)

  return {
    n,
    mean,
    median,
    std,
    min: sorted[0],
    max: sorted[n - 1],
    q1,
    q3,
    cv: mean !== 0 ? std / mean : 0,
  }
}

/**
 * Compute min, mean, and max for a set of (value, date) rows, also
 * returning the date associated with the min and max values — so callers
 * can show "which sample" produced the extreme.
 *
 * If multiple rows tie for min/max, the first one encountered is used.
 * Returns null if rows is empty.
 */
export function minMeanMax(
  rows: { value: number; date: string }[],
): { min: number; minDate: string; mean: number; max: number; maxDate: string } | null {
  if (!rows.length) return null

  let minRow = rows[0]
  let maxRow = rows[0]
  let sum    = 0

  for (const row of rows) {
    if (row.value < minRow.value) minRow = row
    if (row.value > maxRow.value) maxRow = row
    sum += row.value
  }

  const mean = sum / rows.length

  return {
    min:     minRow.value,
    minDate: minRow.date,
    mean:    Math.round(mean * 10) / 10,
    max:     maxRow.value,
    maxDate: maxRow.date,
  }
}

// ── computeTrend ───────────────────────────────────────────────────────────
// Quick trend indicator: mean of the last quarter of timepoints minus the
// mean of the first quarter.
//
// Positive → annotation is increasing over the bloom.
// Negative → decreasing.
// null     → fewer than 4 points (not enough data for a meaningful trend).
//
// Always computed on raw EGC regardless of chart normalisation mode.

export function computeTrend(egcValues: number[]): number | null {
  if (egcValues.length < 4) return null

  const q         = Math.floor(egcValues.length / 4)
  const firstQ    = egcValues.slice(0, q)
  const lastQ     = egcValues.slice(-q)
  const meanFirst = firstQ.reduce((a, b) => a + b, 0) / firstQ.length
  const meanLast  = lastQ.reduce((a, b) => a + b, 0) / lastQ.length

  return meanLast - meanFirst
}
