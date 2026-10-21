// ── TaxonomyPage ──────────────────────────────────────────────────────────────
// Lets a user pick a scope taxon (typically a domain — Bacteria, Archaea,
// Eukaryota, Viruses) and exclude specific descendant branches from its
// aggregate EGC total, to see how the total changes without them.
//
// State is owned by App and passed down so the scope/exclusions/chart
// persist when the user navigates away and returns.
//
// The chart itself is the unmodified MultiEgcChart component, so it gets
// full parity with every other chart (normalize, LOWESS smooth, day/night,
// tide, day-band overlays) for free.

import React, { useCallback, useEffect, useMemo, useState } from 'react'

import type { AnnotationItem, ApiStatus, SeriesCache } from '../types'
import { apiFetch, downloadCsv } from '../utils/api'
import { computeExclusionSeries, computeInclusionSeries, filterRedundantExclusions, computeChartTitle, bareTaxonName, taxonomyDomainFromId } from '../utils/taxonomy'
import { TAXONOMY_RANK_NAMES, taxonomyRankLabel } from '../constants'
import { DateRangePicker } from '../components/ui/DateRangePicker'
import { ChartErrorBoundary } from '../components/ui/ChartErrorBoundary'
import { HelpTooltip } from '../components/ui/HelpTooltip'
import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import { TaxonomyTree } from '../components/taxonomy/TaxonomyTree'
import { TaxonomyBrowseTree } from '../components/taxonomy/TaxonomyBrowseTree'
import { ResetBtn } from '../components/ui/controls'

// Rank dropdown options for the "download taxa list" export — value is the
// lowercased form /taxonomy/export expects (e.g. "class", not the display
// label "Class" or the backend's internal "class_" storage detail).
const RANK_EXPORT_OPTIONS = Object.entries(TAXONOMY_RANK_NAMES)
  .sort(([a], [b]) => Number(a) - Number(b))
  .map(([depth, label]) => ({ value: label.toLowerCase(), label, depth }))

// ── State shape + default ──────────────────────────────────────────────────
// Co-located here because only TaxonomyPage uses TaxonomyState.

export type TaxonomyState = {
  rootId:            string | null
  rootQuery:         string
  rootSearchResults: AnnotationItem[]
  rootSearchStatus:  ApiStatus
  // How many taxa matched in all; more than rootSearchResults holds when
  // the server returned only its first page.
  rootSearchTotal:   number | null
  // The checked branches. Read as "remove these from the scope" or "keep only
  // these" depending on selectionMode -- switching modes keeps the same set.
  excludedIds:       Set<string>
  selectionMode:     'remove' | 'keep'
  seriesCache:       SeriesCache
  dateFrom:          string
  dateTo:            string
}

export function makeDefaultTaxonomyState(): TaxonomyState {
  return {
    rootId:            null,
    rootQuery:         '',
    rootSearchResults: [],
    rootSearchStatus:  'idle',
    rootSearchTotal:   null,
    excludedIds:       new Set(),
    selectionMode:     'remove',
    seriesCache:       {},
    dateFrom:          '',
    dateTo:            '',
  }
}

// ── TaxonomyPage ────────────────────────────────────────────────────────────

