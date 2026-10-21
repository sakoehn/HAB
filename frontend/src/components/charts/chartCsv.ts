// CSV rows for the chart exports (the ↓ CSV buttons), built from exactly
// what each chart draws. Kept apart from the chart components so those
// files export only components.

import type { ChartMetric } from '../../types'

export function buildEgcTimeseriesCsvRows(
  points:       { sample: string; datetime: string; egc: number | null; tide_wl?: number | null }[],
  annotationId: string,
  metric:       ChartMetric,
  standardize:  boolean,
  smoothed:     boolean,
  showTide:     boolean,
): Record<string, unknown>[] {
  return points.map(d => ({
    annotation_id: annotationId,
    sample:        d.sample,
    date:          d.datetime,
    [metric]:      d.egc,
    metric,
    standardized:  standardize,
    smoothed,
    ...(showTide ? { tide_predicted_wl_m: d.tide_wl } : {}),
  }))
}

// buildGroupedEgcCsvRows
// Exported so tests can exercise the real CSV row shape directly.
// The value column is named from the active metric, with metric/
// standardized/smoothed recorded on every row, so the CSV records which
// transform (metric swap, z-score, LOWESS smoothing) was applied.
export function buildGroupedEgcCsvRows(
  points:      { datetime: string; egc: number | null; tide_wl?: number | null }[],
  groupLabel:  string,
  metric:      ChartMetric,
  standardize: boolean,
  smoothed:    boolean,
  showTide:    boolean,
): Record<string, unknown>[] {
  return points.map(d => ({
    group:        groupLabel,
    date:         d.datetime,
    [metric]:     d.egc,
    metric,
    standardized: standardize,
    smoothed,
    ...(showTide ? { tide_predicted_wl_m: d.tide_wl } : {}),
  }))
}

// buildMultiEgcCsvRows
// Exported so tests can exercise the real CSV row shape directly.
// The value column is named from the active metric, with
// metric/standardized/smoothed recorded on every row.
export function buildMultiEgcCsvRows(
  chartData:   Record<string, unknown>[],
  series:      { id: string; annotationId: string; source?: string }[],
  metric:      ChartMetric,
  standardize: boolean,
  smoothed:    boolean,
  showTide:    boolean,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const row of chartData) {
    for (const s of series) {
      const val = row[s.id]
      if (val !== null && val !== undefined) {
        rows.push({
          annotation_id: s.annotationId,
          source:        s.source ?? '',
          date:          row._dt ?? row.date,
          [metric]:      val,
          metric,
          standardized:  standardize,
          smoothed,
          ...(showTide ? { tide_predicted_wl_m: row.tide_wl ?? null } : {}),
        })
      }
    }
  }
  return rows
}
