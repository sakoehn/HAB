// ── MappingsPanel ─────────────────────────────────────────────────────────────
// Collapsible panel showing gene-to-annotation mapping rows for one annotation.
// Rendered below each EgcChart in the Analyze page (single card view).
//
// Data source: /api/mappings/search?annotation_id=…&source=…&sample_count=…&unique_pairs=…
//
// Features:
//   - Adjustable sample count (1–128), clamped server-side for a broad
//     category (W24, docs/AUDIT-2026-09-22.md) -- reflected back into the
//     field itself once a load reports it was capped, not just a banner
//   - Unique pairs toggle (deduplicates taxonomy|kegg|enzyme|cog combinations)
//     -- defaults to OFF for a leaf id (one specific gene: every sample it
//     appears in is real signal, not noise to collapse) and ON for a
//     pathway/class/category id (hundreds of genes, where duplicate
//     combinations really are redundant)
//   - Sortable columns (date, time, taxonomy, kegg_id, enzyme, cog_id)
//   - Pagination (100 rows per page)
//   - CSV export: uses the already-loaded (possibly capped) rows normally;
//     for a capped broad-category result, does a separate uncapped fetch
//     first (bypass_cap=true) so the download isn't limited by the fast
//     on-screen preview's cap -- a deliberate, explicit action a researcher
//     opts into and is willing to wait on, unlike passive browsing

import React, { useState, useMemo } from 'react'

import type { ApiStatus, MappingSortCol, SortDir, MappingSearchRow } from '../../types'
import { apiFetch, downloadCsv } from '../../utils/api'
import { fmtDate, fmtTime, parseDateTime } from '../../utils/format'
import { SkeletonTable } from '../ui/Skeleton'

// ── MappingsSortTh ─────────────────────────────────────────────────────────
// Reusable sortable table header cell.