export function TaxonomyPage({
  state,
  setState,
  dataDateRange,
  onGoScaffoldExplore,
  onReset
}: {
  state:          TaxonomyState
  setState:       (updater: (prev: TaxonomyState) => TaxonomyState) => void
  dataDateRange?: { min: string; max: string } | null
  onGoScaffoldExplore?: (annotationId: string, source: string) => void
  onReset:        () => void
}) {
  // ── Download taxa list by rank ──────────────────────────────────────────
  // Independent of the scope/exclusion state above -- a standalone export
  // utility, so it gets its own local (non-persisted) state rather than
  // living in the shared TaxonomyState.
  const [exportRank, setExportRank]     = useState(RANK_EXPORT_OPTIONS[0].value)
  const [exportStatus, setExportStatus] = useState<ApiStatus>('idle')

  async function downloadTaxaAtRank() {
    setExportStatus('loading')
    try {
      const taxa = await apiFetch<string[]>(
        `/api/taxonomy/export?rank=${encodeURIComponent(exportRank)}`,
      )
      downloadCsv(taxa.map(name => ({ taxon: name })), `taxa_${exportRank}.csv`)
      setExportStatus('ok')
    } catch {
      setExportStatus('error')
    }
  }

  async function searchRoot() {
    const q = state.rootQuery.trim()
    if (!q) return
    setState(prev => ({ ...prev, rootSearchStatus: 'loading' }))
    try {
      const json = await apiFetch<{ data: AnnotationItem[]; total?: number }>(
        `/api/search/annotations?q=${encodeURIComponent(q)}&sources=taxonomy&page_size=500`,
      )
      const seen   = new Set<string>()
      const unique = (json.data ?? []).filter(r => {
        if (seen.has(r.annotation_id)) return false
        seen.add(r.annotation_id)
        return true
      })
      setState(prev => ({
        ...prev,
        rootSearchResults: unique,
        rootSearchTotal:   Math.max(json.total ?? unique.length, unique.length),
        rootSearchStatus:  'ok',
      }))
    } catch {
      setState(prev => ({ ...prev, rootSearchStatus: 'error' }))
    }
  }

  function pickRoot(annotationId: string) {
    // Changing scope clears exclusions from the previous scope — an
    // exclusion picked under one root has no meaning under a different one.
    setState(prev => ({
      ...prev,
      rootId:            annotationId,
      excludedIds:        new Set(),
      rootQuery:         '',
      rootSearchResults: [],
      rootSearchStatus:  'idle',
    }))
  }

  function changeRoot() {
    setState(prev => ({ ...prev, rootId: null, excludedIds: new Set() }))
  }

  function toggleExclude(annotationId: string) {
    setState(prev => {
      const next = new Set(prev.excludedIds)
      if (next.has(annotationId)) next.delete(annotationId); else next.add(annotationId)
      return { ...prev, excludedIds: next }
    })
  }

  // ── Series fetcher — mirrors AnalyzePage's fetchSeries pattern ──────────
  const fetchSeries = useCallback((annotationId: string) => {
    const key = `${annotationId}::taxonomy`
    setState(prev => {
      if (prev.seriesCache[key]) return prev
      return {
        ...prev,
        seriesCache: { ...prev.seriesCache, [key]: { data: [], status: 'loading' as ApiStatus } },
      }
    })
    apiFetch<{ data: AnnotationItem[] }>(
      `/api/series/annotations?source=taxonomy&annotation_id=${encodeURIComponent(annotationId)}&page_size=500`,
    ).then(json => {
      setState(prev => ({
        ...prev,
        seriesCache: { ...prev.seriesCache, [key]: { data: json.data ?? [], status: 'ok' as ApiStatus } },
      }))
    }).catch(() => {
      setState(prev => ({
        ...prev,
        seriesCache: { ...prev.seriesCache, [key]: { data: [], status: 'error' as ApiStatus } },
      }))
    })
  }, [setState])

  useEffect(() => {
    if (!state.rootId) return
    const needed = [state.rootId, ...state.excludedIds]
    for (const id of needed) {
      if (!state.seriesCache[`${id}::taxonomy`]) fetchSeries(id)
    }
  }, [state.rootId, state.excludedIds, state.seriesCache, fetchSeries])

  // The effect above only fetches a taxon that has NO cache entry yet --
  // once a fetch resolves to 'error', the entry exists (just with that
  // status), so the effect's own `!cache[key]` guard never fires again for
  // it, and a transient failure (one timeout) would be permanent for the
  // rest of the session. Evicting the entry makes the next
  // render see it as missing again, which the existing effect above picks
  // right back up -- no separate fetch path needed.
  const retrySeries = useCallback((annotationId: string) => {
    setState(prev => {
      const next = { ...prev.seriesCache }
      delete next[`${annotationId}::taxonomy`]
      return { ...prev, seriesCache: next }
    })
  }, [setState])

  const cache: SeriesCache = state.seriesCache
  const rootKey    = state.rootId ? `${state.rootId}::taxonomy` : null
  const rootEntry  = rootKey ? cache[rootKey] : undefined
  const rootStatus: ApiStatus = rootEntry?.status ?? 'idle'
  const rootData   = rootEntry?.data ?? []

  const excludedList     = [...state.excludedIds]
  const excludedStatuses = excludedList.map(id => cache[`${id}::taxonomy`]?.status ?? 'idle')
  // 'loading' and 'error' are tracked separately so a failed exclusion
  // fetch can be surfaced explicitly -- treated as one "not ready" state, a
  // failure would look like one still in flight while the chart fell back
  // to the unmodified full series and the title still claimed the
  // exclusion was applied.
  const excludedLoaded = excludedList.filter((_, i) => excludedStatuses[i] === 'ok')
  const excludedFailed = excludedList.filter((_, i) => excludedStatuses[i] === 'error')
  const excludedPending = excludedList.filter((_, i) =>
    excludedStatuses[i] !== 'ok' && excludedStatuses[i] !== 'error')

  const chartSeries = useMemo(() => {
    if (!state.rootId || rootStatus !== 'ok') return []

    const rootName = bareTaxonName(state.rootId)
    const full = {
      id:           state.rootId,
      annotationId: state.rootId,
      name:         `${rootName} (full)`,
      data:         rootData,
      // Literal hex, not a CSS var() string — Plotly's SVG traces can't
      // resolve custom properties the way regular DOM/CSS elements can, so
      // a var() color here silently renders as the default (both lines
      // indistinguishable black) even though a legend swatch would show it
      // correctly. Wong colorblind-safe palette, matching CB_EXTRA_GROUPS.
      color:        '#009E73',
      source:       'taxonomy',
    }

    // Only wait on exclusions still genuinely in flight -- a failed one
    // never becomes 'ok', so waiting on it too would hang the chart on
    // [full] forever with no explanation. Once every
    // exclusion has settled (ok or error), show whatever succeeded.
    if (excludedList.length === 0 || excludedPending.length > 0) return [full]
    if (excludedLoaded.length === 0) return [full] // every exclusion failed

    const excludedSeriesArrays = excludedLoaded.map(id => cache[`${id}::taxonomy`]?.data ?? [])

    if (state.selectionMode === 'keep') {
      // Only the checked branches, summed (computeInclusionSeries) -- the
      // complement of the minus line below for the same checked set.
      const keptNames = filterRedundantExclusions(excludedLoaded).map(bareTaxonName)
      const keepLabel = keptNames.length <= 3
        ? keptNames.join(' + ')
        : `${keptNames.length} kept branches of ${rootName}`
      return [full, {
        id:           `${state.rootId}__keep`,
        annotationId: `${state.rootId}__keep`,
        name:         keepLabel,
        data:         computeInclusionSeries(rootData, excludedLoaded, excludedSeriesArrays, `${state.rootId}__keep`, null),
        color:        '#D55E00',
        source:       'taxonomy',
        scaffoldsDisabled: true,
      }]
    }
    // annotationId just needs to be distinct from the root's own (see
    // computeExclusionSeries' doc comment) — MultiEgcChart's legend shows
    // .name, not annotationId, for taxonomy series, so this doesn't need to
    // be human-readable itself.
    const minusLabel = `${rootName} (minus ${excludedLoaded.length} exclusion${excludedLoaded.length !== 1 ? 's' : ''})`
    const minus = {
      id:           `${state.rootId}__minus`,
      annotationId: `${state.rootId}__minus`,
      name:         minusLabel,
      data:         computeExclusionSeries(rootData, excludedLoaded, excludedSeriesArrays, `${state.rootId}__excl`, null),
      color:        '#D55E00',
      source:       'taxonomy',
      scaffoldsDisabled: true
    }
    return [full, minus]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.rootId, state.selectionMode, rootStatus, rootData, excludedLoaded.join(','), excludedPending.length])

  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Taxonomy Explorer</h1>
          <p className="subtitle">
            Pick a taxon, then remove branches from its total or keep only the ones you check
          </p>
        </div>
        <div className="page-header-actions">
          <ResetBtn onClick={onReset} title="Clear Taxonomy" label="Clear Page" small/>
        </div>
      </div>

      <div className="page-body">
        <div>
          <div style={{ marginBottom: 8 }}><h2>Scope</h2></div>

          {!state.rootId && (
            <>
              <div className="search-bar" style={{ marginBottom: 10 }}>
                <input
                  className="field"
                  placeholder="Search for a taxon (e.g. Bacteria)…"
                  value={state.rootQuery}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setState(prev => ({ ...prev, rootQuery: e.target.value }))
                  }
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') searchRoot()
                  }}
                />
                <button className="btn primary" onClick={searchRoot}>Find</button>
              </div>

              {state.rootSearchStatus === 'ok' && state.rootSearchResults.length === 0 && (
                <div className="state-box" style={{ padding: '16px' }}>
                  No matching taxa.
                </div>
              )}

              {state.rootSearchResults.length > 0 && (
                <div
                  data-testid="taxonomy-search-count"
                  style={{ font: '11px var(--mono)', color: 'var(--text-dim)', margin: '0 0 6px' }}
                >
                  {(state.rootSearchTotal ?? 0) > state.rootSearchResults.length
                    ? `Showing the first ${state.rootSearchResults.length.toLocaleString()} of ${state.rootSearchTotal!.toLocaleString()} matching taxa — refine the search to narrow it.`
                    : `${state.rootSearchResults.length.toLocaleString()} matching ${state.rootSearchResults.length === 1 ? 'taxon' : 'taxa'}`}
                </div>
              )}

              {state.rootSearchResults.length > 0 && (
                <div style={{
                  background:   'var(--surface)',
                  border:       '1px solid var(--border)',
                  borderRadius: 8,
                  maxHeight:    480,
                  overflowY:    'auto',
                }}>
                  {state.rootSearchResults.map((r, i) => (
                    <div
                      key={r.annotation_id}
                      onClick={() => pickRoot(r.annotation_id)}
                      style={{
                        display:      'flex',
                        alignItems:   'center',
                        gap:          12,
                        padding:      '10px 16px',
                        cursor:       'pointer',
                        borderBottom: i < state.rootSearchResults.length - 1
                          ? '1px solid var(--border)'
                          : 'none',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = '' }}
                    >
                      <span style={{
                        fontFamily:    'var(--mono)',
                        fontSize:      10,
                        color:         'var(--text-dim)',
                        textTransform: 'uppercase',
                        letterSpacing: '.06em',
                        flexShrink:    0,
                      }}>
                        {taxonomyRankLabel(r.depth ?? null, taxonomyDomainFromId(r.annotation_id))}
                      </span>
                      <span
                        title={r.annotation_id}
                        style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--teal)', fontStyle: 'italic' }}
                      >
                        {r.name ?? r.annotation_id}
                      </span>
                    </div>
                  ))}
                </div>
              )}

              <div style={{
                display:      'flex',
                alignItems:   'center',
                gap:          10,
                margin:       '16px 0 10px',
                color:        'var(--text-dim)',
                font:         '11px var(--sans)',
                textTransform: 'uppercase',
              }}>
                <hr className="divider" style={{ flex: 1 }} />
                or browse
                <hr className="divider" style={{ flex: 1 }} />
              </div>

              <div style={{
                background:   'var(--surface)',
                border:       '1px solid var(--border)',
                borderRadius: 8,
                padding:      12,
                maxHeight:    400,
                overflowY:    'auto',
              }}>
                <TaxonomyBrowseTree onSelectRoot={pickRoot} />
              </div>

              <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginTop: 10 }}>
                <select
                  className="field"
                  style={{ width: 110 }}
                  value={exportRank}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setExportRank(e.target.value)}
                >
                  {RANK_EXPORT_OPTIONS.map(opt => (
                    <option key={opt.value} value={opt.value}>{opt.label}</option>
                  ))}
                </select>
                <button
                  className="btn sm"
                  onClick={downloadTaxaAtRank}
                  disabled={exportStatus === 'loading'}
                >
                  ↓ CSV
                </button>
                <HelpTooltip text="Download a CSV list of every unique taxon name at the selected rank (e.g. every order, every phylum) across the full dataset — not limited to a scope you've picked above." />
                {exportStatus === 'error' && (
                  <span style={{ font: '12px var(--sans)', color: 'var(--red, #d55e00)' }}>
                    Download failed — try again.
                  </span>
                )}
              </div>
            </>
          )}

          {state.rootId && (
            <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 4 }}>
              <span title={state.rootId} style={{ font: '13px var(--mono)', color: 'var(--teal)' }}>
                Scope: <span style={{ fontStyle: 'italic' }}>{bareTaxonName(state.rootId)}</span>
              </span>
              <button className="btn ghost sm" onClick={changeRoot}>✕ change scope</button>
              <HelpTooltip text="Changing the scope taxon clears your current exclusions — they don't carry over to a new scope." />
            </div>
          )}
        </div>

        {state.rootId && (
          <div style={{ display: 'flex', gap: 20, marginTop: 12, flexWrap: 'wrap' }}>
            <div style={{
              flex:         '0 0 320px',
              background:   'var(--surface)',
              border:       '1px solid var(--border)',
              borderRadius: 8,
              padding:      12,
              maxHeight:    520,
              overflowY:    'auto',
            }}>
              <div role="radiogroup" aria-label="What checked branches do" style={{ display: 'flex', gap: 12, marginBottom: 8, font: '12px var(--mono)' }}>
                {([['remove', 'Remove checked'], ['keep', 'Keep only checked']] as const).map(([mode, label]) => (
                  <label key={mode} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
                    <input
                      type="radio"
                      name="taxonomy-selection-mode"
                      checked={state.selectionMode === mode}
                      onChange={() => setState(prev => ({ ...prev, selectionMode: mode }))}
                    />
                    {label}
                  </label>
                ))}
              </div>
              <h2 style={{ fontSize: 14, marginBottom: 8 }}>
                {state.selectionMode === 'keep' ? 'Keep branches' : 'Remove branches'}
                <HelpTooltip text={state.selectionMode === 'keep'
                  ? "The second line is the sum of only the checked taxa (each with everything below it). Switching back to Remove keeps the same checks. You can't drill further into an already-checked branch, so nothing is counted twice."
                  : "Checking a taxon subtracts it (and everything below it) from the total. Switch to Keep only to see just the checked taxa instead -- your checks are kept. You can't drill further into an already-checked branch."} />
              </h2>
              <TaxonomyTree
                rootId={state.rootId}
                excludedIds={state.excludedIds}
                onToggleExclude={toggleExclude}
                mode={state.selectionMode}
              />
            </div>

            <div style={{ flex: '1 1 420px', minWidth: 320 }}>
              {rootStatus === 'loading' && (
                <div className="state-box" style={{ padding: 32 }}>Loading series…</div>
              )}
              {rootStatus === 'error' && (
                <div className="state-box" style={{ padding: 32 }}>
                  Failed to load series for {state.rootId}.
                  {' '}
                  <button
                    className="btn sm ghost"
                    onClick={() => state.rootId && retrySeries(state.rootId)}
                    style={{ marginLeft: 4 }}
                  >
                    Retry
                  </button>
                </div>
              )}
              {rootStatus === 'ok' && (
                <>
                  <div style={{
                    display:      'flex',
                    gap:          10,
                    alignItems:   'center',
                    marginBottom: 12,
                    flexWrap:     'wrap',
                  }}>
                    <DateRangePicker
                      from={state.dateFrom}
                      to={state.dateTo}
                      onFrom={v => setState(prev => ({ ...prev, dateFrom: v }))}
                      onTo={v => setState(prev => ({ ...prev, dateTo: v }))}
                      onClear={() => setState(prev => ({ ...prev, dateFrom: '', dateTo: '' }))}
                      minDate={dataDateRange?.min}
                      maxDate={dataDateRange?.max}
                    />
                  </div>

                  {/* Explicit, visible error state -- without this, a
                      failed exclusion fetch would look identical to "still
                      loading" while the chart fell back to the unmodified
                      total and the title kept claiming the exclusion. */}
                  {excludedFailed.length > 0 && (
                    <div className="state-box error" style={{ padding: '10px 14px', marginBottom: 12 }}>
                      Failed to load {excludedFailed.length} exclusion{excludedFailed.length !== 1 ? 's' : ''}:
                      {' '}{excludedFailed.map(bareTaxonName).join(', ')}.
                      {' '}The chart below excludes only the {excludedLoaded.length} that loaded successfully.
                      {' '}
                      <button
                        className="btn sm ghost"
                        onClick={() => excludedFailed.forEach(retrySeries)}
                        style={{ marginLeft: 4 }}
                      >
                        Retry
                      </button>
                      {' '}
                      <button
                        className="btn sm ghost"
                        onClick={() => excludedFailed.forEach(toggleExclude)}
                        style={{ marginLeft: 4 }}
                      >
                        Remove failed exclusion{excludedFailed.length !== 1 ? 's' : ''}
                      </button>
                    </div>
                  )}

                  <ChartErrorBoundary label="Taxonomy explorer">
                    <MultiEgcChart
                      series={chartSeries}
                      dateFrom={state.dateFrom}
                      dateTo={state.dateTo}
                      dataDateRange={dataDateRange}
                      title={computeChartTitle(state.rootId, excludedLoaded, state.selectionMode)}
                      onGoScaffoldExplore={onGoScaffoldExplore}
                    />
                  </ChartErrorBoundary>
                </>
              )}
            </div>
          </div>
        )}
      </div>
    </div>
  )
}
