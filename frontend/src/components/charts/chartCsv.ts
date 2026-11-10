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
// members_detected / members_total say how many of the group's members the
// sum at that sample actually covers.
export function buildGroupedEgcCsvRows(
  points:       { sample: string; datetime: string; egc: number | null; membersDetected: number; tide_wl?: number | null }[],
  groupLabel:   string,
  membersTotal: number,
  metric:       ChartMetric,
  standardize: boolean,
  smoothed:    boolean,
  showTide:    boolean,
): Record<string, unknown>[] {
  return points.map(d => ({
    group:            groupLabel,
    sample:           d.sample,
    date:             d.datetime,
    [metric]:         d.egc,
    members_detected: d.membersDetected,
    members_total:    membersTotal,
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
// One row per timepoint and series, including timepoints a series wasn't
// detected at (value null, detected false), so "not detected" can be told
// from "not sampled". standardized/smoothed come per series from `flags`,
// matching how each line was actually drawn (a series too short to smooth
// or z-score is drawn raw even when the toggle is on).
export function buildMultiEgcCsvRows(
  chartData: Record<string, unknown>[],
  series:    { id: string; annotationId: string; source?: string }[],
  metric:    ChartMetric,
  flags:     (seriesId: string) => { standardized: boolean; smoothed: boolean },
  showTide:  boolean,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const row of chartData) {
    for (const s of series) {
      const val = row[s.id]
      const detected = val !== null && val !== undefined
      rows.push({
        annotation_id: s.annotationId,
        source:        s.source ?? '',
        sample:        row._sample ?? '',
        date:          row._dt ?? row.date,
        [metric]:      detected ? val : null,
        detected,
        metric,
        ...flags(s.id),
        ...(showTide ? { tide_predicted_wl_m: row.tide_wl ?? null } : {}),
      })
    }
  }
  return rows
}
