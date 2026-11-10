// ── MappingsPanel ─────────────────────────────────────────────────────────────
// Collapsible panel showing gene-to-annotation mapping rows for one annotation.
// Rendered below each EgcChart in the Analyze page (single card view).
//
// Data source: /api/mappings/search?annotation_id=…&source=…&sample_count=…&unique_pairs=…
//
// Features:
//   - Adjustable sample count (1 to every sample), clamped server-side for a broad
//     category -- reflected back into the
//     field itself once a load reports it was capped, not just a banner
//   - Unique pairs toggle (deduplicates taxonomy|kegg|enzyme|cog combinations)
//     -- defaults to OFF for a leaf id (one specific gene: every sample it
//     appears in is real signal, not noise to collapse) and ON for a
//     pathway/class/category id (hundreds of genes, where duplicate
//     combinations really are redundant)
//   - One row per gene: sortable columns (date, time, gene, scaffold,
//     taxonomy, kegg_id, enzyme, cog_id)
//   - Pagination (25 rows per page)
//   - CSV export: "↓ CSV" downloads the loaded rows when they are complete;
//     when the preview was limited (sample cap or the 50,000-row limit),
//     "Export all" opens MappingsExportBox, which streams every gene record
//     from the server instead

import React, { useState, useMemo, useRef } from 'react'

import type { ApiStatus, MappingSortCol, SortDir, MappingSearchRow } from '../../types'
import { apiFetch, downloadCsv } from '../../utils/api'
import { fmtDate, fmtTime } from '../../utils/format'
import { SkeletonTable } from '../ui/Skeleton'
import { NumberField } from '../ui/controls'
import { useSampleTotal } from '../../utils/useSampleTotal'
import { MappingsExportBox } from './MappingsExportBox'
import {
  sortMappingRows, paginateRows, totalPages, buildMappingsUrl,
  isLikelyLeafAnnotation, buildMappingCsvRow,
} from './mappingsData'

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

// ── MappingsPanel ──────────────────────────────────────────────────────────

