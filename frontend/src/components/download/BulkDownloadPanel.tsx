// ── BulkDownloadPanel ─────────────────────────────────────────────────────────
// The Explore page's "Bulk Download" section: pick a source, a starting term
// (or the whole dataset) and a deeper level, and download every term at that
// level as one long CSV -- e.g. every family under Gammaproteobacteria, or
// every EC number under a sub-subclass (levels can be skipped). The file
// comes straight from /api/series/export as a plain link, so the browser
// streams it to disk instead of the page building it in memory;
// /api/series/export/summary supplies the size shown before downloading.
//
// Taxonomy and Enzyme are available. KEGG and COG are listed but disabled
// until their backend support exists.

import React, { useEffect, useState } from 'react'

import type { AnnotationItem, ApiStatus, HierarchyTreeNode } from '../../types'
import { apiFetch } from '../../utils/api'
import { buildExportQuery, levelLabel, levelOptionsBelow } from '../../utils/bulkDownload'
import { DateRangePicker } from '../ui/DateRangePicker'
import { HelpTooltip } from '../ui/HelpTooltip'
import { TaxonomyBrowseTree } from '../taxonomy/TaxonomyBrowseTree'
import { HierarchyBrowseTree } from '../hierarchy/HierarchyBrowseTree'

const SOURCES = [
  { value: 'taxonomy', label: 'Taxonomy',           enabled: true },
  { value: 'enzyme',   label: 'Enzyme',             enabled: true },
  { value: 'kegg',     label: 'KEGG (coming soon)', enabled: false },
  { value: 'cog',      label: 'COG (coming soon)',  enabled: false },
]

const LEVEL_PLURALS: Record<string, string> = {
  domain:      'domains',
  phylum:      'phyla',
  class:       'classes',
  order:       'orders',
  family:      'families',
  genus:       'genera',
  species:     'species',
  strain:      'strains',
  subclass:    'subclasses',
  subsubclass: 'sub-subclasses',
  ec:          'EC numbers',
}

const SEARCH_PLACEHOLDERS: Record<string, string> = {
  taxonomy: 'Search for a taxon (e.g. Gammaproteobacteria)…',
  enzyme:   'Search for an EC number or name (e.g. 5.6.2, helicase)…',
}

const COLUMNS_HELP: Record<string, string> = {
  taxonomy: 'Columns: taxon, rank, lineage, sample, date, egc, norm_egc, detected. Samples where a taxon was not detected are written as 0 with detected = false. "unclassified …" taxa hold the reads that were not classified down to this rank, so every rank adds up to the starting taxon\'s total.',
  enzyme:   'Columns: annotation_id, name, level, lineage_ids, lineage, also_in_other_paths, is_starting_term, sample, date, egc, norm_egc, detected. Samples where a term was not detected are written as 0 with detected = false.',
}

// Shown under the size line for sources whose rows don't add up to the
// starting term the way taxonomy's do.
const SOURCE_NOTES: Record<string, string> = {
  enzyme: 'Rows may not add up to the starting term. Genes known only to a higher level — a partial EC number such as 3.1.-, or an old number that was later split — count towards that level but towards no EC number below it, and a gene with two EC numbers counts under each. Tick "Also include the starting term\'s own total" to compare.',
}

type ExportSummary = {
  taxa:     number
  samples:  number
  max_rows: number
  sparse:   boolean
}

type Start = { id: string; depth: number; name: string }

// A term's level when the search/tree didn't supply one: taxonomy ids are
// lineages ("a;b;c" is depth 3), EC ids are dotted ("5.6.2" is depth 3).
function idDepth(source: string, id: string): number {
  return id.split(source === 'taxonomy' ? ';' : '.').length
}

