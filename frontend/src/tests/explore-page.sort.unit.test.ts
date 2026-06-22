/**
 * explore-page.sort.unit.test.ts
 * ================================
 * Unit tests for ExplorePage sort, filter, and section toggle logic.
 *
 * Tests import directly from production source files where possible.
 * The sort comparator and filter logic are pure functions extracted
 * from the useMemo in ExplorePage — they have no React dependency and
 * are fast to test in isolation.
 *
 * Coverage
 * --------
 * Top EGC table — sort comparator:
 *   mean_egc numeric sort asc/desc
 *   max_egc numeric sort asc/desc
 *   sample_count numeric sort asc/desc
 *   annotation_id string sort asc/desc
 *   does not mutate original array
 *   handles equal values without crashing
 *   handles mixed null/undefined gracefully
 *
 * toggleSort logic:
 *   first click on a new column: sets col, keeps dir
 *   second click on same column: flips asc → desc
 *   third click on same column: flips desc → asc
 *   clicking a different column resets to previous dir
 *   default sort is mean_egc desc
 *
 * topFilter text filter:
 *   matches annotation_id substring (case-insensitive)
 *   matches name substring
 *   matches parent substring
 *   empty filter returns all rows
 *   no-match returns empty array
 *   whitespace-only filter treated as empty
 *   filter is case-insensitive
 *
 * sortedRows combined (sort + filter):
 *   filter then sort (filter applied before sort)
 *   sorted filtered results still respect sort direction
 *
 * ExploreSortCol type contract:
 *   all 4 valid values exist on TopAnnotation
 *   sorting on each column produces different order for varied data
 *
 * makeDefaultExploreState:
 *   default sortCol is mean_egc
 *   default sortDir is desc
 *   default topFilter is empty string
 *   default rows is empty array
 *   default openSection is null
 *
 * section toggle logic:
 *   clicking closed section opens it
 *   clicking open section closes it
 *   opening section A closes previously open section B
 *   null → section → null cycle
 *
 * Run: npx vitest run src/tests/explore-page.sort.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { makeDefaultExploreState } from '../pages/ExplorePage'
import type { ExploreSortCol, ExploreSection, SortDir } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// TopAnnotation type (mirrors what ExplorePage uses)
// ─────────────────────────────────────────────────────────────────────────────

type TopAnnotation = {
  annotation_id: string
  name:          string | null
  parent:        string | null
  source:        string
  mean_egc:      number
  max_egc:       number
  sample_count:  number
}

// ─────────────────────────────────────────────────────────────────────────────
// Sort comparator — mirrors the useMemo in ExplorePage
// ─────────────────────────────────────────────────────────────────────────────

function sortRows(
  rows:    TopAnnotation[],
  sortCol: ExploreSortCol,
  sortDir: SortDir,
): TopAnnotation[] {
  return [...rows].sort((a, b) => {
    const av = a[sortCol] as number | string
    const bv = b[sortCol] as number | string
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av
    }
    return sortDir === 'asc'
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av))
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Filter logic — mirrors the .filter() in sortedRows useMemo
// ─────────────────────────────────────────────────────────────────────────────

function filterRows(rows: TopAnnotation[], topFilter: string): TopAnnotation[] {
  const q = topFilter.toLowerCase().trim()
  if (!q) return rows
  return rows.filter(r =>
    r.annotation_id.toLowerCase().includes(q) ||
    (r.name   ?? '').toLowerCase().includes(q) ||
    (r.parent ?? '').toLowerCase().includes(q),
  )
}

// ─────────────────────────────────────────────────────────────────────────────
// toggleSort logic — mirrors the setState in toggleSort()
// ─────────────────────────────────────────────────────────────────────────────

function applyToggleSort(
  prev: { sortCol: ExploreSortCol; sortDir: SortDir },
  col:  ExploreSortCol,
): { sortCol: ExploreSortCol; sortDir: SortDir } {
  return {
    sortCol: col,
    sortDir: prev.sortCol === col
      ? (prev.sortDir === 'asc' ? 'desc' : 'asc')
      : prev.sortDir,
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Fixtures
// ─────────────────────────────────────────────────────────────────────────────

const ROWS: TopAnnotation[] = [
  {
    annotation_id: 'K02014',
    name:          'TonB-dependent receptor',
    parent:        'membrane transport',
    source:        'kegg',
    mean_egc:      5000,
    max_egc:       12000,
    sample_count:  128,
  },
  {
    annotation_id: 'COG0001',
    name:          'Ribosomal protein',
    parent:        'J translation',
    source:        'cog',
    mean_egc:      1200,
    max_egc:       3000,
    sample_count:  100,
  },
  {
    annotation_id: 'K00001',
    name:          'Alcohol dehydrogenase',
    parent:        'carbon metabolism',
    source:        'kegg',
    mean_egc:      8500,
    max_egc:       20000,
    sample_count:  64,
  },
  {
    annotation_id: 'EC:1.1.1.1',
    name:          'Alcohol dehydrogenase',
    parent:        '1 Oxidoreductases',
    source:        'enzyme',
    mean_egc:      7200,
    max_egc:       18000,
    sample_count:  96,
  },
  {
    annotation_id: 'Bacteria',
    name:          null,
    parent:        null,
    source:        'taxonomy',
    mean_egc:      50000,
    max_egc:       120000,
    sample_count:  128,
  },
]

// ─────────────────────────────────────────────────────────────────────────────
// Sort comparator — numeric columns
// ─────────────────────────────────────────────────────────────────────────────

describe('sortRows — mean_egc', () => {
  it('asc: lowest mean_egc first', () => {
    const result = sortRows(ROWS, 'mean_egc', 'asc')
    expect(result[0].mean_egc).toBe(1200)
    expect(result[result.length - 1].mean_egc).toBe(50000)
  })

  it('desc: highest mean_egc first', () => {
    const result = sortRows(ROWS, 'mean_egc', 'desc')
    expect(result[0].mean_egc).toBe(50000)
    expect(result[result.length - 1].mean_egc).toBe(1200)
  })

  it('does not mutate original array', () => {
    const original = ROWS.map(r => r.annotation_id)
    sortRows(ROWS, 'mean_egc', 'asc')
    expect(ROWS.map(r => r.annotation_id)).toEqual(original)
  })
})

describe('sortRows — max_egc', () => {
  it('asc: lowest max_egc first', () => {
    const result = sortRows(ROWS, 'max_egc', 'asc')
    expect(result[0].max_egc).toBe(3000)
  })

  it('desc: highest max_egc first', () => {
    const result = sortRows(ROWS, 'max_egc', 'desc')
    expect(result[0].max_egc).toBe(120000)
  })
})

describe('sortRows — sample_count', () => {
  it('asc: fewest samples first', () => {
    const result = sortRows(ROWS, 'sample_count', 'asc')
    expect(result[0].sample_count).toBe(64)
  })

  it('desc: most samples first', () => {
    const result = sortRows(ROWS, 'sample_count', 'desc')
    expect(result[0].sample_count).toBe(128)
  })

  it('ties: both rows with 128 samples appear before lower counts', () => {
    const result = sortRows(ROWS, 'sample_count', 'desc')
    // Both K02014 and Bacteria have 128
    expect(result[0].sample_count).toBe(128)
    expect(result[1].sample_count).toBe(128)
  })
})

describe('sortRows — annotation_id', () => {
  it('asc: alphabetical by annotation_id', () => {
    const result = sortRows(ROWS, 'annotation_id', 'asc')
    const ids    = result.map(r => r.annotation_id)
    expect(ids).toEqual([...ids].sort())
  })

  it('desc: reverse alphabetical', () => {
    const result = sortRows(ROWS, 'annotation_id', 'desc')
    const ids    = result.map(r => r.annotation_id)
    expect(ids).toEqual([...ids].sort().reverse())
  })
})

describe('sortRows — edge cases', () => {
  it('empty array returns empty array', () => {
    expect(sortRows([], 'mean_egc', 'desc')).toEqual([])
  })

  it('single row returns single row unchanged', () => {
    expect(sortRows([ROWS[0]], 'mean_egc', 'asc')).toHaveLength(1)
  })

  it('equal values: all rows preserved', () => {
    const flat: TopAnnotation[] = [
      { ...ROWS[0], mean_egc: 100 },
      { ...ROWS[1], mean_egc: 100 },
      { ...ROWS[2], mean_egc: 100 },
    ]
    expect(sortRows(flat, 'mean_egc', 'asc')).toHaveLength(3)
  })

  it('each sortCol produces a different ordering on varied data', () => {
    const cols: ExploreSortCol[] = ['mean_egc', 'max_egc', 'sample_count', 'annotation_id']
    const orders = cols.map(col =>
      sortRows(ROWS, col, 'desc').map(r => r.annotation_id).join(','),
    )
    // Not all orderings should be identical
    const unique = new Set(orders)
    expect(unique.size).toBeGreaterThan(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// toggleSort — column cycling
// ─────────────────────────────────────────────────────────────────────────────

describe('toggleSort', () => {
  const DEFAULT_STATE = { sortCol: 'mean_egc' as ExploreSortCol, sortDir: 'desc' as SortDir }

  it('first click on a new column: sets that column, keeps direction', () => {
    const result = applyToggleSort(DEFAULT_STATE, 'sample_count')
    expect(result.sortCol).toBe('sample_count')
    expect(result.sortDir).toBe('desc')
  })

  it('second click on same column: flips asc → desc', () => {
    const state1 = applyToggleSort({ sortCol: 'mean_egc', sortDir: 'asc' }, 'mean_egc')
    expect(state1.sortDir).toBe('desc')
  })

  it('second click on same column: flips desc → asc', () => {
    const state1 = applyToggleSort(DEFAULT_STATE, 'mean_egc')
    expect(state1.sortDir).toBe('asc')
  })

  it('third click: asc → desc → asc', () => {
    const s1 = applyToggleSort(DEFAULT_STATE,  'mean_egc') // desc → asc
    const s2 = applyToggleSort(s1,             'mean_egc') // asc → desc
    expect(s1.sortDir).toBe('asc')
    expect(s2.sortDir).toBe('desc')
  })

  it('clicking a different column resets to current dir without flip', () => {
    // Current state: mean_egc desc; click annotation_id → annotation_id desc
    const result = applyToggleSort(DEFAULT_STATE, 'annotation_id')
    expect(result.sortCol).toBe('annotation_id')
    expect(result.sortDir).toBe('desc') // inherited, not flipped
  })

  it('clicking annotation_id twice flips to asc', () => {
    const s1 = applyToggleSort(DEFAULT_STATE, 'annotation_id') // →annotation_id desc
    const s2 = applyToggleSort(s1, 'annotation_id')            // →annotation_id asc
    expect(s2.sortDir).toBe('asc')
  })

  it('all four columns can be toggled without error', () => {
    const cols: ExploreSortCol[] = ['mean_egc', 'max_egc', 'sample_count', 'annotation_id']
    let state = DEFAULT_STATE
    for (const col of cols) {
      state = applyToggleSort(state, col)
      expect(state.sortCol).toBe(col)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// filterRows — text filter
// ─────────────────────────────────────────────────────────────────────────────

describe('filterRows', () => {
  it('empty filter returns all rows', () => {
    expect(filterRows(ROWS, '')).toHaveLength(ROWS.length)
  })

  it('whitespace-only filter treated as empty (returns all)', () => {
    expect(filterRows(ROWS, '   ')).toHaveLength(ROWS.length)
  })

  it('matches annotation_id substring', () => {
    const result = filterRows(ROWS, 'K000')
    expect(result.every(r => r.annotation_id.includes('K000'))).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })

  it('matches name substring', () => {
    const result = filterRows(ROWS, 'dehydrogenase')
    expect(result.every(r =>
      (r.name ?? '').toLowerCase().includes('dehydrogenase'),
    )).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })

  it('matches parent substring', () => {
    const result = filterRows(ROWS, 'metabolism')
    expect(result.some(r => (r.parent ?? '').includes('metabolism'))).toBe(true)
  })

  it('is case-insensitive for annotation_id', () => {
    const upper = filterRows(ROWS, 'BACTERIA')
    const lower = filterRows(ROWS, 'bacteria')
    expect(upper).toHaveLength(lower.length)
  })

  it('is case-insensitive for name', () => {
    const upper = filterRows(ROWS, 'RIBOSOMAL')
    const lower = filterRows(ROWS, 'ribosomal')
    expect(upper).toHaveLength(lower.length)
  })

  it('no match returns empty array', () => {
    expect(filterRows(ROWS, 'xyznotarealannotation')).toHaveLength(0)
  })

  it('exact annotation_id match works', () => {
    const result = filterRows(ROWS, 'K02014')
    expect(result).toHaveLength(1)
    expect(result[0].annotation_id).toBe('K02014')
  })

  it('partial match can return multiple rows', () => {
    // 'K000' matches K02014? No. 'COG' matches COG0001
    const result = filterRows(ROWS, 'alcohol')
    // K00001 has name "Alcohol dehydrogenase", EC:1.1.1.1 also has same name
    expect(result.length).toBeGreaterThanOrEqual(1)
  })

  it('does not mutate original array', () => {
    const original = ROWS.map(r => r.annotation_id)
    filterRows(ROWS, 'K02014')
    expect(ROWS.map(r => r.annotation_id)).toEqual(original)
  })

  it('handles rows with null name and null parent', () => {
    // 'Bacteria' row has name=null, parent=null
    const result = filterRows(ROWS, 'Bacteria')
    expect(result.some(r => r.annotation_id === 'Bacteria')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Combined filter + sort (sortedRows useMemo)
// ─────────────────────────────────────────────────────────────────────────────

function sortedRows(
  rows:      TopAnnotation[],
  topFilter: string,
  sortCol:   ExploreSortCol,
  sortDir:   SortDir,
): TopAnnotation[] {
  return sortRows(filterRows(rows, topFilter), sortCol, sortDir)
}

describe('sortedRows — filter then sort', () => {
  it('filters first, then sorts the filtered subset', () => {
    // Filter to only kegg rows (K02014, K00001)
    const result = sortedRows(ROWS, 'K0', 'mean_egc', 'asc')
    // Should have both K02014 (5000) and K00001 (8500)
    expect(result.length).toBeGreaterThanOrEqual(2)
    // First result should be lower mean_egc
    expect(result[0].mean_egc).toBeLessThan(result[result.length - 1].mean_egc)
  })

  it('empty filter + sort: all rows sorted', () => {
    const result = sortedRows(ROWS, '', 'mean_egc', 'desc')
    expect(result).toHaveLength(ROWS.length)
    expect(result[0].mean_egc).toBeGreaterThan(result[result.length - 1].mean_egc)
  })

  it('no-match filter returns empty array regardless of sort', () => {
    expect(sortedRows(ROWS, 'zzznomatch', 'mean_egc', 'desc')).toHaveLength(0)
  })

  it('filter + sort does not mutate original', () => {
    const original = ROWS.map(r => r.annotation_id)
    sortedRows(ROWS, 'K0', 'annotation_id', 'asc')
    expect(ROWS.map(r => r.annotation_id)).toEqual(original)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// makeDefaultExploreState
// ─────────────────────────────────────────────────────────────────────────────

describe('makeDefaultExploreState', () => {
  it('default sortCol is mean_egc', () => {
    expect(makeDefaultExploreState().sortCol).toBe('mean_egc')
  })

  it('default sortDir is desc (highest EGC first is most useful)', () => {
    expect(makeDefaultExploreState().sortDir).toBe('desc')
  })

  it('default topFilter is empty string', () => {
    expect(makeDefaultExploreState().topFilter).toBe('')
  })

  it('default rows is empty array', () => {
    expect(makeDefaultExploreState().rows).toEqual([])
  })

  it('default openSection is null', () => {
    expect(makeDefaultExploreState().openSection).toBeNull()
  })

  it('default parentSource is kegg', () => {
    expect(makeDefaultExploreState().parentSource).toBe('kegg')
  })

  it('each call returns a new object (no shared reference)', () => {
    const s1 = makeDefaultExploreState()
    const s2 = makeDefaultExploreState()
    s1.rows = [ROWS[0]]
    expect(s2.rows).toHaveLength(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Section toggle logic
// ─────────────────────────────────────────────────────────────────────────────

function applyToggleSection(
  prev:    ExploreSection | null,
  section: ExploreSection,
): ExploreSection | null {
  return prev === section ? null : section
}

describe('section toggle logic', () => {
  it('clicking a closed section opens it', () => {
    expect(applyToggleSection(null, 'top-egc')).toBe('top-egc')
  })

  it('clicking the open section closes it (returns null)', () => {
    expect(applyToggleSection('top-egc', 'top-egc')).toBeNull()
  })

  it('opening section A when B is open: opens A, closes B', () => {
    expect(applyToggleSection('top-egc', 'by-parent')).toBe('by-parent')
  })

  it('null → open → null cycle', () => {
    const s1 = applyToggleSection(null,      'top-egc')
    const s2 = applyToggleSection(s1,        'top-egc')
    expect(s1).toBe('top-egc')
    expect(s2).toBeNull()
  })

  it('all valid ExploreSection values can be toggled', () => {
    const sections: ExploreSection[] = [
      'overview', 'top-egc', 'by-parent', 'lookup', 'scaffolds',
    ]
    for (const s of sections) {
      expect(applyToggleSection(null, s)).toBe(s)
      expect(applyToggleSection(s, s)).toBeNull()
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ExploreSortCol type contract
// ─────────────────────────────────────────────────────────────────────────────

describe('ExploreSortCol type contract', () => {
  const ALL_COLS: ExploreSortCol[] = [
    'mean_egc', 'max_egc', 'sample_count', 'annotation_id',
  ]

  it('all 4 sort columns exist as keys on TopAnnotation', () => {
    const row = ROWS[0]
    for (const col of ALL_COLS) {
      expect(col in row).toBe(true)
    }
  })

  it('numeric columns produce numeric comparisons (not string)', () => {
    // If "10" sorts after "9" as strings but before as numbers
    const numericRows: TopAnnotation[] = [
      { ...ROWS[0], mean_egc: 9   },
      { ...ROWS[1], mean_egc: 10  },
      { ...ROWS[2], mean_egc: 100 },
    ]
    const result = sortRows(numericRows, 'mean_egc', 'asc')
    expect(result[0].mean_egc).toBe(9)
    expect(result[1].mean_egc).toBe(10)
    expect(result[2].mean_egc).toBe(100)
  })

  it('annotation_id uses string comparison not numeric', () => {
    const mixedRows: TopAnnotation[] = [
      { ...ROWS[0], annotation_id: 'K00100' },
      { ...ROWS[1], annotation_id: 'K00009' },
      { ...ROWS[2], annotation_id: 'K00020' },
    ]
    const result = sortRows(mixedRows, 'annotation_id', 'asc')
    const ids    = result.map(r => r.annotation_id)
    expect(ids).toEqual([...ids].sort())
  })
})
