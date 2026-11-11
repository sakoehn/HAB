// ── Statistics Utilities ──────────────────────────────────────────────────────
// Pure functions for descriptive statistics and EGC value extraction.
// No React imports — all functions are fully testable in Node.

import type { DescStats, AnnotationItem, TopAnnotation, ChartMetric } from '../types'
import { parseDateTime, isoDate } from './format'
import { taxonomyRankLabel } from '../constants'

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
// norm_egc = egc / the sample's depth-weighted annotated-gene total, from the pipeline.
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

// ── Annotation Lookup detail-card field resolution ──────────────────────────
// /search/annotations exposes category/scaffold_count/depth as top-level
// fields on the row; these helpers also accept the older nested shape
// (`value.category`, `value.scaffolds`) so the UI works with either.
//
// scaffold_count is a real count from *a* sample chosen by an unordered
// SQL LIMIT 1 -- not "the earliest sample". Picking the earliest would need
// a per-row correlated subquery ordered by sample date, which isn't stored
// in SQL at all (sample chronology lives only in the separate TIMEPOINTS
// lookup on the Python side).

export function resolveLookupCategory(r: TopAnnotation): string | null {
  return r.category ?? r.value?.category ?? null
}

export function resolveLookupScaffoldCount(r: TopAnnotation): number | null {
  if (r.scaffold_count != null) return r.scaffold_count
  return r.value?.scaffolds ? Object.keys(r.value.scaffolds).length : null
}

export function resolveLookupDepth(r: TopAnnotation): number | null {
  return r.depth ?? r.value?.depth ?? null
}

// depthLabel
// Human-readable hierarchy label for the Annotation Lookup detail card's
// "Depth" row. Source-specific rank names for kegg/cog/enzyme; taxonomy
// defers to taxonomyRankLabel (domain-aware rank names), since taxonomy's
// hierarchy depth means something different per domain. Extracted out of
// ExplorePage so it's a real, independently-testable function rather than
// a hand-copied mirror in a test file.
//
// KEGG's third level is not only pathways: KEGG's file also puts its Brite
// protein-family tables (names ending "[BR:...]", e.g. Transporters) and
// its "Not Included in Pathway or Brite" bins there. Given the entry's
// name, the label says which; without one it names the whole level.

function keggLevel3Label(name: string | null | undefined): string {
  if (name == null)          return 'pathway / BRITE table'
  if (name.includes('[PATH:')) return 'pathway'
  if (name.includes('[BR:'))   return 'BRITE table'
  return 'KEGG group'
}

export function depthLabel(depth: number, source: string, name?: string | null): string {
  if (source === 'kegg' && depth === 3) return keggLevel3Label(name)
  if (source === 'kegg')     return ({ 1: 'pathway class', 2: 'subcategory', 4: 'leaf (KO)' } as Record<number, string>)[depth] ?? String(depth)
  if (source === 'cog')      return ({ 1: 'category', 2: 'leaf (COG)' } as Record<number, string>)[depth] ?? String(depth)
  if (source === 'enzyme')   return ({ 1: 'class', 2: 'subclass', 3: 'sub-subclass', 4: 'leaf (EC)' } as Record<number, string>)[depth] ?? String(depth)
  if (source === 'taxonomy') return taxonomyRankLabel(depth)
  return String(depth)
}

// ── seriesMeanInRange ──────────────────────────────────────────────────────
// Mean of one series' active metric over the points inside an optional
// date window -- the Compare page's per-entry chip mean. Same extraction as
// Analyze's card-header mean (extractEgc / extractNormEgc) and the same
// inclusive window rule MultiEgcChart filters its own points by (isoDate of
// timepoint.datetime vs dateFrom/dateTo, '' = unbounded), so the number
// always describes exactly what the chart is drawing. Points with no value
// for the metric are skipped (not counted as zero). null if none remain.