function taxonomyStart(lineage: string): Start {
  return { id: lineage, depth: idDepth('taxonomy', lineage), name: lineage.split(';').pop() ?? lineage }
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
  const initialStart = initialParent ? taxonomyStart(initialParent.lineage) : null
  const [source, setSource]     = useState('taxonomy')
  const [start, setStart]       = useState<Start | null>(initialStart)
  const [rank, setRank]         = useState(() => levelOptionsBelow('taxonomy', initialStart?.depth ?? 0)[0]?.value ?? '')
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [includeParent, setIncludeParent] = useState(false)
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

  const rankOptions = levelOptionsBelow(source, start?.depth ?? 0)

  function chooseStart(src: string, next: Start | null, keepRank = true) {
    setStart(next)
    setPicker('none')
    // Keep the chosen level if it is still below the new start, otherwise
    // move to the next level down from it.
    const options = levelOptionsBelow(src, next?.depth ?? 0)
    setRank(prev => (keepRank && options.some(o => o.value === prev) ? prev : options[0]?.value ?? ''))
  }

  function changeSource(src: string) {
    setSource(src)
    setQuery('')
    setSearchResults([])
    setSearchStatus('idle')
    chooseStart(src, null, false)
  }

  // A newly handed-over taxon replaces the current start (switching back to
  // taxonomy if needed). Applied during render, as ExplorePage does for
  // visitedSections, rather than in an effect.
  const [appliedInitialParent, setAppliedInitialParent] = useState(initialParent)
  if (initialParent !== appliedInitialParent) {
    setAppliedInitialParent(initialParent)
    if (initialParent) {
      if (source !== 'taxonomy') changeSource('taxonomy')
      chooseStart('taxonomy', taxonomyStart(initialParent.lineage), source === 'taxonomy')
    }
  }

  const exportQuery = rank
    ? buildExportQuery({ source, parent: start?.id ?? null, rank, dateFrom, dateTo, includeParent })
    : ''

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
        `/api/search/annotations?q=${encodeURIComponent(q)}&sources=${encodeURIComponent(source)}&page_size=50`,
      )
      const seen = new Set<string>()
      setSearchResults((json.data ?? []).filter(r => !seen.has(r.annotation_id) && !!seen.add(r.annotation_id)))
      setSearchStatus('ok')
    } catch {
      setSearchStatus('error')
    }
  }

  function pickSearchResult(r: AnnotationItem) {
    const name = source === 'taxonomy' ? r.annotation_id.split(';').pop() ?? r.annotation_id : r.name ?? ''
    chooseStart(source, { id: r.annotation_id, depth: r.depth ?? idDepth(source, r.annotation_id), name })
  }

  function pickTreeNode(node: HierarchyTreeNode) {
    chooseStart(source, { id: node.annotationId, depth: node.depth ?? idDepth(source, node.annotationId), name: node.name })
  }

  const rankPlural = LEVEL_PLURALS[rank] ?? rank
  const canDownload = summaryStatus === 'ok' && !!summary && summary.taxa > 0
  const startLevel = start ? levelLabel(source, start.depth) : undefined
  const sourceNote = SOURCE_NOTES[source]

  return (
    <div style={{ padding: '20px 24px 24px' }}>
      <div style={{ marginBottom: 4 }}><h2>Bulk Download</h2></div>
      <p style={{ font: '12px var(--sans)', color: 'var(--text-dim)', marginBottom: 16 }}>
        Download the time series of every term at one level under a starting term, as a CSV with one row per
        term per sample.
      </p>

      <div style={{ display: 'grid', gridTemplateColumns: 'max-content 1fr', gap: '12px 14px', alignItems: 'center', maxWidth: 760 }}>
        <label htmlFor="bulk-source" className="bulk-label">Source</label>
        <select
          id="bulk-source"
          className="field"
          style={{ width: 200 }}
          value={source}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => changeSource(e.target.value)}
        >
          {SOURCES.map(s => (
            <option key={s.value} value={s.value} disabled={!s.enabled}>{s.label}</option>
          ))}
        </select>

        <span className="bulk-label" style={{ alignSelf: 'start', paddingTop: 6 }}>Start from</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
            <span
              data-testid="bulk-start"
              title={start?.id}
              style={{ font: '13px var(--mono)', color: 'var(--text-h)', overflowWrap: 'anywhere' }}
            >
              {!start
                ? 'Whole dataset'
                : source === 'taxonomy'
                  ? start.id.split(';').join(' › ')
                  : `${start.id} ${start.name}`}
              {startLevel && (
                <span style={{ marginLeft: 6, font: '11px var(--sans)', color: 'var(--text-dim)' }}>({startLevel})</span>
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
            {start && (
              <button className="btn sm ghost" onClick={() => chooseStart(source, null)}>Whole dataset</button>
            )}
          </div>

          {picker === 'search' && (
            <div style={{ marginTop: 10 }}>
              <div className="search-bar" style={{ marginBottom: 8 }}>
                <input
                  className="field"
                  placeholder={SEARCH_PLACEHOLDERS[source]}
                  value={query}
                  autoFocus
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => setQuery(e.target.value)}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => { if (e.key === 'Enter') search() }}
                />
                <button className="btn primary" onClick={search}>Find</button>
              </div>
              {searchStatus === 'error' && <div className="state-box error" style={{ padding: 12 }}>Search failed.</div>}
              {searchStatus === 'ok' && searchResults.length === 0 && (
                <div className="state-box" style={{ padding: 12 }}>No matches.</div>
              )}
              {searchResults.length > 0 && (
                <div style={{ border: '1px solid var(--border)', borderRadius: 8, maxHeight: 260, overflowY: 'auto' }}>
                  {searchResults.map(r => {
                    const level = r.depth != null ? levelLabel(source, r.depth) : undefined
                    return (
                      <button
                        key={r.annotation_id}
                        className="bulk-search-result"
                        onClick={() => pickSearchResult(r)}
                        title={r.annotation_id}
                      >
                        {source === 'taxonomy' ? (
                          <span style={{ fontStyle: 'italic', color: 'var(--text-h)' }}>{r.annotation_id.split(';').pop()}</span>
                        ) : (
                          <span style={{ font: '12px var(--mono)', color: 'var(--text-h)' }}>{r.annotation_id}</span>
                        )}
                        <span style={{ font: '11px var(--sans)', color: 'var(--text-dim)' }}>{level ?? ''}</span>
                        <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                          {source === 'taxonomy' ? r.annotation_id : r.name}
                        </span>
                      </button>
                    )
                  })}
                </div>
              )}
            </div>
          )}

          {picker === 'browse' && (
            <div style={{ marginTop: 10, border: '1px solid var(--border)', borderRadius: 8, padding: '8px 12px', maxHeight: 320, overflowY: 'auto' }}>
              {source === 'taxonomy'
                ? <TaxonomyBrowseTree onSelectRoot={id => chooseStart(source, taxonomyStart(id))} />
                : <HierarchyBrowseTree source="enzyme" onSelect={pickTreeNode} />}
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
            Nothing is below this level — pick a higher starting term.
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

        {start && (
          <>
            <span />
            <label style={{ display: 'flex', alignItems: 'center', gap: 8, font: '12px var(--sans)', color: 'var(--text)' }}>
              <input
                type="checkbox"
                checked={includeParent}
                onChange={e => setIncludeParent(e.target.checked)}
              />
              Also include the starting term's own total
              <HelpTooltip text="Adds the starting term's own time series as the first rows of the file, so you can compare it with the rows below it." />
            </label>
          </>
        )}
      </div>

      <div style={{ borderTop: '1px solid var(--border)', marginTop: 18, paddingTop: 14, maxWidth: 760 }}>
        {summaryStatus === 'loading' && (
          <div style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>Counting…</div>
        )}
        {summaryStatus === 'error' && (
          <div data-testid="bulk-error" className="state-box error" style={{ padding: 12 }}>
            Could not work out the size of this download. Try again, or pick a different start or level.
          </div>
        )}
        {summaryStatus === 'ok' && summary && (
          <div data-testid="bulk-size" style={{ font: '12px var(--mono)', color: 'var(--text-h)' }}>
            {summary.taxa === 0
              ? `No ${rankPlural} under this starting point${dateFrom || dateTo ? ' in this date range' : ''}.`
              : `${summary.taxa.toLocaleString()} ${rankPlural} × ${summary.samples.toLocaleString()} samples ≈ ${summary.max_rows.toLocaleString()} rows`}
          </div>
        )}
        {summaryStatus === 'ok' && summary?.sparse && summary.taxa > 0 && (
          <div data-testid="bulk-sparse-note" style={{ font: '12px var(--sans)', color: 'var(--amber)', marginTop: 6 }}>
            ⚠ Too large to open in Excel (over 1,048,576 rows), so rows are written only for samples where each
            term was detected. It may take a little while to download.
          </div>
        )}
        {sourceNote && (
          <div data-testid="bulk-source-note" style={{ font: '12px var(--sans)', color: 'var(--text-dim)', marginTop: 6 }}>
            {sourceNote}
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
          <HelpTooltip text={COLUMNS_HELP[source] ?? ''} />
        </div>
      </div>
    </div>
  )
}