function MappingsSortTh({
  col,
  label,
  sortCol,
  sortDir,
  onSort,
}: {
  col:     MappingSortCol
  label:   string
  sortCol: MappingSortCol
  sortDir: SortDir
  onSort:  (col: MappingSortCol) => void
}) {
  return (
    <th
      onClick={() => onSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}
      <span style={{ marginLeft: 4, opacity: sortCol === col ? 1 : 0.3 }}>
        {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )
}

// ── Constants ──────────────────────────────────────────────────────────────

export const MAPPINGS_PAGE_SIZE = 25

// ── Pure helpers ─────────────────────────────────────────────────────────────
// Exported so tests can exercise the real sort/paginate/URL logic directly.

export function sortMappingRows(
  rows:    MappingSearchRow[],
  sortCol: MappingSortCol,
  sortDir: SortDir,
): MappingSearchRow[] {
  // 'date' and 'time' sort by full datetime, numerically via parseDateTime
  // -- NOT a plain string compare (W17). The API returns unpadded
  // "M/D/YY H:MM" (e.g. "6/10/21 8:00"), which does not sort correctly as
  // text: "6/10/21" sorts before "6/2/21" lexically, even though June 10
  // is AFTER June 2. A plain string sort opened the table with "page one"
  // showing 5/27, 6/1, 6/10, 6/18, 6/2, 6/9 -- not the earliest rows -- and
  // the CSV export (which reuses this same sorted list) was in the same
  // wrong order.
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
// call and sorting/paginating client-side, same as it always has, rather
// than needing a page-by-page rewrite (W24, docs/AUDIT-2026-09-22.md).
const MAPPINGS_FETCH_PAGE_SIZE = 200_000

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

// ── MappingsPanel ──────────────────────────────────────────────────────────

export function MappingsPanel({
  annotationId,
  source,
}: {
  annotationId: string
  source:       string
}) {
  const [open, setOpen]               = useState(false)
  const [sampleCount, setSampleCount] = useState(128)
  const [uniqueOnly, setUniqueOnly]   = useState(() => !isLikelyLeafAnnotation(source, annotationId))
  const [allRows, setAllRows]         = useState<MappingSearchRow[]>([])
  const [status, setStatus]           = useState<ApiStatus>('idle')
  const [sortCol, setSortCol]         = useState<MappingSortCol>('date')
  const [sortDir, setSortDir]         = useState<SortDir>('asc')
  const [page, setPage]               = useState(1)
  const [samplesCapped, setSamplesCapped] = useState(false)
  const [usedSampleCount, setUsedSampleCount] = useState<number | null>(null)
  // What THIS request actually asked for, captured before sampleCount
  // itself gets overwritten below to reflect the effective count -- the
  // capped-notice banner needs both numbers ("5 instead of the requested
  // 128"), and sampleCount alone can't hold both once it's corrected.
  const [requestedSampleCount, setRequestedSampleCount] = useState(128)
  const [csvStatus, setCsvStatus]     = useState<ApiStatus>('idle')
  // Distinguishes WHY a request got capped: either annotationId resolved
  // to many real leaf ids (a genuine category/pathway/class -- leafCount
  // > 1), or it's a single leaf that's just individually high-volume
  // (leafCount === 1, e.g. COG2801 -- one specific COG, not a category,
  // but still 271K+ raw rows across 128 samples). The capped-notice
  // banner below must not call a single leaf id "a broad category" --
  // caught live, 2026-09-25, when a user correctly pointed out COG only
  // has 2 hierarchy levels and a leaf id has no "members" to be broad.
  const [leafCount, setLeafCount] = useState<number | null>(null)
  // A DIFFERENT failure mode from samplesCapped -- found live in
  // production, 2026-09-25: a single, specific, real leaf-level
  // organism (leafCount=1, not a category, so samplesCapped never
  // fires) can itself have millions of rows across all 128 samples
  // (the single most abundant organism in this dataset: 2,235,509).
  // The backend's hard row-count safety limit can truncate results even
  // when the sample count was never reduced at all.
  const [resultsWereTruncated, setResultsWereTruncated] = useState(false)
  // A handful of very-high-volume ids (kegg/cog/enzyme leaves that match
  // hundreds of thousands of rows, or broad categories) were measured
  // live in production, 2026-09-25, taking up to ~55s even after the cap
  // and the composite-index fixes for kegg/cog/enzyme -- kept generous
  // headroom above that rather than assuming every case is now fast.
  // A longer timeout plus a delayed reassurance message means "slow"
  // reads as "still working", not "Failed to load".
  const MAPPINGS_TIMEOUT_MS = 120_000
  const SLOW_NOTICE_DELAY_MS = 8_000
  const [showSlowNotice, setShowSlowNotice] = useState(false)

  async function loadMappings(count = sampleCount, unique = uniqueOnly) {
    setStatus('loading')
    setPage(1)
    setRequestedSampleCount(count)
    setShowSlowNotice(false)
    const slowTimer = setTimeout(() => setShowSlowNotice(true), SLOW_NOTICE_DELAY_MS)
    try {
      const r = await apiFetch<{
        data: MappingSearchRow[]
        total: number
        sample_count: number
        samples_were_capped: boolean
        results_were_truncated: boolean
        leaf_count: number | null
      }>(
        buildMappingsUrl(annotationId, source, count, unique),
        MAPPINGS_TIMEOUT_MS,
      )
      setAllRows(r.data ?? [])
      setSamplesCapped(r.samples_were_capped ?? false)
      setResultsWereTruncated(r.results_were_truncated ?? false)
      setLeafCount(r.leaf_count ?? null)
      setUsedSampleCount(r.sample_count ?? null)
      // Reflect what was ACTUALLY used back into the field itself, not
      // just a banner below it -- a capped request must not leave the
      // input silently showing a number that wasn't honored.
      if (r.samples_were_capped && r.sample_count != null) {
        setSampleCount(r.sample_count)
      }
      setStatus('ok')
    } catch {
      setStatus('error')
    } finally {
      clearTimeout(slowTimer)
      setShowSlowNotice(false)
    }
  }

  // Full, uncapped CSV export for a broad category ("all 128 samples",
  // not whatever number happened to be left in the Samples field after a
  // cap overwrote it -- see loadMappings). The on-screen table stays
  // fast/capped (samplesCapped), but a download is an explicit, one-off
  // action a researcher opts into and is willing to wait on.
  const FULL_SAMPLE_COUNT = 128

  async function downloadFullCsv() {
    if (!samplesCapped) {
      downloadCsv(
        sortedRows.map(r => buildMappingCsvRow(r, annotationId, source)),
        `${annotationId}_mappings.csv`,
      )
      return
    }
    setCsvStatus('loading')
    try {
      // Uncapped, all-128-samples -- can take noticeably longer than the
      // capped preview (up to several minutes for a high-volume cog/enzyme
      // id, see MAPPINGS_TIMEOUT_MS above), but this is an explicit,
      // opted-into export, not a passive browse.
      const r = await apiFetch<{ data: MappingSearchRow[] }>(
        buildMappingsUrl(annotationId, source, FULL_SAMPLE_COUNT, uniqueOnly, true),
        300_000,
      )
      downloadCsv(
        sortMappingRows(r.data ?? [], sortCol, sortDir).map(row => buildMappingCsvRow(row, annotationId, source)),
        `${annotationId}_mappings.csv`,
      )
      setCsvStatus('ok')
    } catch {
      setCsvStatus('error')
    }
  }

  function toggleSort(col: MappingSortCol) {
    if (sortCol === col) {
      setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    } else {
      setSortCol(col)
      setSortDir('asc')
    }
    setPage(1)
  }

  const sortedRows = useMemo(
    () => sortMappingRows(allRows, sortCol, sortDir),
    [allRows, sortCol, sortDir],
  )

  const totalPageCount = totalPages(sortedRows.length)
  const pageRows        = paginateRows(sortedRows, page)

  // Shorthand for sortable header — captures sortCol/sortDir/toggleSort
  const SortTh = ({ col, label }: { col: MappingSortCol; label: string }) => (
    <MappingsSortTh
      col={col}
      label={label}
      sortCol={sortCol}
      sortDir={sortDir}
      onSort={toggleSort}
    />
  )

  return (
    <div style={{ marginTop: 16 }}>
      <hr className="divider" />
      <button
        className={`mappings-toggle ${open ? 'open' : ''}`}
        onClick={() => {
          setOpen(o => !o)
          if (!open && status === 'idle') loadMappings()
        }}
      >
        <span className="toggle-icon">▶</span>
        <span className="toggle-label">View Annotation Mappings</span>
        {status === 'ok' && (
          <span className="toggle-count">{allRows.length} rows</span>
        )}
      </button>

      {open && (
        <div className="expand-anim">
          {/* ── Controls ── */}
          <div className="mappings-controls">
            <label>Samples:</label>
            <input
              className="field"
              type="number"
              min={1}
              max={128}
              value={sampleCount}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setSampleCount(Math.max(1, Math.min(128, Number(e.target.value))))
              }
              style={{ width: 80 }}
            />
            <label style={{ marginLeft: 8 }}>
              <input
                type="checkbox"
                checked={uniqueOnly}
                onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                  setUniqueOnly(e.target.checked)
                  loadMappings(sampleCount, e.target.checked)
                }}
                style={{ marginRight: 6 }}
              />
              Unique pairs only
            </label>
            <button
              className="btn sm primary"
              onClick={() => loadMappings()}
              style={{ marginLeft: 'auto' }}
            >
              Load
            </button>
            {status === 'ok' && allRows.length > 0 && (
              <button
                className="btn sm"
                onClick={downloadFullCsv}
                disabled={csvStatus === 'loading'}
                title={samplesCapped ? `Export all ${FULL_SAMPLE_COUNT} samples (not just the ${usedSampleCount ?? requestedSampleCount}-sample preview) -- may take a while` : undefined}
              >
                {csvStatus === 'loading'
                  ? 'Exporting…'
                  : samplesCapped ? `↓ CSV (all ${FULL_SAMPLE_COUNT})` : '↓ CSV'}
              </button>
            )}
          </div>
          {csvStatus === 'error' && (
            <div className="state-box error" style={{ padding: '8px 12px', marginTop: 4 }}>
              <span>Full CSV export failed -- try again, or export the {usedSampleCount ?? requestedSampleCount}-sample preview by narrowing to a specific gene/id first.</span>
            </div>
          )}

          {/* ── States ── */}
          {status === 'loading' && (
            <div style={{ padding: '12px 4px 0' }}>
              <div style={{
                font: '11px var(--mono)', color: 'var(--text-dim)', marginBottom: 4,
              }}>
                {showSlowNotice
                  ? 'Still working — some common ids take up to a minute…'
                  : `Searching mappings across ${requestedSampleCount} samples…`}
              </div>
              <SkeletonTable columns={6} rows={6} />
            </div>
          )}
          {status === 'error' && (
            <div className="state-box error" style={{ padding: '20px' }}>
              <span>Failed to load mappings.</span>
            </div>
          )}
          {status === 'ok' && allRows.length === 0 && (
            <div className="state-box" style={{ padding: '20px' }}>
              <div className="state-icon">∅</div>
              <span>
                No mappings found for <strong>{annotationId}</strong> in the
                selected {requestedSampleCount} sample{requestedSampleCount === 1 ? '' : 's'}.
              </span>
            </div>
          )}

          {/* ── Table ── */}
          {status === 'ok' && allRows.length > 0 && (
            <>
              {samplesCapped && (
                <div className="state-box" style={{ padding: '10px 12px', marginBottom: 8 }}>
                  <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                    {leafCount !== null && leafCount > 1
                      ? `${annotationId} is a broad category (${leafCount} member ids)`
                      : `${annotationId} matches a very large number of gene records`}
                    {' '}— showing results from
                    only {usedSampleCount ?? '—'} sample{usedSampleCount === 1 ? '' : 's'} instead
                    of the requested {requestedSampleCount} to keep this fast. Narrow to a
                    specific gene/id for full sample coverage, or use "Export all" below
                    for the full uncapped download.
                  </span>
                </div>
              )}
              {resultsWereTruncated && (
                <div className="state-box" style={{ padding: '10px 12px', marginBottom: 8 }}>
                  <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                    {annotationId} has an extremely large number of individual gene
                    records{samplesCapped ? '' : ` across the ${usedSampleCount ?? requestedSampleCount} sample${(usedSampleCount ?? requestedSampleCount) === 1 ? '' : 's'} shown`} —
                    only the first 50,000 are included below. This is a hard safety
                    limit (a prior version of this page crashed trying to load
                    everything at once), and no CSV export of this annotation
                    (including "Export all") can go past it either — a complete
                    export of every record isn't available for an annotation this large.
                  </span>
                </div>
              )}
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table className="mappings-table">
                  <thead>
                    <tr>
                      <SortTh col="date"     label="Date"       />
                      <SortTh col="time"     label="Time (24h)" />
                      <SortTh col="taxonomy" label="Taxonomy"   />
                      <SortTh col="kegg_id"  label="KEGG"       />
                      <SortTh col="enzyme"   label="Enzyme"     />
                      <SortTh col="cog_id"   label="COG"        />
                    </tr>
                  </thead>
                  <tbody>
                    {pageRows.map((row, i) => (
                      <tr key={i}>
                        <td style={{
                          fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap',
                        }}>
                          {fmtDate(row.timepoint?.datetime ?? '') || '—'}
                        </td>
                        <td style={{
                          fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap',
                        }}>
                          {fmtTime(row.timepoint?.datetime ?? '') || '—'}
                        </td>
                        <td>{row.taxonomy ?? '—'}</td>
                        <td>{row.kegg_id  ?? '—'}</td>
                        <td>{row.enzyme   ?? '—'}</td>
                        <td>{row.cog_id   ?? '—'}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>

              {/* ── Pagination ── */}
              {totalPageCount > 1 && (
                <div className="pagination">
                  <button
                    className="btn sm ghost"
                    onClick={() => setPage(p => Math.max(1, p - 1))}
                    disabled={page === 1}
                  >
                    ‹ Prev
                  </button>
                  <span className="pagination-info">
                    Page {page} of {totalPageCount} · {allRows.length} rows
                  </span>
                  <button
                    className="btn sm ghost"
                    onClick={() => setPage(p => Math.min(totalPageCount, p + 1))}
                    disabled={page === totalPageCount}
                  >
                    Next ›
                  </button>
                </div>
              )}
            </>
          )}
        </div>
      )}
    </div>
  )
}