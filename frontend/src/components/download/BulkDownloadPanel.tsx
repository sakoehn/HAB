// ── BulkDownloadPanel ─────────────────────────────────────────────────────────
// The Explore page's "Bulk Download" section: pick a starting taxon (or the
// whole dataset) and a deeper rank, and download every taxon at that rank as
// one long CSV -- e.g. every family under Gammaproteobacteria, or every
// species under one family (ranks can be skipped). The file comes straight
// from /api/series/export as a plain link, so the browser streams it to disk
// instead of the page building it in memory; /api/series/export/summary
// supplies the size shown before downloading.
//
// Taxonomy is the only source for now. kegg/cog/enzyme are listed but
// disabled so the layout doesn't change when they're added.

import React, { useEffect, useState } from 'react'

import type { AnnotationItem, ApiStatus } from '../../types'
import { TAXONOMY_RANK_NAMES } from '../../constants'
import { apiFetch } from '../../utils/api'
import { buildExportQuery, rankOptionsBelow } from '../../utils/bulkDownload'
import { DateRangePicker } from '../ui/DateRangePicker'
import { HelpTooltip } from '../ui/HelpTooltip'
import { TaxonomyBrowseTree } from '../taxonomy/TaxonomyBrowseTree'

const SOURCES = [
  { value: 'taxonomy', label: 'Taxonomy', enabled: true },
  { value: 'kegg',     label: 'KEGG (coming soon)',   enabled: false },
  { value: 'cog',      label: 'COG (coming soon)',    enabled: false },
  { value: 'enzyme',   label: 'Enzyme (coming soon)', enabled: false },
]

const RANK_PLURALS: Record<string, string> = {
  domain:  'domains',
  phylum:  'phyla',
  class:   'classes',
  order:   'orders',
  family:  'families',
  genus:   'genera',
  species: 'species',
  strain:  'strains',
}

type ExportSummary = {
  taxa:     number
  samples:  number
  max_rows: number
  sparse:   boolean
}