export function seriesMeanInRange(
  data:     { timepoint?: { datetime?: string } | null; value: unknown }[],
  metric:   ChartMetric,
  dateFrom: string,
  dateTo:   string,
): { mean: number; n: number } | null {
  const extract = metric === 'norm_egc' ? extractNormEgc : extractEgc
  const vals: number[] = []
  for (const d of data) {
    const iso = isoDate(d.timepoint?.datetime ?? '')
    if (dateFrom && iso < dateFrom) continue
    if (dateTo   && iso > dateTo)   continue
    const v = extract(d.value)
    if (v !== null) vals.push(v)
  }
  if (!vals.length) return null
  return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length }
}

// ── seriesMeanOverSamples ──────────────────────────────────────────────────
// Mean of one series' active metric over the given samples -- the Analyze
// card-header mean, restricted to the samples EgcChart reports it is
// drawing (after its date range and Timepoints filters). null samples means
// every point. Points with no value for the metric are skipped, as above.

export function seriesMeanOverSamples(
  data:    { sample?: string; value: unknown }[],
  metric:  ChartMetric,
  samples: Set<string> | null,
): { mean: number; n: number } | null {
  const extract = metric === 'norm_egc' ? extractNormEgc : extractEgc
  const vals: number[] = []
  for (const d of data) {
    if (samples && !samples.has(d.sample ?? '')) continue
    const v = extract(d.value)
    if (v !== null) vals.push(v)
  }
  if (!vals.length) return null
  return { mean: vals.reduce((a, b) => a + b, 0) / vals.length, n: vals.length }
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

// ── sumMembersByTimestamp ───────────────────────────────────────────────────
// Collapse several member annotations' per-sample series into ONE series,
// summing egc/norm_egc per timestamp across members -- for charts (e.g. the
// Explore overview's "Summed EGC over time") that plot a functional group's
// total, not an individual member.
//
// Downstream chart code (MultiEgcChart's baseRows) builds one row per
// (annotationId, datetime) and assigns each datapoint by simple overwrite —
// it was never meant to receive more than one raw datapoint per group per
// timestamp. Handing it every member's raw datapoint under the same group
// label/annotationId makes each overwrite the last, silently dropping every
// member but one. This function does the actual summation up front so
// callers pass one already-aggregated datapoint per timestamp.
//
// memberAnnotationIds: the annotation_ids belonging to this group.
// seriesData: per-annotation-id raw series, as returned by /series/annotations.
// groupLabel: used as both annotation_id and name on the returned points.
// source: passed through onto each returned point.
//
// Output is sorted chronologically by real parsed timestamp, not by
// insertion/Map order (a naive `.datetime.localeCompare(...)` string sort
// is wrong against the real unpadded "M/D/YY H:MM" API format, e.g.
// "6/10/21" sorts before "6/2/21" as text). Downstream chart code happens to re-sort again
// defensively, but a caller reading this function's return value directly
// (e.g. a CSV export) must not depend on that -- the data is sorted here,
// at the source, once.

export function sumMembersByTimestamp(
  memberAnnotationIds: string[],
  seriesData: Record<string, AnnotationItem[]>,
  groupLabel: string,
  source: string,
): AnnotationItem[] {
  const byDt = new Map<string, { timepoint: AnnotationItem['timepoint']; egc: number; normEgc: number; sawNorm: boolean }>()

  for (const annId of memberAnnotationIds) {
    const annData = seriesData[annId] ?? []
    for (const d of annData) {
      const dt = d.timepoint?.datetime ?? ''
      let entry = byDt.get(dt)
      if (!entry) {
        entry = { timepoint: d.timepoint, egc: 0, normEgc: 0, sawNorm: false }
        byDt.set(dt, entry)
      }
      const egc = extractEgc(d.value)
      if (egc !== null) entry.egc += egc
      const normEgc = extractNormEgc(d.value)
      if (normEgc !== null) { entry.normEgc += normEgc; entry.sawNorm = true }
    }
  }

  return Array.from(byDt.entries())
    .sort(([dtA], [dtB]) => parseDateTime(dtA) - parseDateTime(dtB))
    .map(([, v]) => ({
      source,
      sample:        '',
      timepoint:     v.timepoint,
      annotation_id: groupLabel,
      name:          groupLabel,
      value:         { egc: v.egc, norm_egc: v.sawNorm ? v.normEgc : null },
    }))
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
