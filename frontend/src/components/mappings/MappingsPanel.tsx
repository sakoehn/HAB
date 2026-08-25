// ── MappingsPanel ─────────────────────────────────────────────────────────────
// Collapsible panel showing gene-to-annotation mapping rows for one annotation.
// Rendered below each EgcChart in the Analyze page (single card view).
//
// Data source: /api/mappings/search?annotation_id=…&source=…&sample_count=…&unique_pairs=…
//
// Features:
//   - Adjustable sample count (1–128)
//   - Unique pairs toggle (deduplicates taxonomy|kegg|enzyme|cog combinations)
//     defaults to ON — most researchers want distinct combinations, not every row
//   - Sortable columns (date, time, taxonomy, kegg_id, enzyme, cog_id)
//   - Pagination (100 rows per page)
//   - CSV export of all sorted rows

import React, { useState, useMemo } from 'react'

import type { ApiStatus, MappingSortCol, SortDir, MappingSearchRow } from '../../types'
import { apiFetch, downloadCsv } from '../../utils/api'
import { fmtDate, fmtTime } from '../../utils/format'
import { HelpTooltip } from '../ui/HelpTooltip'
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

const MAPPINGS_PAGE_SIZE = 25

// ── Pure helpers ─────────────────────────────────────────────────────────────
// Exported so tests can exercise the real sort/paginate/URL logic directly.

export function sortMappingRows(
  rows:    MappingSearchRow[],
  sortCol: MappingSortCol,
  sortDir: SortDir,
): MappingSearchRow[] {
  return [...rows].sort((a, b) => {
    // Both 'date' and 'time' sort by full datetime (ISO string sorts correctly)
    const av = (sortCol === 'date' || sortCol === 'time')
      ? (a.timepoint?.datetime ?? '')
      : ((a[sortCol as keyof MappingSearchRow] ?? '') as string)
    const bv = (sortCol === 'date' || sortCol === 'time')
      ? (b.timepoint?.datetime ?? '')
      : ((b[sortCol as keyof MappingSearchRow] ?? '') as string)
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

export function buildMappingsUrl(
  annotationId: string,
  source:       string,
  sampleCount:  number,
  uniquePairs:  boolean,
): string {
  return `/api/mappings/search?annotation_id=${encodeURIComponent(annotationId)}&source=${source}&sample_count=${sampleCount}&unique_pairs=${uniquePairs}`
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
  const [uniqueOnly, setUniqueOnly]   = useState(true)
  const [allRows, setAllRows]         = useState<MappingSearchRow[]>([])
  const [status, setStatus]           = useState<ApiStatus>('idle')
  const [sortCol, setSortCol]         = useState<MappingSortCol>('date')
  const [sortDir, setSortDir]         = useState<SortDir>('asc')
  const [page, setPage]               = useState(1)

  async function loadMappings(count = sampleCount, unique = uniqueOnly) {
    setStatus('loading')
    setPage(1)
    try {
      const r = await apiFetch<{ data: MappingSearchRow[]; total: number }>(
        buildMappingsUrl(annotationId, source, count, unique),
      )
      setAllRows(r.data ?? [])
      setStatus('ok')
    } catch {
      setStatus('error')
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
                onClick={() => downloadCsv(
                  sortedRows.map(r => buildMappingCsvRow(r, annotationId, source)),
                  `${annotationId}_mappings.csv`,
                )}
              >
                ↓ CSV
              </button>
            )}
          </div>

          {/* ── States ── */}
          {status === 'loading' && (
            <div style={{ padding: '12px 4px 0' }}>
              <div style={{
                font: '11px var(--mono)', color: 'var(--text-dim)', marginBottom: 4,
              }}>
                Searching mappings across {sampleCount} samples…
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
                No mappings found for <strong>{annotationId}</strong>.
                {(source ==='kegg' || source ==='enzyme') &&
                ( <HelpTooltip text="Category/pathway-level annotations (e.g. a KEGG BRITE category or pathway, or an Enzyme class like 6.3.2) aren't tagged directly on individual genes — only leaf-level IDs (e.g. KO:K02112, EC:7.1.2.2) appear in gene mappings." />)}
              </span>
            </div>
          )}

          {/* ── Table ── */}
          {status === 'ok' && allRows.length > 0 && (
            <>
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