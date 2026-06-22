/**
 * scaffold-explore.unit.test.ts
 * ==============================
 * Unit tests for ScaffoldExplorePanel logic and scaffold data utilities.
 *
 * Tests import directly from production source files where possible.
 * Pure logic helpers are defined inline (they have no production import
 * because they live inside component functions).
 *
 * Coverage
 * --------
 * Scaffold summary sorting (ScaffoldModal table):
 *   sort by date asc/desc
 *   sort by scaffold_count asc/desc
 *   sort by gene_count asc/desc
 *   stable — does not mutate original array
 *   handles empty input
 *   handles equal values
 *
 * Stat strip computation (ScaffoldModal header stats):
 *   sampleCount
 *   peakScaffolds
 *   peakGenes
 *   avgGenesPerSample (rounded)
 *   single-row edge case
 *   empty input returns null
 *
 * Aggregated chart rows (ScaffoldExplorePanel — split:false):
 *   sums scaffold_count across terms per date
 *   sums gene_count across terms per date
 *   includes dates unique to one term
 *   sorted chronologically
 *   dateFrom filter excludes earlier dates
 *   dateTo filter excludes later dates
 *   empty termSummaries returns []
 *   does not double-count same date (sum not last-write-wins)
 *
 * Split chart rows (ScaffoldExplorePanel — split:true):
 *   one column per term + date
 *   fills 0 for terms absent on a date
 *   scaffold_count metric correct
 *   gene_count metric correct
 *   dateFrom/dateTo filters applied
 *   sorted chronologically
 *   empty input returns []
 *
 * Term management (ScaffoldExplorePanel):
 *   addTerm — adds new term
 *   addTerm — rejects duplicate (same id + source)
 *   addTerm — allows same id from different source
 *   removeTerm — removes correct term
 *   removeTerm — unknown term leaves list unchanged
 *   color index wraps around when > palette length
 *   does not mutate input arrays
 *
 * Detail row filtering (ScaffoldModal drill-down):
 *   filter by sample — returns only matching rows
 *   filter by sample — empty when sample not found
 *   filter by sample — handles multiple matches
 *   does not mutate input
 *
 * Detail pagination (show-more):
 *   shows 10 rows when showAll=false and > 10 exist
 *   shows all rows when showAll=true
 *   shows all rows when < 10 exist regardless of showAll
 *   show-more visible when rows > 10 and showAll=false
 *   show-more hidden when showAll=true
 *
 * CSV export shape:
 *   toExportRow — all 7 required fields
 *   date/time split from combined datetime string
 *   handles missing time component
 *   scaffold_count and gene_count are numbers
 *
 * utils/format.ts — fmtDate and fmtTime:
 *   used in ScaffoldModal table date/time columns
 *
 * Run: npx vitest run src/tests/scaffold-explore.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { fmtDate, fmtTime } from '../utils/format'
import type { ScaffoldSummaryRow, ScaffoldDetailRow } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// Pure helpers (mirror component-internal logic)
// ─────────────────────────────────────────────────────────────────────────────

type ScaffoldSortCol = 'date' | 'scaffold_count' | 'gene_count'
type SortDir        = 'asc' | 'desc'

function sortSummaryRows(
  rows:    ScaffoldSummaryRow[],
  col:     ScaffoldSortCol,
  dir:     SortDir,
): ScaffoldSummaryRow[] {
  return [...rows].sort((a, b) => {
    const av = col === 'date' ? a.date : a[col]
    const bv = col === 'date' ? b.date : b[col]
    if (typeof av === 'number' && typeof bv === 'number') {
      return dir === 'asc' ? av - bv : bv - av
    }
    return dir === 'asc'
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av))
  })
}

function computeStatStrip(rows: ScaffoldSummaryRow[]): {
  sampleCount:       number
  peakScaffolds:     number
  peakGenes:         number
  avgGenesPerSample: number
} | null {
  if (!rows.length) return null
  return {
    sampleCount:       rows.length,
    peakScaffolds:     Math.max(...rows.map(r => r.scaffold_count)),
    peakGenes:         Math.max(...rows.map(r => r.gene_count)),
    avgGenesPerSample: Math.round(
      rows.reduce((s, r) => s + r.gene_count, 0) / rows.length,
    ),
  }
}

function buildAggregatedChartRows(
  termSummaries: ScaffoldSummaryRow[][],
  dateFrom:      string,
  dateTo:        string,
): { date: string; scaffold_count: number; gene_count: number }[] {
  const dateMap: Record<string, { scaffold_count: number; gene_count: number; date: string }> = {}
  for (const rows of termSummaries) {
    for (const row of rows) {
      if (dateFrom && row.date < dateFrom) continue
      if (dateTo   && row.date > dateTo)   continue
      if (!dateMap[row.date]) {
        dateMap[row.date] = { scaffold_count: 0, gene_count: 0, date: row.date }
      }
      dateMap[row.date].scaffold_count += row.scaffold_count
      dateMap[row.date].gene_count     += row.gene_count
    }
  }
  return Object.values(dateMap).sort((a, b) => a.date.localeCompare(b.date))
}

function buildSplitChartRows(
  termSummaries: { id: string; rows: ScaffoldSummaryRow[] }[],
  metric:        'scaffold_count' | 'gene_count',
  dateFrom:      string,
  dateTo:        string,
): { date: string; [termId: string]: string | number }[] {
  const dateSet = new Set<string>()
  for (const { rows } of termSummaries) {
    for (const r of rows) {
      if (dateFrom && r.date < dateFrom) continue
      if (dateTo   && r.date > dateTo)   continue
      dateSet.add(r.date)
    }
  }
  return Array.from(dateSet).sort().map(date => {
    const row: { date: string; [k: string]: string | number } = { date }
    for (const { id, rows } of termSummaries) {
      const found = rows.find(r => r.date === date)
      row[id]     = found ? found[metric] : 0
    }
    return row
  })
}

type Term = { annotationId: string; source: string }

function addTermToList(existing: Term[], candidate: Term): Term[] {
  if (existing.some(
    t => t.annotationId === candidate.annotationId && t.source === candidate.source,
  )) return existing
  return [...existing, candidate]
}

function removeTermFromList(existing: Term[], target: Term): Term[] {
  return existing.filter(
    t => !(t.annotationId === target.annotationId && t.source === target.source),
  )
}

function filterDetailBySample(
  rows:   ScaffoldDetailRow[],
  sample: string,
): ScaffoldDetailRow[] {
  return rows.filter(r => r.sample === sample)
}

const DETAIL_PAGE = 10

function visibleDetailRows(rows: ScaffoldDetailRow[], showAll: boolean): ScaffoldDetailRow[] {
  return showAll ? rows : rows.slice(0, DETAIL_PAGE)
}

function toExportRow(
  r:            ScaffoldSummaryRow,
  annotationId: string,
  source:       string,
) {
  return {
    annotation_id:  annotationId,
    source,
    sample:         r.sample,
    date:           r.date.split(' ')[0] ?? '',
    time:           r.date.split(' ')[1] ?? '',
    scaffold_count: r.scaffold_count,
    gene_count:     r.gene_count,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_SUMMARY: ScaffoldSummaryRow[] = [
  { sample: 's1', date: '2021-05-10 08:00', scaffold_count: 3,  gene_count: 7  },
  { sample: 's2', date: '2021-05-10 12:00', scaffold_count: 5,  gene_count: 12 },
  { sample: 's3', date: '2021-05-11 08:00', scaffold_count: 1,  gene_count: 2  },
  { sample: 's4', date: '2021-05-11 16:00', scaffold_count: 9,  gene_count: 22 },
  { sample: 's5', date: '2021-05-12 08:00', scaffold_count: 4,  gene_count: 8  },
]

const SAMPLE_DETAIL: ScaffoldDetailRow[] = [
  { sample: 's1', date: '2021-05-10 08:00', scaffold: 'Ga0590986_0000001', count: 3 },
  { sample: 's1', date: '2021-05-10 08:00', scaffold: 'Ga0590986_0000002', count: 4 },
  { sample: 's2', date: '2021-05-10 12:00', scaffold: 'Ga0590986_0000010', count: 12 },
]

const TERM_A: ScaffoldSummaryRow[] = [
  { sample: 'a1', date: '2021-05-10 08:00', scaffold_count: 2, gene_count: 5  },
  { sample: 'a2', date: '2021-05-10 12:00', scaffold_count: 3, gene_count: 8  },
]

const TERM_B: ScaffoldSummaryRow[] = [
  { sample: 'b1', date: '2021-05-10 08:00', scaffold_count: 4, gene_count: 10 },
  { sample: 'b2', date: '2021-05-11 08:00', scaffold_count: 1, gene_count: 3  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Sorting
// ─────────────────────────────────────────────────────────────────────────────

describe('sortSummaryRows', () => {
  it('sorts by date asc: chronological order', () => {
    const result = sortSummaryRows(
      [SAMPLE_SUMMARY[2], SAMPLE_SUMMARY[0], SAMPLE_SUMMARY[4]],
      'date', 'asc',
    )
    expect(result[0].sample).toBe('s1')
    expect(result[1].sample).toBe('s3')
    expect(result[2].sample).toBe('s5')
  })

  it('sorts by date desc: reverse chronological', () => {
    const result = sortSummaryRows(SAMPLE_SUMMARY, 'date', 'desc')
    expect(result[0].sample).toBe('s5')
    expect(result[result.length - 1].sample).toBe('s1')
  })

  it('sorts by scaffold_count asc: 1, 3, 4, 5, 9', () => {
    const result = sortSummaryRows(SAMPLE_SUMMARY, 'scaffold_count', 'asc')
    expect(result[0].scaffold_count).toBe(1)
    expect(result[result.length - 1].scaffold_count).toBe(9)
  })

  it('sorts by scaffold_count desc: 9, 5, 4, 3, 1', () => {
    const result = sortSummaryRows(SAMPLE_SUMMARY, 'scaffold_count', 'desc')
    expect(result[0].scaffold_count).toBe(9)
    expect(result[result.length - 1].scaffold_count).toBe(1)
  })

  it('sorts by gene_count asc: 2, 7, 8, 12, 22', () => {
    const result = sortSummaryRows(SAMPLE_SUMMARY, 'gene_count', 'asc')
    expect(result[0].gene_count).toBe(2)
    expect(result[result.length - 1].gene_count).toBe(22)
  })

  it('sorts by gene_count desc: 22 first', () => {
    const result = sortSummaryRows(SAMPLE_SUMMARY, 'gene_count', 'desc')
    expect(result[0].gene_count).toBe(22)
  })

  it('does not mutate the original array', () => {
    const original = SAMPLE_SUMMARY.map(r => r.sample)
    sortSummaryRows(SAMPLE_SUMMARY, 'scaffold_count', 'asc')
    expect(SAMPLE_SUMMARY.map(r => r.sample)).toEqual(original)
  })

  it('handles empty array', () => {
    expect(sortSummaryRows([], 'date', 'asc')).toEqual([])
  })

  it('handles single-row array', () => {
    expect(sortSummaryRows([SAMPLE_SUMMARY[0]], 'date', 'asc')).toHaveLength(1)
  })

  it('equal scaffold_count values: both preserved', () => {
    const rows: ScaffoldSummaryRow[] = [
      { sample: 'x', date: '2021-05-10', scaffold_count: 5, gene_count: 10 },
      { sample: 'y', date: '2021-05-11', scaffold_count: 5, gene_count: 20 },
    ]
    const result = sortSummaryRows(rows, 'scaffold_count', 'asc')
    expect(result).toHaveLength(2)
    expect(result.every(r => r.scaffold_count === 5)).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Stat strip
// ─────────────────────────────────────────────────────────────────────────────

describe('computeStatStrip', () => {
  it('returns null for empty array', () => {
    expect(computeStatStrip([])).toBeNull()
  })

  it('counts samples correctly', () => {
    expect(computeStatStrip(SAMPLE_SUMMARY)!.sampleCount).toBe(5)
  })

  it('finds peak scaffolds: max(3,5,1,9,4) = 9', () => {
    expect(computeStatStrip(SAMPLE_SUMMARY)!.peakScaffolds).toBe(9)
  })

  it('finds peak genes: max(7,12,2,22,8) = 22', () => {
    expect(computeStatStrip(SAMPLE_SUMMARY)!.peakGenes).toBe(22)
  })

  it('computes avgGenesPerSample: (7+12+2+22+8)/5 = 10.2 → rounds to 10', () => {
    expect(computeStatStrip(SAMPLE_SUMMARY)!.avgGenesPerSample).toBe(10)
  })

  it('single-row: all stats equal that row', () => {
    const single = [{ sample: 'a', date: '2021-01-01', scaffold_count: 7, gene_count: 14 }]
    const s      = computeStatStrip(single)!
    expect(s.sampleCount).toBe(1)
    expect(s.peakScaffolds).toBe(7)
    expect(s.peakGenes).toBe(14)
    expect(s.avgGenesPerSample).toBe(14)
  })

  it('rounding: (1+2)/2 = 1.5 rounds to 2', () => {
    const rows: ScaffoldSummaryRow[] = [
      { sample: 'a', date: '2021-01-01', scaffold_count: 1, gene_count: 1 },
      { sample: 'b', date: '2021-01-02', scaffold_count: 1, gene_count: 2 },
    ]
    expect(computeStatStrip(rows)!.avgGenesPerSample).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Aggregated chart rows (split:false)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildAggregatedChartRows', () => {
  it('sums scaffold_count across terms for same date', () => {
    const rows = buildAggregatedChartRows([TERM_A, TERM_B], '', '')
    const may10_08 = rows.find(r => r.date === '2021-05-10 08:00')!
    // A:2 + B:4 = 6
    expect(may10_08.scaffold_count).toBe(6)
  })

  it('sums gene_count across terms for same date', () => {
    const rows = buildAggregatedChartRows([TERM_A, TERM_B], '', '')
    const may10_08 = rows.find(r => r.date === '2021-05-10 08:00')!
    // A:5 + B:10 = 15
    expect(may10_08.gene_count).toBe(15)
  })

  it('includes dates unique to one term', () => {
    const dates = buildAggregatedChartRows([TERM_A, TERM_B], '', '').map(r => r.date)
    expect(dates).toContain('2021-05-11 08:00') // only in TERM_B
    expect(dates).toContain('2021-05-10 12:00') // only in TERM_A
  })

  it('output is sorted chronologically', () => {
    const rows  = buildAggregatedChartRows([TERM_A, TERM_B], '', '')
    const dates = rows.map(r => r.date)
    expect(dates).toEqual([...dates].sort())
  })

  it('dateFrom filter excludes earlier dates', () => {
    const rows  = buildAggregatedChartRows([TERM_A, TERM_B], '2021-05-11', '')
    const dates = rows.map(r => r.date)
    expect(dates).not.toContain('2021-05-10 08:00')
    expect(dates).not.toContain('2021-05-10 12:00')
    expect(dates).toContain('2021-05-11 08:00')
  })

  it('dateTo filter excludes later dates', () => {
    const rows  = buildAggregatedChartRows([TERM_A, TERM_B], '', '2021-05-10')
    const dates = rows.map(r => r.date)
    expect(dates).not.toContain('2021-05-11 08:00')
  })

  it('empty termSummaries returns []', () => {
    expect(buildAggregatedChartRows([], '', '')).toEqual([])
  })

  it('single term with no filter: all rows present', () => {
    const rows = buildAggregatedChartRows([TERM_A], '', '')
    expect(rows).toHaveLength(TERM_A.length)
  })

  it('does not double-count: same date from two terms produces one row', () => {
    const rows     = buildAggregatedChartRows([TERM_A, TERM_B], '', '')
    const may10_08 = rows.filter(r => r.date === '2021-05-10 08:00')
    expect(may10_08).toHaveLength(1)          // one row
    expect(may10_08[0].scaffold_count).toBe(6) // summed, not replaced
  })

  it('completely out-of-range filter returns []', () => {
    expect(buildAggregatedChartRows([TERM_A, TERM_B], '2022-01-01', '2022-12-31'))
      .toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Split chart rows (split:true)
// ─────────────────────────────────────────────────────────────────────────────

const TERM_SERIES = [
  { id: 'termA', rows: TERM_A },
  { id: 'termB', rows: TERM_B },
]

describe('buildSplitChartRows', () => {
  it('each row has one column per term plus date', () => {
    const rows = buildSplitChartRows(TERM_SERIES, 'scaffold_count', '', '')
    expect(Object.keys(rows[0])).toContain('termA')
    expect(Object.keys(rows[0])).toContain('termB')
    expect(Object.keys(rows[0])).toContain('date')
  })

  it('fills 0 for terms absent on a given date', () => {
    const rows   = buildSplitChartRows(TERM_SERIES, 'scaffold_count', '', '')
    const may11  = rows.find(r => r.date === '2021-05-11 08:00')!
    expect(may11.termB).toBe(1)   // TERM_B has this date
    expect(may11.termA).toBe(0)   // TERM_A does not
  })

  it('scaffold_count metric is correct', () => {
    const rows     = buildSplitChartRows(TERM_SERIES, 'scaffold_count', '', '')
    const may10_08 = rows.find(r => r.date === '2021-05-10 08:00')!
    expect(may10_08.termA).toBe(2)
    expect(may10_08.termB).toBe(4)
  })

  it('gene_count metric is correct', () => {
    const rows     = buildSplitChartRows(TERM_SERIES, 'gene_count', '', '')
    const may10_08 = rows.find(r => r.date === '2021-05-10 08:00')!
    expect(may10_08.termA).toBe(5)
    expect(may10_08.termB).toBe(10)
  })

  it('dateFrom filter applied', () => {
    const rows  = buildSplitChartRows(TERM_SERIES, 'scaffold_count', '2021-05-11', '')
    const dates = rows.map(r => r.date)
    expect(dates).not.toContain('2021-05-10 08:00')
    expect(dates).not.toContain('2021-05-10 12:00')
  })

  it('dateTo filter applied', () => {
    const rows  = buildSplitChartRows(TERM_SERIES, 'scaffold_count', '', '2021-05-10')
    const dates = rows.map(r => r.date)
    expect(dates).not.toContain('2021-05-11 08:00')
  })

  it('output is sorted chronologically', () => {
    const rows  = buildSplitChartRows(TERM_SERIES, 'scaffold_count', '', '')
    const dates = rows.map(r => r.date)
    expect(dates).toEqual([...dates].sort())
  })

  it('empty input returns []', () => {
    expect(buildSplitChartRows([], 'scaffold_count', '', '')).toEqual([])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Term management
// ─────────────────────────────────────────────────────────────────────────────

describe('scaffold explore term management', () => {
  it('addTerm adds new term', () => {
    const result = addTermToList([], { annotationId: 'COG0055', source: 'cog' })
    expect(result).toHaveLength(1)
    expect(result[0].annotationId).toBe('COG0055')
  })

  it('addTerm rejects duplicate (same id + source)', () => {
    const existing = [{ annotationId: 'COG0055', source: 'cog' }]
    expect(addTermToList(existing, { annotationId: 'COG0055', source: 'cog' }))
      .toHaveLength(1)
  })

  it('addTerm allows same id from different source', () => {
    const existing = [{ annotationId: 'COG0055', source: 'cog' }]
    expect(addTermToList(existing, { annotationId: 'COG0055', source: 'enzyme' }))
      .toHaveLength(2)
  })

  it('removeTerm removes correct term', () => {
    const existing = [
      { annotationId: 'COG0055', source: 'cog'  },
      { annotationId: 'COG0001', source: 'cog'  },
    ]
    const result = removeTermFromList(existing, { annotationId: 'COG0055', source: 'cog' })
    expect(result).toHaveLength(1)
    expect(result[0].annotationId).toBe('COG0001')
  })

  it('removeTerm leaves list unchanged when term not found', () => {
    const existing = [{ annotationId: 'COG0055', source: 'cog' }]
    expect(removeTermFromList(existing, { annotationId: 'COG9999', source: 'cog' }))
      .toHaveLength(1)
  })

  it('removeTerm of only term leaves empty list', () => {
    const existing = [{ annotationId: 'COG0055', source: 'cog' }]
    expect(removeTermFromList(existing, { annotationId: 'COG0055', source: 'cog' }))
      .toHaveLength(0)
  })

  it('addTerm does not mutate input', () => {
    const existing = [{ annotationId: 'COG0055', source: 'cog' }]
    const copy     = [...existing]
    addTermToList(existing, { annotationId: 'COG0001', source: 'cog' })
    expect(existing).toEqual(copy)
  })

  it('removeTerm does not mutate input', () => {
    const existing = [{ annotationId: 'COG0055', source: 'cog' }]
    const copy     = [...existing]
    removeTermFromList(existing, { annotationId: 'COG0055', source: 'cog' })
    expect(existing).toEqual(copy)
  })

  it('color index wraps around when > palette length (8 colors)', () => {
    const COLORS   = ['c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'c8']
    const getColor = (idx: number) => COLORS[idx % COLORS.length]
    expect(getColor(0)).toBe('c1')
    expect(getColor(7)).toBe('c8')
    expect(getColor(8)).toBe('c1')  // wraps
    expect(getColor(9)).toBe('c2')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Detail row filtering
// ─────────────────────────────────────────────────────────────────────────────

describe('filterDetailBySample', () => {
  it('returns only rows for the requested sample', () => {
    const result = filterDetailBySample(SAMPLE_DETAIL, 's1')
    expect(result).toHaveLength(2)
    result.forEach(r => expect(r.sample).toBe('s1'))
  })

  it('returns empty array when sample not found', () => {
    expect(filterDetailBySample(SAMPLE_DETAIL, 'unknown')).toHaveLength(0)
  })

  it('returns all matching rows when sample appears multiple times', () => {
    const rows: ScaffoldDetailRow[] = [
      { sample: 'x', date: '2021-01-01', scaffold: 'sc1', count: 1 },
      { sample: 'x', date: '2021-01-01', scaffold: 'sc2', count: 2 },
      { sample: 'y', date: '2021-01-01', scaffold: 'sc3', count: 3 },
    ]
    expect(filterDetailBySample(rows, 'x')).toHaveLength(2)
  })

  it('handles empty input', () => {
    expect(filterDetailBySample([], 's1')).toHaveLength(0)
  })

  it('does not mutate original array', () => {
    const copy = [...SAMPLE_DETAIL]
    filterDetailBySample(SAMPLE_DETAIL, 's1')
    expect(SAMPLE_DETAIL).toEqual(copy)
  })

  it('scaffold names are preserved in filtered rows', () => {
    const result = filterDetailBySample(SAMPLE_DETAIL, 's1')
    const names  = result.map(r => r.scaffold)
    expect(names).toContain('Ga0590986_0000001')
    expect(names).toContain('Ga0590986_0000002')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Detail pagination (show-more)
// ─────────────────────────────────────────────────────────────────────────────

function makeDetailRows(n: number): ScaffoldDetailRow[] {
  return Array.from({ length: n }, (_, i) => ({
    sample:   's1',
    date:     '2021-01-01',
    scaffold: `scaffold_${i}`,
    count:    i + 1,
  }))
}

describe('detail pagination (show-more)', () => {
  it('shows exactly 10 rows when showAll=false and > 10 exist', () => {
    expect(visibleDetailRows(makeDetailRows(15), false)).toHaveLength(10)
  })

  it('shows all rows when showAll=true', () => {
    expect(visibleDetailRows(makeDetailRows(15), true)).toHaveLength(15)
  })

  it('shows all rows when < 10 exist regardless of showAll', () => {
    expect(visibleDetailRows(makeDetailRows(4), false)).toHaveLength(4)
    expect(visibleDetailRows(makeDetailRows(4), true)).toHaveLength(4)
  })

  it('shows exactly 10 rows when exactly 10 exist', () => {
    expect(visibleDetailRows(makeDetailRows(10), false)).toHaveLength(10)
  })

  it('show-more visible when rows > 10 and showAll=false', () => {
    const rows          = makeDetailRows(11)
    const showMoreVisible = rows.length > DETAIL_PAGE && !false
    expect(showMoreVisible).toBe(true)
  })

  it('show-more hidden when showAll=true', () => {
    const rows          = makeDetailRows(11)
    const showMoreVisible = rows.length > DETAIL_PAGE && !true
    expect(showMoreVisible).toBe(false)
  })

  it('show-more hidden when rows <= 10', () => {
    const rows          = makeDetailRows(10)
    const showMoreVisible = rows.length > DETAIL_PAGE && !false
    expect(showMoreVisible).toBe(false)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CSV export shape
// ─────────────────────────────────────────────────────────────────────────────

describe('toExportRow — CSV export shape', () => {
  const row: ScaffoldSummaryRow = {
    sample:         's1',
    date:           '2021-05-10 08:00',
    scaffold_count: 3,
    gene_count:     7,
  }

  it('produces exactly 7 fields', () => {
    expect(Object.keys(toExportRow(row, 'COG0055', 'cog'))).toHaveLength(7)
  })

  it('annotation_id is correct', () => {
    expect(toExportRow(row, 'COG0055', 'cog').annotation_id).toBe('COG0055')
  })

  it('source is correct', () => {
    expect(toExportRow(row, 'COG0055', 'cog').source).toBe('cog')
  })

  it('sample is correct', () => {
    expect(toExportRow(row, 'COG0055', 'cog').sample).toBe('s1')
  })

  it('date is the date portion only (no time)', () => {
    expect(toExportRow(row, 'COG0055', 'cog').date).toBe('2021-05-10')
  })

  it('time is the time portion only (no date)', () => {
    expect(toExportRow(row, 'COG0055', 'cog').time).toBe('08:00')
  })

  it('scaffold_count is a number', () => {
    expect(typeof toExportRow(row, 'COG0055', 'cog').scaffold_count).toBe('number')
    expect(toExportRow(row, 'COG0055', 'cog').scaffold_count).toBe(3)
  })

  it('gene_count is a number', () => {
    expect(typeof toExportRow(row, 'COG0055', 'cog').gene_count).toBe('number')
    expect(toExportRow(row, 'COG0055', 'cog').gene_count).toBe(7)
  })

  it('handles date-only string (no time component)', () => {
    const noTime = { ...row, date: '2021-05-10' }
    const out    = toExportRow(noTime, 'COG0055', 'cog')
    expect(out.date).toBe('2021-05-10')
    expect(out.time).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fmtDate and fmtTime — used in ScaffoldModal table columns
// ─────────────────────────────────────────────────────────────────────────────

describe('fmtDate — scaffold table date column', () => {
  it('formats ISO datetime as MM/DD/YY', () => {
    expect(fmtDate('2021-05-10 08:00')).toBe('05/10/21')
  })

  it('returns empty string for empty input', () => {
    expect(fmtDate('')).toBe('')
  })

  it('zero-pads month and day', () => {
    expect(fmtDate('2021-01-04 00:00')).toBe('01/04/21')
  })
})

describe('fmtTime — scaffold table time column', () => {
  it('extracts HH:MM from datetime string', () => {
    expect(fmtTime('2021-05-10 08:00')).toBe('08:00')
  })

  it('returns empty string for empty input', () => {
    expect(fmtTime('')).toBe('')
  })

  it('afternoon time uses 24h format', () => {
    expect(fmtTime('2021-05-10 16:00')).toBe('16:00')
  })

  it('midnight is 00:00', () => {
    expect(fmtTime('2021-05-10 00:00')).toBe('00:00')
  })
})