export function BulkDownloadPanel({
  initialParent,
  dataDateRange,
}: {
  // A new object each time another page hands a taxon over (e.g. the
  // Taxonomy page's shortcut), so the same lineage handed over twice
  // still applies after the user has changed it here in between.
  initialParent?: { lineage: string }
  dataDateRange?: { min: string; max: string } | null
}) {
  const [source]                = useState('taxonomy')
  const [parent, setParent]     = useState<string | null>(initialParent?.lineage ?? null)
  const [rank, setRank]         = useState(() => rankOptionsBelow(initialParent?.lineage ?? null)[0]?.value ?? '')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [picker, setPicker]     = useState<'none' | 'search' | 'browse'>('none')

  const [query, setQuery]                 = useState('')
  const [searchResults, setSearchResults] = useState<AnnotationItem[]>([])
  const [searchStatus, setSearchStatus]   = useState<ApiStatus>('idle')

  // The last summary response, with the request it answers -- it only
  // counts while that is still the current choice, so a change shows
  // "Counting…" straight away and a slower, superseded response is never
  // shown.
  const [summaryResult, setSummaryResult] = useState<
    { query: string; summary: ExportSummary | null; status: 'ok' | 'error' } | null
  >(null)

  const rankOptions = rankOptionsBelow(parent)

  function chooseParent(lineage: string | null) {
    setParent(lineage)
    setPicker('none')
    // Keep the chosen rank if it is still below the new start, otherwise
    // move to the next rank down from it.
    const options = rankOptionsBelow(lineage)
    setRank(prev => (options.some(o => o.value === prev) ? prev : options[0]?.value ?? ''))
  }

  // A newly handed-over taxon replaces the current start. Applied during
  // render, as ExplorePage does for visitedSections, rather than in an
  // effect.
  const [appliedInitialParent, setAppliedInitialParent] = useState(initialParent)
  if (initialParent !== appliedInitialParent) {
    setAppliedInitialParent(initialParent)
    if (initialParent) chooseParent(initialParent.lineage)
  }

  const exportQuery = rank ? buildExportQuery({ source, parent, rank, dateFrom, dateTo }) : ''

  useEffect(() => {
    if (!exportQuery) return
    let cancelled = false
    apiFetch<ExportSummary>(`/api/series/export/summary?${exportQuery}`)
      .then(json => {
        if (!cancelled) setSummaryResult({ query: exportQuery, summary: json, status: 'ok' })
      })
      .catch(() => {
        if (!cancelled) setSummaryResult({ query: exportQuery, summary: null, status: 'error' })
      })
    return () => { cancelled = true }
  }, [exportQuery])

  const summaryStatus: ApiStatus = !exportQuery
    ? 'idle'
    : summaryResult?.query === exportQuery ? summaryResult.status : 'loading'
  const summary = summaryStatus === 'ok' ? summaryResult!.summary : null

  async function search() {
    const q = query.trim()
    if (!q) return
    setSearchStatus('loading')
    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/search/annotations?q=${encodeURIComponent(q)}&sources=taxonomy&page_size=50`,
      )
      const seen = new Set<string>()
      setSearchResults((json.data ?? []).filter(r => !seen.has(r.annotation_id) && !!seen.add(r.annotation_id)))
      setSearchStatus('ok')
    } catch {
      setSearchStatus('error')
    }
  }

  const rankPlural = RANK_PLURALS[rank] ?? rank
  const canDownload = summaryStatus === 'ok' && !!summary && summary.taxa > 0
  const parentRank = parent ? TAXONOMY_RANK_NAMES[parent.split(';').length] : null

  return (
    <div style={{ padding: '20px 24px 24px' }}>
      <div style={{ marginBottom: 4 }}><h2>Bulk Download</h2></div>
      <p style={{ font: '12px var(--sans)', color: 'var(--text-dim)', marginBottom: 16 }}>
        Download the time series of every taxon at one rank under a starting taxon, as a CSV with one row per
        taxon per sample.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '12px 14px', alignItems: 'center', maxWidth: 760 }}>
        <label htmlFor="bulk-source" className="bulk-label">Source</label>
        <select id="bulk-source" className="field" style={{ width: 200 }} value={source} onChange={() => {}}>
          {SOURCES.map(s => (
            <option key={s.value} value={s.value} disabled={!s.enabled}>{s.label}</option>
          ))}
        </select>

        <span className="bulk-label" style={{ alignSelf: 'start', paddingTop: 6 }}>Start from</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              data-testid="bulk-start"
              title={parent ?? undefined}
              style={{ font: '13px var(--mono)', color: 'var(--text-h)', overflowWrap: 'anywhere' }}
            >
              {parent ? parent.split(';').join(' › ') : 'Whole dataset'}
              {parentRank && (
                <span style={{ marginLeft: 6, font: '11px var(--sans)', color: 'var(--text-dim)' }}>({parentRank})</span>
              )}
            </span>
            <button
              className={`btn sm ${picker === 'search' ? 'primary' : ''}`}
              onClick={() => setPicker(p => (p === 'search' ? 'none' : 'search'))}
            >
              Search
            </button>
            <button
              className={`btn sm ${picker === 'browse' ? 'primary' : ''}`}
              onClick={() => setPicker(p => (p === 'browse' ? 'none' : 'browse'))}
            >
              Browse tree
            </button>
            {parent && (
              <button className="btn sm ghost" onClick={() => chooseParent(null)}>Whole dataset</button>
            )}
          </div>

          {picker === 'search' && (
            <div style={{ marginTop: 10 }}>
              <div className="search-bar" style={{ marginBottom: 8 }}>
                <input
                  className="field"
                  placeholder="Search for a taxon (e.g. Gammaproteobacteria)…"
                  value={query}
                  autoFocus
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') search() }}
                />
                <button className="btn primary" onClick={search}>Find</button>
              </div>
              {searchStatus === 'error' && <div className="state-box error" style={{ padding: 12 }}>Search failed.</div>}
              {searchStatus === 'ok' && searchResults.length === 0 && (
                <div className="state-box" style={{ padding: 12 }}>No matching taxa.</div>
              )}
              {searchResults.length > 0 && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 260, overflowY: 'auto' }}>
                  {searchResults.map(r => (
                    <button
                      key={r.annotation_id}
                      className="bulk-search-result"
                      onClick={() => chooseParent(r.annotation_id)}
                      title={r.annotation_id}
                    >
                      <span style={{ fontStyle: 'italic', color: 'var(--text-h)' }}>{r.annotation_id.split(';').pop()}</span>
                      {r.depth != null && TAXONOMY_RANK_NAMES[r.depth] && (
                        <span style={{ font: '11px var(--sans)', color: 'var(--text-dim)' }}>{TAXONOMY_RANK_NAMES[r.depth]}</span>
                      )}
                      <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                        {r.annotation_id}
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}

          {picker === 'browse' && (
            <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', maxHeight: 320, overflowY: 'auto' }}>
              <TaxonomyBrowseTree onSelectRoot={id => chooseParent(id)} />
            </div>
          )}
        </div>

        <label htmlFor="bulk-rank" className="bulk-label">Download every</label>
        {rankOptions.length > 0 ? (
          <select
            id="bulk-rank"
            className="field"
            style={{ width: 200 }}
            value={rank}
            onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setRank(e.target.value)}
          >
            {rankOptions.map(o => <option key={o.value} value={o.value}>{o.label}</option>)}
          </select>
        ) : (
          <span id="bulk-rank" style={{ font: '12px var(--sans)', color: 'var(--text-dim)' }}>
            Nothing is below a strain — pick a higher starting taxon.
          </span>
        )}

        <span className="bulk-label">Dates</span>
        <DateRangePicker
          from={dateFrom}
          to={dateTo}
          onFrom={setDateFrom}
          onTo={setDateTo}
          onClear={() => { setDateFrom(''); setDateTo('') }}
          minDate={dataDateRange?.min}
          maxDate={dataDateRange?.max}
        />
      </div>

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 14, maxWidth: 760 }}>
        {summaryStatus === 'loading' && (
          <div style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>Counting…</div>
        )}
        {summaryStatus === 'error' && (
          <div data-testid="bulk-error" className="state-box error" style={{ padding: 12 }}>
            Could not work out the size of this download. Try again, or pick a different start or rank.
          </div>
        )}
        {summaryStatus === 'ok' && summary && (
          <div data-testid="bulk-size" style={{ font: '12px var(--mono)', color: 'var(--text-h)' }}>
            {summary.taxa === 0
              ? `No ${rankPlural} under this starting taxon${dateFrom || dateTo ? ' in this date range' : ''}.`
              : `${summary.taxa.toLocaleString()} ${rankPlural} × ${summary.samples.toLocaleString()} samples ≈ ${summary.max_rows.toLocaleString()} rows`}
          </div>
        )}
        {summaryStatus === 'ok' && summary?.sparse && summary.taxa > 0 && (
          <div data-testid="bulk-sparse-note" style={{ font: '12px var(--sans)', color: 'var(--amber)', marginTop: 6 }}>
            ⚠ Too large to open in Excel (over 1,048,576 rows), so rows are written only for samples where each
            taxon was detected. It may take a little while to download.
          </div>
        )}

        <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 14 }}>
          {canDownload ? (
            <a
              className="btn primary"
              style={{ textDecoration: 'none' }}
              href={`/api/series/export?${exportQuery}`}
              download
            >
              ↓ Download CSV
            </a>
          ) : (
            <button className="btn primary" disabled>↓ Download CSV</button>
          )}
          <HelpTooltip text={'Columns: taxon, rank, lineage, sample, date, egc, norm_egc, detected. Samples where a taxon was not detected are written as 0 with detected = false. "unclassified …" taxa hold the reads that were not classified down to this rank, so every rank adds up to the starting taxon\'s total.'} />
        </div>
      </div>
    </div>
  )
}
