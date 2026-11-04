// Sorting, paging, request URLs and CSV rows for the mappings table. Kept
// apart from MappingsPanel so that file exports only components.

import type { MappingSearchRow, MappingSortCol, SortDir } from '../../types'
import { fmtDate, fmtTime, parseDateTime } from '../../utils/format'

// ── Constants ──────────────────────────────────────────────────────────────

export const MAPPINGS_PAGE_SIZE = 25

// ── Pure helpers ─────────────────────────────────────────────────────────────

export function sortMappingRows(
  rows:    MappingSearchRow[],
  sortCol: MappingSortCol,
  sortDir: SortDir,
): MappingSearchRow[] {
  // 'date' and 'time' sort by full datetime, numerically via parseDateTime
  // -- NOT a plain string compare. The API returns unpadded "M/D/YY H:MM"
  // (e.g. "6/10/21 8:00"), which does not sort correctly as text: "6/10/21"
  // sorts before "6/2/21" lexically, even though June 10 is AFTER June 2.
  // The CSV export reuses this same sorted list.
  if (sortCol === 'date' || sortCol === 'time') {
    return [...rows].sort((a, b) => {
      const av = parseDateTime(a.timepoint?.datetime ?? '')
      const bv = parseDateTime(b.timepoint?.datetime ?? '')
      return sortDir === 'asc' ? av - bv : bv - av
    })
  }
  return [...rows].sort((a, b) => {
    const av = (a[sortCol as keyof MappingSearchRow] ?? '') as string
    const bv = (b[sortCol as keyof MappingSearchRow] ?? '') as string
    return sortDir === 'asc'
      ? av.localeCompare(bv)
      : bv.localeCompare(av)
  })
}

export function paginateRows<T>(rows: T[], page: number, pageSize: number = MAPPINGS_PAGE_SIZE): T[] {
  return rows.slice((page - 1) * pageSize, page * pageSize)
}

export function totalPages(rowCount: number, pageSize: number = MAPPINGS_PAGE_SIZE): number {
  return Math.ceil(rowCount / pageSize)
}

// page_size is set far above any realistic result size (the backend
// additionally clamps sample_count for broad categories -- see
// SAMPLES_CAPPED_NOTE below -- so even a worst-case broad-category result
// stays well under this) so the panel keeps fetching everything in one
// call and sorting/paginating client-side.
// 50_000 = the backend's own page_size cap on /mappings/search, which is
// also its hard row limit (_MAPPINGS_ROW_LIMIT), so asking for more could
// never return more -- and the route rejects anything larger with a 422.
const MAPPINGS_FETCH_PAGE_SIZE = 50_000

export function buildMappingsUrl(
  annotationId: string,
  source:       string,
  sampleCount:  number,
  uniquePairs:  boolean,
  bypassCap = false,
): string {
  const base = `/api/mappings/search?annotation_id=${encodeURIComponent(annotationId)}&source=${source}&sample_count=${sampleCount}&unique_pairs=${uniquePairs}&page_size=${MAPPINGS_FETCH_PAGE_SIZE}`
  return bypassCap ? `${base}&bypass_cap=true` : base
}

// ── Export all (/api/mappings/export) ──────────────────────────────────────

// Above this many rows the download asks for confirmation first: it's past
// Excel's row limit and can take a long time to arrive.
export const MAPPINGS_EXPORT_CONFIRM_ROWS = 1_000_000

// Average size of one exported row, measured on real exports from all four
// sources (266-288 bytes), for the "about N MB" estimate.
const MAPPINGS_EXPORT_BYTES_PER_ROW = 270

export type MappingsExportSummary = {
  annotation_id: string
  source:        string
  samples:       number
  rows:          number
  max_rows:      number
}

export function buildMappingsExportQuery(
  annotationId: string,
  source:       string,
  dateFrom = '',
  dateTo   = '',
): string {
  let q = `annotation_id=${encodeURIComponent(annotationId)}&source=${source}`
  if (dateFrom) q += `&date_from=${dateFrom}`
  if (dateTo)   q += `&date_to=${dateTo}`
  return q
}

export function estimateExportSize(rows: number): string {
  const mb = rows * MAPPINGS_EXPORT_BYTES_PER_ROW / 1_000_000
  if (mb >= 1000) return `${(mb / 1000).toFixed(1)} GB`
  return `${Math.max(1, Math.round(mb))} MB`
}

// Leaf ids have a fixed, well-known shape per source (mirrors the same
// shape assumptions cache_sql.py's _expand_to_leaf_ids already relies on
// server-side: a COG category is always a bare letter, never "COG####";
// a KEGG pathway/BRITE code is numeric, never "K#####"; an Enzyme class
// has fewer than 4 dot-separated segments). Used only to pick a sensible
// *default* for the unique-pairs checkbox before the first response comes
// back -- a wrong guess here doesn't affect correctness, just which
// starting checkbox state the user sees, and they can always toggle it.
export function isLikelyLeafAnnotation(source: string, annotationId: string): boolean {
  switch (source) {
    case 'cog':     return /^COG\d+$/i.test(annotationId)
    case 'kegg':    return /^K\d+$/i.test(annotationId)
    case 'enzyme':  return /^\d+\.\d+\.\d+\.\d+$/.test(annotationId)
    default:        return true // taxonomy: always a specific node, not a category
  }
}

export function buildMappingCsvRow(
  row: {
    taxonomy:  string | null
    kegg_id:   string | null
    enzyme:    string | null
    cog_id:    string | null
    timepoint: { datetime: string } | null
  },
  annotationId: string,
  source:       string,
): Record<string, string> {
  return {
    annotation_id: annotationId,
    source,
    date:     fmtDate(row.timepoint?.datetime ?? ''),
    time:     fmtTime(row.timepoint?.datetime ?? ''),
    taxonomy: row.taxonomy ?? '',
    kegg_id:  row.kegg_id  ?? '',
    enzyme:   row.enzyme   ?? '',
    cog_id:   row.cog_id   ?? '',
  }
}
