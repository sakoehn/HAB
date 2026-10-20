/**
 * egc-csv-export.unit.test.ts
 * ============================
 * Unit tests for the CSV row-builder functions behind each EGC chart's
 * "↓ CSV" button.
 *
 * Each chart's CSV export names its value column from the active metric
 * and records which transforms (metric swap, standardize/z-score, LOWESS
 * smoothing) are active on the exported values -- otherwise a file
 * labelled "egc" could silently hold relative abundance fractions,
 * z-scores, or a smoothed fit. The Compare page's export is MultiEgcChart's
 * own, covered here by testing buildMultiEgcCsvRows.
 *
 * Tests import directly from the production chart component files (each
 * function was extracted out of an inline handleExportCsv closure
 * specifically so it could be tested standalone here).
 *
 * Coverage
 * --------
 * buildEgcTimeseriesCsvRows (EgcChart.tsx):
 *   value column named "egc" in raw mode, "norm_egc" in norm mode
 *   metric/standardized/smoothed columns always present
 *   tide column only present when showTide is true
 *
 * buildMultiEgcCsvRows (MultiEgcChart.tsx):
 *   value column named from metric, not hardcoded "egc_normalized"
 *   rows only emitted for non-null/non-undefined series values
 *   multiple series per row produce multiple output rows
 *
 * buildGroupedEgcCsvRows (GroupedEgcChart.tsx):
 *   value column named from metric, not hardcoded "egc"
 *   metric/standardized/smoothed columns always present
 *
 * Run: npx vitest run src/tests/egc-csv-export.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { buildEgcTimeseriesCsvRows } from '../components/charts/EgcChart'
import { buildMultiEgcCsvRows } from '../components/charts/MultiEgcChart'
import { buildGroupedEgcCsvRows } from '../components/charts/GroupedEgcChart'

// ─────────────────────────────────────────────────────────────────────────────
// buildEgcTimeseriesCsvRows
// ─────────────────────────────────────────────────────────────────────────────

describe('buildEgcTimeseriesCsvRows', () => {
  const points = [
    { sample: 's1', datetime: '5/27/21 8:00', egc: 100 },
    { sample: 's2', datetime: '5/27/21 12:00', egc: 200 },
  ]

  it('raw egc mode: value column is named "egc"', () => {
    const rows = buildEgcTimeseriesCsvRows(points, 'K00001', 'egc', false, false, false)
    expect(rows[0]).toHaveProperty('egc', 100)
    expect(rows[0]).not.toHaveProperty('norm_egc')
  })

  it('norm_egc mode: value column is named "norm_egc", not "egc"', () => {
    const rows = buildEgcTimeseriesCsvRows(points, 'K00001', 'norm_egc', false, false, false)
    expect(rows[0]).toHaveProperty('norm_egc', 100)
    expect(rows[0]).not.toHaveProperty('egc')
  })

  it('metric/standardized/smoothed are always recorded, reflecting the actual toggle state', () => {
    const rows = buildEgcTimeseriesCsvRows(points, 'K00001', 'egc', true, true, false)
    expect(rows[0].metric).toBe('egc')
    expect(rows[0].standardized).toBe(true)
    expect(rows[0].smoothed).toBe(true)
  })

  it('standardized/smoothed are false, not just absent, when neither is active', () => {
    const rows = buildEgcTimeseriesCsvRows(points, 'K00001', 'egc', false, false, false)
    expect(rows[0].standardized).toBe(false)
    expect(rows[0].smoothed).toBe(false)
  })

  it('tide column present only when showTide is true', () => {
    const withTide = [{ ...points[0], tide_wl: 1.5 }]
    const shown  = buildEgcTimeseriesCsvRows(withTide, 'K00001', 'egc', false, false, true)
    const hidden = buildEgcTimeseriesCsvRows(withTide, 'K00001', 'egc', false, false, false)
    expect(shown[0]).toHaveProperty('tide_predicted_wl_m', 1.5)
    expect(hidden[0]).not.toHaveProperty('tide_predicted_wl_m')
  })

  it('annotation_id and sample/date carry through unchanged', () => {
    const rows = buildEgcTimeseriesCsvRows(points, 'K00001', 'egc', false, false, false)
    expect(rows[0].annotation_id).toBe('K00001')
    expect(rows[0].sample).toBe('s1')
    expect(rows[0].date).toBe('5/27/21 8:00')
  })

  it('empty points: returns []', () => {
    expect(buildEgcTimeseriesCsvRows([], 'K00001', 'egc', false, false, false)).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildMultiEgcCsvRows
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMultiEgcCsvRows', () => {
  const series = [
    { id: 'K00001', annotationId: 'K00001', source: 'kegg' },
    { id: 'COG0001', annotationId: 'COG0001', source: 'cog' },
  ]
  const chartData = [
    { date: '05/27/21', _dt: '5/27/21 8:00', K00001: 100, COG0001: 50 },
    { date: '05/27/21', _dt: '5/27/21 12:00', K00001: null, COG0001: 60 },
  ]

  it('raw egc mode: value column is named "egc", not "egc_normalized"', () => {
    const rows = buildMultiEgcCsvRows(chartData, series, 'egc', false, false, false)
    expect(rows.every(r => 'egc' in r)).toBe(true)
    expect(rows.some(r => 'egc_normalized' in r)).toBe(false)
  })

  it('norm_egc mode: value column is named "norm_egc"', () => {
    const rows = buildMultiEgcCsvRows(chartData, series, 'norm_egc', false, false, false)
    expect(rows.every(r => 'norm_egc' in r)).toBe(true)
  })

  it('one row per (chartData row × series) pair with a non-null value', () => {
    const rows = buildMultiEgcCsvRows(chartData, series, 'egc', false, false, false)
    // row 1: both K00001 and COG0001 present -> 2 rows
    // row 2: K00001 is null (skipped), COG0001 present -> 1 row
    expect(rows).toHaveLength(3)
  })

  it('null/undefined series values are skipped entirely, not exported as empty rows', () => {
    const rows = buildMultiEgcCsvRows(chartData, series, 'egc', false, false, false)
    const k00001Rows = rows.filter(r => r.annotation_id === 'K00001')
    expect(k00001Rows).toHaveLength(1)
    expect(k00001Rows[0].egc).toBe(100)
  })

  it('smoothed is recorded (was entirely absent pre-fix)', () => {
    const rows = buildMultiEgcCsvRows(chartData, series, 'egc', false, true, false)
    expect(rows[0].smoothed).toBe(true)
  })

  it('metric/standardized already existed pre-fix and still work correctly', () => {
    const rows = buildMultiEgcCsvRows(chartData, series, 'norm_egc', true, false, false)
    expect(rows[0].metric).toBe('norm_egc')
    expect(rows[0].standardized).toBe(true)
  })

  it('date falls back to row.date when row._dt is absent', () => {
    const rows = buildMultiEgcCsvRows(
      [{ date: '05/27/21', K00001: 100 }], [series[0]], 'egc', false, false, false,
    )
    expect(rows[0].date).toBe('05/27/21')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Two different groups can share the exact same user-typed label
// (annotationId, for a group) while summing completely different, unrelated
// members -- chartData rows are keyed by `id`, so the second same-labelled
// group's data must not overwrite the first's (e.g. two different
// "iron (2)" groups, one kegg/one cog).
// ─────────────────────────────────────────────────────────────────────────────

describe('buildMultiEgcCsvRows — same-label groups', () => {
  it('two series sharing the same annotationId (label) export their own distinct values, keyed by id', () => {
    const series = [
      { id: 'group::iron::1000', annotationId: 'iron (2)', source: 'kegg' },
      { id: 'group::iron::2000', annotationId: 'iron (2)', source: 'cog' },
    ]
    const chartData = [
      {
        date: '05/27/21', _dt: '5/27/21 8:00',
        'group::iron::1000': 300,
        'group::iron::2000': 170000,
      },
    ]

    const rows = buildMultiEgcCsvRows(chartData, series, 'egc', false, false, false)

    expect(rows).toHaveLength(2)
    const keggRow = rows.find(r => r.source === 'kegg')
    const cogRow  = rows.find(r => r.source === 'cog')
    // Both rows correctly read "iron (2)" as their displayed annotation_id
    // (expected -- that's genuinely what the user typed for both) --
    // the bug was that their VALUES collided, not their labels.
    expect(keggRow?.annotation_id).toBe('iron (2)')
    expect(cogRow?.annotation_id).toBe('iron (2)')
    expect(keggRow?.egc).toBe(300)
    expect(cogRow?.egc).toBe(170000)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildGroupedEgcCsvRows
// ─────────────────────────────────────────────────────────────────────────────

describe('buildGroupedEgcCsvRows', () => {
  const points = [
    { datetime: '5/27/21 8:00', egc: 300 },
    { datetime: '5/27/21 12:00', egc: 400 },
  ]

  it('raw egc mode: value column is named "egc" because the mode is egc, not as a fixed literal', () => {
    // The bug was a column ALWAYS named "egc" even in norm_egc mode --
    // this pins that raw mode is still correctly "egc" (the un-buggy case).
    const rows = buildGroupedEgcCsvRows(points, 'Brite Hierarchies', 'egc', false, false, false)
    expect(rows[0]).toHaveProperty('egc', 300)
  })

  it('norm_egc mode: value column is named "norm_egc", not left as "egc"', () => {
    const rows = buildGroupedEgcCsvRows(points, 'Brite Hierarchies', 'norm_egc', false, false, false)
    expect(rows[0]).toHaveProperty('norm_egc', 300)
    expect(rows[0]).not.toHaveProperty('egc')
  })

  it('metric/standardized/smoothed are recorded (all three were entirely absent pre-fix)', () => {
    const rows = buildGroupedEgcCsvRows(points, 'Brite Hierarchies', 'egc', true, true, false)
    expect(rows[0].metric).toBe('egc')
    expect(rows[0].standardized).toBe(true)
    expect(rows[0].smoothed).toBe(true)
  })

  it('group label carries through on every row', () => {
    const rows = buildGroupedEgcCsvRows(points, 'Brite Hierarchies', 'egc', false, false, false)
    expect(rows.every(r => r.group === 'Brite Hierarchies')).toBe(true)
  })

  it('tide column present only when showTide is true', () => {
    const withTide = [{ ...points[0], tide_wl: 2.1 }]
    const shown  = buildGroupedEgcCsvRows(withTide, 'g', 'egc', false, false, true)
    const hidden = buildGroupedEgcCsvRows(withTide, 'g', 'egc', false, false, false)
    expect(shown[0]).toHaveProperty('tide_predicted_wl_m', 2.1)
    expect(hidden[0]).not.toHaveProperty('tide_predicted_wl_m')
  })

  it('empty points: returns []', () => {
    expect(buildGroupedEgcCsvRows([], 'g', 'egc', false, false, false)).toEqual([])
  })
})
