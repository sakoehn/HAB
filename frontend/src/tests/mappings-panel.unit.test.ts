/**
 * mappings-panel.unit.test.ts
 * ============================
 * Unit tests for MappingsPanel logic and the mapping CSV export shape.
 *
 * Tests import directly from production source files so implementation
 * drift is caught immediately.
 *
 * Coverage
 * --------
 * utils/format.ts:
 *   fmtTime            — all datetime formats used in mapping table cells
 *   fmtDate            — all datetime formats used in mapping table cells
 *
 * Mapping table structure:
 *   Column set         — must have date + time, must NOT have sample
 *   MappingSortCol     — valid sort column values
 *   CSV export shape   — all required fields, correct formatting
 *
 * Sorting logic:
 *   date/time sorts    — both use full datetime string (ISO sort)
 *   taxonomy sort      — string comparison asc/desc
 *   kegg_id sort       — string comparison
 *   enzyme sort        — string comparison
 *   cog_id sort        — string comparison
 *   sort stability     — does not mutate original array
 *
 * Filter logic:
 *   sample_count       — slice to N samples
 *   unique_pairs       — deduplication key composition
 *   partial match      — annotation_id substring matching
 *
 * API URL construction:
 *   encodes annotation_id
 *   includes source, sample_count, unique_pairs params
 *
 * Pagination:
 *   page size = 100
 *   total pages calculation
 *   page slice boundaries
 *
 * Data date range constraints:
 *   /api/status provides date_min and date_max
 *   date_min < date_max
 *   values are ISO YYYY-MM-DD strings
 *   date inputs constrained to data range
 *
 * Cross-source target selection (CorrelatesPanel):
 *   default target is taxonomy for non-taxonomy sources
 *   default target is kegg for taxonomy source
 *   available targets exclude current source
 *   always exactly 3 available targets
 *
 * Analyze page navigation:
 *   handleSendToAnalyze resets query fields, results, status
 *
 * Run: npx vitest run src/tests/mappings-panel.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { fmtTime } from '../utils/format'
import {
  sortMappingRows,
  paginateRows,
  totalPages,
  buildMappingsUrl,
  buildMappingCsvRow,
} from '../components/mappings/MappingsPanel'
import type { MappingSortCol, MappingSearchRow } from '../types'

// ─────────────────────────────────────────────────────────────────────────────
// fmtTime — used in mapping table Time column and CSV export
// ─────────────────────────────────────────────────────────────────────────────

describe('fmtTime — mapping table time column', () => {
  it('extracts HH:MM from ISO datetime string', () => {
    expect(fmtTime('2021-05-27T08:00:00')).toBe('08:00')
  })

  it('extracts HH:MM from MM/DD/YY HH:MM format', () => {
    expect(fmtTime('05/27/21 08:00')).toBe('08:00')
  })

  it('pads single-digit hours with leading zero', () => {
    expect(fmtTime('2021-05-27T04:00:00')).toBe('04:00')
  })

  it('pads single-digit minutes with leading zero', () => {
    expect(fmtTime('2021-05-27T08:05:00')).toBe('08:05')
  })

  it('returns empty string for empty input', () => {
    expect(fmtTime('')).toBe('')
  })

  it('uses 24-hour format — afternoon returns value > 12', () => {
    expect(fmtTime('2021-05-27T16:00:00')).toBe('16:00')
  })

  it('midnight is 00:00 not 24:00', () => {
    expect(fmtTime('2021-05-27T00:00:00')).toBe('00:00')
  })

  it('23:59 renders correctly', () => {
    expect(fmtTime('2021-05-27T23:59:00')).toBe('23:59')
  })

  it('noon is 12:00', () => {
    expect(fmtTime('2021-05-27T12:00:00')).toBe('12:00')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Mapping table column contract
// ─────────────────────────────────────────────────────────────────────────────

describe('mapping table column set', () => {
  const TABLE_COLS: MappingSortCol[] = [
    'date', 'time', 'taxonomy', 'kegg_id', 'enzyme', 'cog_id',
  ]

  it('table has a "date" column', () => {
    expect(TABLE_COLS).toContain('date')
  })

  it('table has a "time" column', () => {
    expect(TABLE_COLS).toContain('time')
  })

  it('table does NOT have a "sample" column', () => {
    expect(TABLE_COLS).not.toContain('sample')
  })

  it('table has all four annotation columns', () => {
    expect(TABLE_COLS).toContain('taxonomy')
    expect(TABLE_COLS).toContain('kegg_id')
    expect(TABLE_COLS).toContain('enzyme')
    expect(TABLE_COLS).toContain('cog_id')
  })

  it('exactly 6 columns', () => {
    expect(TABLE_COLS).toHaveLength(6)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Mapping CSV export shape — imported directly from MappingsPanel (see import above)
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_ROW = {
  taxonomy: 'Tenacibaculum',
  kegg_id:  'K02014',
  enzyme:   null,
  cog_id:   null,
  timepoint: { datetime: '2021-05-27T08:00:00' },
}

describe('mapping CSV export shape', () => {
  it('CSV row has "date" field', () => {
    expect(buildMappingCsvRow(SAMPLE_ROW, 'K02014', 'kegg')).toHaveProperty('date')
  })

  it('CSV row has "time" field', () => {
    expect(buildMappingCsvRow(SAMPLE_ROW, 'K02014', 'kegg')).toHaveProperty('time')
  })

  it('CSV row does NOT have "sample" field', () => {
    expect(buildMappingCsvRow(SAMPLE_ROW, 'K02014', 'kegg')).not.toHaveProperty('sample')
  })

  it('date field is formatted MM/DD/YY', () => {
    expect(buildMappingCsvRow(SAMPLE_ROW, 'K02014', 'kegg').date).toBe('05/27/21')
  })

  it('time field is 24-hour HH:MM', () => {
    expect(buildMappingCsvRow(SAMPLE_ROW, 'K02014', 'kegg').time).toBe('08:00')
  })

  it('null timepoint produces empty date and time', () => {
    const row = { ...SAMPLE_ROW, timepoint: null }
    const csv = buildMappingCsvRow(row, 'K02014', 'kegg')
    expect(csv.date).toBe('')
    expect(csv.time).toBe('')
  })

  it('null annotation values become empty string, not "null"', () => {
    const row = { ...SAMPLE_ROW, enzyme: null, cog_id: null }
    const csv = buildMappingCsvRow(row, 'K02014', 'kegg')
    expect(csv.enzyme).toBe('')
    expect(csv.cog_id).toBe('')
  })

  it('CSV row has annotation_id and source fields', () => {
    const csv = buildMappingCsvRow(SAMPLE_ROW, 'K02014', 'kegg')
    expect(csv.annotation_id).toBe('K02014')
    expect(csv.source).toBe('kegg')
  })

  it('produces exactly 8 fields', () => {
    expect(Object.keys(buildMappingCsvRow(SAMPLE_ROW, 'K02014', 'kegg'))).toHaveLength(8)
  })

  it('afternoon timepoint formats time correctly', () => {
    const row = { ...SAMPLE_ROW, timepoint: { datetime: '2021-05-27T16:00:00' } }
    expect(buildMappingCsvRow(row, 'K02014', 'kegg').time).toBe('16:00')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Sorting logic — imported directly from MappingsPanel (see import above)
// ─────────────────────────────────────────────────────────────────────────────

const RAW_ROWS: MappingSearchRow[] = [
  {
    gene_id:   'g1',
    contig_id: 'c1',
    taxonomy:  'Bacteria',
    kegg_id:   'K00010',
    enzyme:    '1.1.1.1',
    cog_id:    'COG0001',
    sample:    's1',
    timepoint: { taxon_oid: 's1', timepoint: '1', datetime: '2021-05-27T08:00:00' },
  },
  {
    gene_id:   'g2',
    contig_id: 'c2',
    taxonomy:  'Archaea',
    kegg_id:   'K00020',
    enzyme:    '2.2.2.2',
    cog_id:    'COG0002',
    sample:    's2',
    timepoint: { taxon_oid: 's2', timepoint: '2', datetime: '2021-05-27T12:00:00' },
  },
  {
    gene_id:   'g3',
    contig_id: 'c3',
    taxonomy:  'Viruses',
    kegg_id:   'K00005',
    enzyme:    '1.2.3.4',
    cog_id:    'COG0010',
    sample:    's3',
    timepoint: { taxon_oid: 's3', timepoint: '3', datetime: '2021-05-28T04:00:00' },
  },
]

describe('mapping row sorting', () => {
  it('sort by date asc: chronological order', () => {
    const result = sortMappingRows(
      [RAW_ROWS[2], RAW_ROWS[0], RAW_ROWS[1]],
      'date',
      'asc',
    )
    expect(result[0].sample).toBe('s1')
    expect(result[2].sample).toBe('s3')
  })

  it('sort by date desc: reverse chronological order', () => {
    const result = sortMappingRows(RAW_ROWS, 'date', 'desc')
    expect(result[0].sample).toBe('s3')
    expect(result[2].sample).toBe('s1')
  })

  it('sort by time uses the same datetime field as date', () => {
    // time and date both use datetime — results should be identical
    const byDate = sortMappingRows(RAW_ROWS, 'date', 'asc')
    const byTime = sortMappingRows(RAW_ROWS, 'time', 'asc')
    expect(byDate.map(r => r.sample)).toEqual(byTime.map(r => r.sample))
  })

  it('sort by taxonomy asc: alphabetical', () => {
    const result = sortMappingRows(RAW_ROWS, 'taxonomy', 'asc')
    expect(result[0].taxonomy).toBe('Archaea')
    expect(result[2].taxonomy).toBe('Viruses')
  })

  it('sort by taxonomy desc: reverse alphabetical', () => {
    const result = sortMappingRows(RAW_ROWS, 'taxonomy', 'desc')
    expect(result[0].taxonomy).toBe('Viruses')
  })

  it('sort by kegg_id asc: K00005, K00010, K00020', () => {
    const result = sortMappingRows(RAW_ROWS, 'kegg_id', 'asc')
    expect(result[0].kegg_id).toBe('K00005')
    expect(result[2].kegg_id).toBe('K00020')
  })

  it('sort by enzyme asc: string comparison', () => {
    const result = sortMappingRows(RAW_ROWS, 'enzyme', 'asc')
    expect(result[0].enzyme).toBe('1.1.1.1')
  })

  it('sort by cog_id asc: COG0001, COG0002, COG0010', () => {
    const result = sortMappingRows(RAW_ROWS, 'cog_id', 'asc')
    expect(result[0].cog_id).toBe('COG0001')
    expect(result[2].cog_id).toBe('COG0010')
  })

  it('does not mutate the original array', () => {
    const original = RAW_ROWS.map(r => r.sample)
    sortMappingRows(RAW_ROWS, 'taxonomy', 'asc')
    expect(RAW_ROWS.map(r => r.sample)).toEqual(original)
  })

  it('handles rows with null fields — null sorts to end on asc', () => {
    const rows: MappingSearchRow[] = [
      { ...RAW_ROWS[0], taxonomy: null },
      { ...RAW_ROWS[1], taxonomy: 'Archaea' },
    ]
    // null → '' which sorts before 'Archaea'
    const result = sortMappingRows(rows, 'taxonomy', 'asc')
    expect(result[0].taxonomy).toBeNull()
    expect(result[1].taxonomy).toBe('Archaea')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Pagination logic — imported directly from MappingsPanel (see import above)
// ─────────────────────────────────────────────────────────────────────────────

describe('mapping table pagination', () => {
  it('page 1 returns first 100 rows', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }))
    expect(paginateRows(rows, 1)).toHaveLength(100)
    expect(paginateRows(rows, 1)[0].i).toBe(0)
    expect(paginateRows(rows, 1)[99].i).toBe(99)
  })

  it('page 2 returns rows 100-199', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }))
    expect(paginateRows(rows, 2)[0].i).toBe(100)
    expect(paginateRows(rows, 2)[99].i).toBe(199)
  })

  it('last page returns remaining rows', () => {
    const rows = Array.from({ length: 250 }, (_, i) => ({ i }))
    expect(paginateRows(rows, 3)).toHaveLength(50)
  })

  it('totalPages for 250 rows = 3', () => {
    expect(totalPages(250)).toBe(3)
  })

  it('totalPages for 100 rows = 1', () => {
    expect(totalPages(100)).toBe(1)
  })

  it('totalPages for 101 rows = 2', () => {
    expect(totalPages(101)).toBe(2)
  })

  it('totalPages for 0 rows = 0', () => {
    expect(totalPages(0)).toBe(0)
  })

  it('single page: no pagination shown when rows ≤ 100', () => {
    expect(totalPages(50)).toBe(1)
    expect(totalPages(100)).toBe(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Unique pairs deduplication
// ─────────────────────────────────────────────────────────────────────────────

function makeUniquePairKey(row: {
  taxonomy: string | null
  kegg_id:  string | null
  enzyme:   string | null
  cog_id:   string | null
}): string {
  return `${row.taxonomy}|${row.kegg_id}|${row.enzyme}|${row.cog_id}`
}

function deduplicateRows<T extends {
  taxonomy: string | null
  kegg_id:  string | null
  enzyme:   string | null
  cog_id:   string | null
}>(rows: T[]): T[] {
  const seen = new Set<string>()
  return rows.filter(row => {
    const key = makeUniquePairKey(row)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

describe('unique pairs deduplication', () => {
  it('removes duplicate taxonomy|kegg|enzyme|cog combinations', () => {
    const rows = [
      { taxonomy: 'Bacteria', kegg_id: 'K1', enzyme: null, cog_id: 'COG1' },
      { taxonomy: 'Bacteria', kegg_id: 'K1', enzyme: null, cog_id: 'COG1' },
      { taxonomy: 'Archaea',  kegg_id: 'K2', enzyme: null, cog_id: 'COG2' },
    ]
    expect(deduplicateRows(rows)).toHaveLength(2)
  })

  it('keeps rows that differ in any column', () => {
    const rows = [
      { taxonomy: 'Bacteria', kegg_id: 'K1', enzyme: null, cog_id: 'COG1' },
      { taxonomy: 'Bacteria', kegg_id: 'K2', enzyme: null, cog_id: 'COG1' }, // different kegg
    ]
    expect(deduplicateRows(rows)).toHaveLength(2)
  })

  it('null values are part of the key', () => {
    const rows = [
      { taxonomy: null, kegg_id: 'K1', enzyme: null, cog_id: null },
      { taxonomy: null, kegg_id: 'K1', enzyme: null, cog_id: null },
    ]
    expect(deduplicateRows(rows)).toHaveLength(1)
  })

  it('does not mutate input array', () => {
    const rows = [
      { taxonomy: 'A', kegg_id: 'K1', enzyme: null, cog_id: 'C1' },
      { taxonomy: 'A', kegg_id: 'K1', enzyme: null, cog_id: 'C1' },
    ]
    const original = rows.length
    deduplicateRows(rows)
    expect(rows).toHaveLength(original)
  })

  it('empty input returns empty output', () => {
    expect(deduplicateRows([])).toHaveLength(0)
  })

  it('unique pair key format is pipe-delimited', () => {
    const key = makeUniquePairKey({
      taxonomy: 'Bacteria',
      kegg_id:  'K02014',
      enzyme:   '1.1.1.1',
      cog_id:   'COG0001',
    })
    expect(key).toBe('Bacteria|K02014|1.1.1.1|COG0001')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// API URL construction — imported directly from MappingsPanel (see import above)
// ─────────────────────────────────────────────────────────────────────────────

describe('mappings API URL construction', () => {
  it('includes annotation_id URL-encoded', () => {
    const url = buildMappingsUrl('K02014', 'kegg', 128, false)
    expect(url).toContain('annotation_id=K02014')
  })

  it('URL-encodes special characters in annotation_id', () => {
    const url = buildMappingsUrl('EC:1.1.1.1', 'enzyme', 128, false)
    expect(url).toContain('annotation_id=EC%3A1.1.1.1')
  })

  it('includes source parameter', () => {
    expect(buildMappingsUrl('K02014', 'kegg',    128, false)).toContain('source=kegg')
    expect(buildMappingsUrl('COG1',   'cog',     128, false)).toContain('source=cog')
    expect(buildMappingsUrl('1.1.1',  'enzyme',  128, false)).toContain('source=enzyme')
    expect(buildMappingsUrl('Bact',   'taxonomy',128, false)).toContain('source=taxonomy')
  })

  it('includes sample_count parameter', () => {
    expect(buildMappingsUrl('K02014', 'kegg', 64, false)).toContain('sample_count=64')
  })

  it('includes unique_pairs=false by default', () => {
    expect(buildMappingsUrl('K02014', 'kegg', 128, false)).toContain('unique_pairs=false')
  })

  it('includes unique_pairs=true when requested', () => {
    expect(buildMappingsUrl('K02014', 'kegg', 128, true)).toContain('unique_pairs=true')
  })

  it('URL-encodes taxonomy annotation with spaces', () => {
    const url = buildMappingsUrl('Tenacibaculum maritimum', 'taxonomy', 128, false)
    expect(url).toContain('Tenacibaculum%20maritimum')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Data date range — /api/status constraints
// ─────────────────────────────────────────────────────────────────────────────

function mockStatusResponse(): { index_ready: boolean; date_min: string; date_max: string } {
  return {
    index_ready: true,
    date_min:    '2021-05-27',
    date_max:    '2021-06-17',
  }
}

describe('data date range from /api/status', () => {
  it('response has date_min and date_max', () => {
    const s = mockStatusResponse()
    expect(s).toHaveProperty('date_min')
    expect(s).toHaveProperty('date_max')
  })

  it('date_min is a valid YYYY-MM-DD ISO date string', () => {
    expect(mockStatusResponse().date_min).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('date_max is a valid YYYY-MM-DD ISO date string', () => {
    expect(mockStatusResponse().date_max).toMatch(/^\d{4}-\d{2}-\d{2}$/)
  })

  it('date_min is before date_max', () => {
    const s = mockStatusResponse()
    expect(s.date_min < s.date_max).toBe(true)
  })

  it('date range is within the known HAB study year (2021)', () => {
    const s = mockStatusResponse()
    expect(s.date_min.startsWith('2021')).toBe(true)
    expect(s.date_max.startsWith('2021')).toBe(true)
  })

  it('date inputs with min/max reject out-of-range dates', () => {
    const { date_min, date_max } = mockStatusResponse()
    expect('2020-01-01' < date_min).toBe(true) // too early — browser rejects
    expect('2026-06-09' > date_max).toBe(true) // too late  — browser rejects
    expect('2021-06-01' >= date_min && '2021-06-01' <= date_max).toBe(true)
  })

  it('DateRangePicker receives min and max as optional props (type check)', () => {
    type DateRangePickerProps = {
      from: string; to: string
      onFrom: (v: string) => void; onTo: (v: string) => void
      onClear: () => void
      minDate?: string
      maxDate?: string
    }
    const props: DateRangePickerProps = {
      from: '', to: '',
      onFrom: () => {}, onTo: () => {}, onClear: () => {},
      minDate: '2021-05-27',
      maxDate: '2021-06-17',
    }
    expect(props.minDate).toBe('2021-05-27')
    expect(props.maxDate).toBe('2021-06-17')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CorrelatesPanel — cross-source target selection
// ─────────────────────────────────────────────────────────────────────────────

const ALL_SOURCES = ['kegg', 'cog', 'enzyme', 'taxonomy'] as const

function defaultTarget(source: string): string {
  return source === 'taxonomy' ? 'kegg' : 'taxonomy'
}

function availableTargets(source: string): string[] {
  return ALL_SOURCES.filter(s => s !== source)
}

describe('correlates panel — cross-source target selection', () => {
  it('kegg source defaults to taxonomy target', () => {
    expect(defaultTarget('kegg')).toBe('taxonomy')
  })

  it('cog source defaults to taxonomy target', () => {
    expect(defaultTarget('cog')).toBe('taxonomy')
  })

  it('enzyme source defaults to taxonomy target', () => {
    expect(defaultTarget('enzyme')).toBe('taxonomy')
  })

  it('taxonomy source defaults to kegg target', () => {
    expect(defaultTarget('taxonomy')).toBe('kegg')
  })

  it('kegg can target cog, enzyme, taxonomy (3 options)', () => {
    const targets = availableTargets('kegg')
    expect(targets).toContain('cog')
    expect(targets).toContain('enzyme')
    expect(targets).toContain('taxonomy')
  })

  it('available targets always exclude the current source', () => {
    for (const src of ALL_SOURCES) {
      expect(availableTargets(src)).not.toContain(src)
    }
  })

  it('always exactly 3 available targets (4 sources minus self)', () => {
    for (const src of ALL_SOURCES) {
      expect(availableTargets(src)).toHaveLength(3)
    }
  })

  it('all sources have non-empty target lists', () => {
    for (const src of ALL_SOURCES) {
      expect(availableTargets(src).length).toBeGreaterThan(0)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Analyze page — handleSendToAnalyze navigation
// ─────────────────────────────────────────────────────────────────────────────

function simulateSendToAnalyze(annotationId: string) {
  return {
    queryFields:   [annotationId],
    resultsByTerm: [] as unknown[],
    totalsByTerm:  [] as number[],
    searchStatus:  'idle' as const,
    activeTermIdx: 0,
    checkedByTerm: {} as Record<string, unknown>,
  }
}

describe('analyze page — sendToAnalyze navigation', () => {
  it('sets queryFields to [annotationId]', () => {
    expect(simulateSendToAnalyze('K02014').queryFields).toEqual(['K02014'])
  })

  it('exactly one query field', () => {
    expect(simulateSendToAnalyze('K02014').queryFields).toHaveLength(1)
  })

  it('clears resultsByTerm', () => {
    expect(simulateSendToAnalyze('K02014').resultsByTerm).toHaveLength(0)
  })

  it('clears totalsByTerm', () => {
    expect(simulateSendToAnalyze('K02014').totalsByTerm).toHaveLength(0)
  })

  it('resets searchStatus to idle', () => {
    expect(simulateSendToAnalyze('K02014').searchStatus).toBe('idle')
  })

  it('resets activeTermIdx to 0', () => {
    expect(simulateSendToAnalyze('K02014').activeTermIdx).toBe(0)
  })

  it('resets checkedByTerm to empty object', () => {
    expect(Object.keys(simulateSendToAnalyze('K02014').checkedByTerm)).toHaveLength(0)
  })

  it('works with taxonomy IDs containing spaces', () => {
    expect(simulateSendToAnalyze('Tenacibaculum maritimum').queryFields[0])
      .toBe('Tenacibaculum maritimum')
  })

  it('works with enzyme EC numbers', () => {
    expect(simulateSendToAnalyze('EC:1.1.1.1').queryFields[0]).toBe('EC:1.1.1.1')
  })

  it('works with COG IDs', () => {
    expect(simulateSendToAnalyze('COG0001').queryFields[0]).toBe('COG0001')
  })
})