export function MappingsPanel({
  annotationId,
  source,
}: {
  annotationId: string
  source:       string
}) {
  const totalSamples = useSampleTotal()
  const [open, setOpen]               = useState(false)
  // Starts at every sample (the real count, once the sample list has loaded).
  const [sampleCount, setSampleCount] = useState(totalSamples)
  const [uniqueOnly, setUniqueOnly]   = useState(() => !isLikelyLeafAnnotation(source, annotationId))
  const [allRows, setAllRows]         = useState<MappingSearchRow[]>([])
  // Whether the loaded rows are unique combinations (each shown by its
  // earliest gene) or every gene -- the mode they were loaded in, not the
  // checkbox, which changes before its reload arrives.
  const [loadedUnique, setLoadedUnique] = useState(false)
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
  const [requestedSampleCount, setRequestedSampleCount] = useState(totalSamples)
  const [exportOpen, setExportOpen]   = useState(false)
  // Distinguishes WHY a request got capped: either annotationId resolved
  // to many real leaf ids (a genuine category/pathway/class -- leafCount
  // > 1), or it's a single leaf that's just individually high-volume
  // (leafCount === 1, e.g. COG2801 -- one specific COG, not a category,
  // but still 271K+ raw rows across 128 samples). The capped-notice
  // banner below must not call a single leaf id "a broad category" --
  // caught live, 2026-09-25, when a user correctly pointed out COG only
  // has 2 hierarchy levels and a leaf id has no "members" to be broad.
  const [leafCount, setLeafCount] = useState<number | null>(null)
  // A DIFFERENT failure mode from samplesCapped: the backend fits whole
  // samples, earliest first, within its hard row limit (samplesCapped),
  // but a single sample larger than the limit on its own (e.g. a whole
  // domain like Bacteria) is still cut off -- disclosed separately here.
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
  // Only the latest load may apply its response; an earlier one that
  // finishes later is ignored.
  const loadSeqRef = useRef(0)

  async function loadMappings(count = sampleCount, unique = uniqueOnly) {
    const requestId = ++loadSeqRef.current
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
      if (requestId !== loadSeqRef.current) return
      setAllRows(r.data ?? [])
      setLoadedUnique(unique)
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
      if (requestId !== loadSeqRef.current) return
      setStatus('error')
    } finally {
      clearTimeout(slowTimer)
      if (requestId === loadSeqRef.current) setShowSlowNotice(false)
    }
  }

  // The loaded rows are the whole answer unless the preview was limited;
  // then the CSV has to come from the server's full export instead.
  const previewIsPartial = samplesCapped || resultsWereTruncated

  function downloadPreviewCsv() {
    downloadCsv(
      sortedRows.map(r => buildMappingCsvRow(r, annotationId, source)),
      `${annotationId}_mappings.csv`,
    )
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

  const n = allRows.length
  const countLabel = loadedUnique
    ? `${n} unique combination${n === 1 ? '' : 's'}`
    : `${n} gene${n === 1 ? '' : 's'}`

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
          <span className="toggle-count">{countLabel}</span>
        )}
      </button>

      {open && (
        <div className="expand-anim">
          {/* ── Controls ── */}
          <div className="mappings-controls">
            <label>Samples:</label>
            <NumberField
              className="field"
              min={1}
              max={totalSamples}
              value={sampleCount}
              onChange={setSampleCount}
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
              previewIsPartial ? (
                <button
                  className="btn sm"
                  onClick={() => setExportOpen(o => !o)}
                  aria-expanded={exportOpen}
                  title="Download every gene record for this annotation, not just the preview below"
                >
                  ↓ Export all{exportOpen ? ' ▴' : ' ▾'}
                </button>
              ) : (
                <button className="btn sm" onClick={downloadPreviewCsv}>↓ CSV</button>
              )
            )}
          </div>
          {status === 'ok' && previewIsPartial && allRows.length > 0 && (
            <div
              data-testid="mappings-export-all-note"
              style={{ font: '11px var(--mono)', color: 'var(--text-dim)', margin: '-4px 0 10px' }}
            >
              Export all downloads every gene record for this annotation as a CSV, all samples or a
              date range you pick — not just the preview below.
            </div>
          )}
          {status === 'ok' && previewIsPartial && exportOpen && (
            <MappingsExportBox annotationId={annotationId} source={source} uniquePairs={uniqueOnly} />
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
              <SkeletonTable columns={8} rows={6} />
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
                {samplesCapped ? (
                  // The non-empty branch's cap-disclosure banner below is
                  // gated on `allRows.length > 0`, so a capped request that
                  // finds zero rows in its real (small) scanned scope needs
                  // its own message here -- the plain empty-state message
                  // names requestedSampleCount (the full ask, e.g. 128),
                  // which would overstate how much was actually searched
                  // (e.g. the real 5-sample scope, ~25x less).
                  <>
                    No mappings found for <strong>{annotationId}</strong> in
                    the {usedSampleCount ?? '—'} sample{usedSampleCount === 1 ? '' : 's'} actually
                    searched — {leafCount !== null && leafCount > 1
                      ? `${annotationId} is a broad category (${leafCount} member ids)`
                      : `${annotationId} matches a very large number of gene records`},
                    so only {usedSampleCount ?? '—'} of the requested {requestedSampleCount} samples were
                    scanned to keep this fast. Narrow to a specific gene/id for full sample coverage.
                  </>
                ) : (
                  <>
                    No mappings found for <strong>{annotationId}</strong> in the
                    selected {requestedSampleCount} sample{requestedSampleCount === 1 ? '' : 's'}.
                  </>
                )}
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
                    limit for the on-screen table (a prior version of this page
                    crashed trying to load everything at once). Use "Export all"
                    for a file with every record.
                  </span>
                </div>
              )}
              {loadedUnique && (
                <div style={{ font: '11px var(--mono)', color: 'var(--text-dim)', margin: '0 0 6px' }}>
                  One row per distinct taxonomy / KEGG / enzyme / COG combination, shown by the
                  earliest gene with that combination.
                </div>
              )}
              <div style={{ overflowX: 'auto', WebkitOverflowScrolling: 'touch' }}>
                <table className="mappings-table">
                  <thead>
                    <tr>
                      <SortTh col="date"     label="Date"       />
                      <SortTh col="time"     label="Time (24h)" />
                      <SortTh col="gene_id"   label="Gene"      />
                      <SortTh col="contig_id" label="Scaffold"  />
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
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {row.gene_id ?? '—'}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                          {row.contig_id ?? '—'}
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
                    Page {page} of {totalPageCount} · {countLabel}
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