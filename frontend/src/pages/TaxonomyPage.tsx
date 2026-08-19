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
import { computeExclusionSeries, computeChartTitle } from '../utils/taxonomy'
import { TAXONOMY_RANK_NAMES } from '../constants'
import { DateRangePicker } from '../components/ui/DateRangePicker'
import { ChartErrorBoundary } from '../components/ui/ChartErrorBoundary'
import { HelpTooltip } from '../components/ui/HelpTooltip'
import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import { TaxonomyTree } from '../components/taxonomy/TaxonomyTree'
import { TaxonomyBrowseTree } from '../components/taxonomy/TaxonomyBrowseTree'

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
  excludedIds:       Set<string>
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
    excludedIds:       new Set(),
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
}: {
  state:          TaxonomyState
  setState:       (updater: (prev: TaxonomyState) => TaxonomyState) => void
  dataDateRange?: { min: string; max: string } | null
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
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/search/annotations?q=${encodeURIComponent(q)}&sources=taxonomy&page_size=500`,
      )
      const seen   = new Set<string>()
      const unique = (json.data ?? []).filter(r => {
        if (seen.has(r.annotation_id)) return false
        seen.add(r.annotation_id)
        return true
      })
      setState(prev => ({ ...prev, rootSearchResults: unique, rootSearchStatus: 'ok' }))
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
      `/api/series/annotations?source=taxonomy&annotation_id=${encodeURIComponent(annotationId)}&page_size=5000`,
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

  const cache: SeriesCache = state.seriesCache
  const rootKey    = state.rootId ? `${state.rootId}::taxonomy` : null
  const rootEntry  = rootKey ? cache[rootKey] : undefined
  const rootStatus: ApiStatus = rootEntry?.status ?? 'idle'
  const rootData   = rootEntry?.data ?? []

  const excludedList  = [...state.excludedIds]
  const excludedReady = excludedList.every(id => cache[`${id}::taxonomy`]?.status === 'ok')

  const chartSeries = useMemo(() => {
    if (!state.rootId || rootStatus !== 'ok') return []

    const full = {
      annotationId: state.rootId,
      name:         `${state.rootId} (full)`,
      data:         rootData,
      // Literal hex, not a CSS var() string — Plotly's SVG traces can't
      // resolve custom properties the way regular DOM/CSS elements can, so
      // a var() color here silently renders as the default (both lines
      // indistinguishable black) even though a legend swatch would show it
      // correctly. Wong colorblind-safe palette, matching CB_EXTRA_GROUPS.
      color:        '#009E73',
      source:       'taxonomy',
    }

    if (excludedList.length === 0 || !excludedReady) return [full]

    const excludedSeriesArrays = excludedList.map(id => cache[`${id}::taxonomy`]?.data ?? [])
    // MultiEgcChart's legend/hover/CSV all key off SeriesEntry.annotationId
    // (not .name — see its legend-item span, which renders {s.annotationId}
    // and only uses .name as a title tooltip), so the friendly label goes
    // directly into annotationId here to actually show up on the chart.
    const minusLabel = `${state.rootId} (minus ${excludedList.length} exclusion${excludedList.length !== 1 ? 's' : ''})`
    const minus = {
      annotationId: minusLabel,
      name:         minusLabel,
      data:         computeExclusionSeries(rootData, excludedSeriesArrays, `${state.rootId}__excl`, null),
      color:        '#D55E00',
      source:       'taxonomy',
    }
    return [full, minus]
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [state.rootId, rootStatus, rootData, excludedReady, excludedList.join(',')])

  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Taxonomy Explorer</h1>
          <p className="subtitle">
            Pick a taxon, then exclude branches to see the total without them
          </p>
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
                <div style={{
                  background:   'var(--surface)',
                  border:       '1px solid var(--border)',
                  borderRadius: 8,
                  overflow:     'hidden',
                }}>
                  {state.rootSearchResults.slice(0, 12).map((r, i) => (
                    <div
                      key={r.annotation_id}
                      onClick={() => pickRoot(r.annotation_id)}
                      style={{
                        display:      'flex',
                        alignItems:   'center',
                        gap:          12,
                        padding:      '10px 16px',
                        cursor:       'pointer',
                        borderBottom: i < Math.min(12, state.rootSearchResults.length) - 1
                          ? '1px solid var(--border)'
                          : 'none',
                      }}
                      onMouseEnter={e => { e.currentTarget.style.background = 'var(--surface2)' }}
                      onMouseLeave={e => { e.currentTarget.style.background = '' }}
                    >
                      <span style={{ fontFamily: 'var(--mono)', fontSize: 13, color: 'var(--teal)' }}>
                        {r.annotation_id}
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
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 4 }}>
              <span style={{ font: '13px var(--mono)', color: 'var(--teal)' }}>
                Scope: {state.rootId}
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
              <h2 style={{ fontSize: 14, marginBottom: 8 }}>
                Exclude branches
                <HelpTooltip text="Checking a taxon subtracts it (and everything below it) from the total. You can't drill further into an already-excluded branch." />
              </h2>
              <TaxonomyTree
                rootId={state.rootId}
                excludedIds={state.excludedIds}
                onToggleExclude={toggleExclude}
              />
            </div>

            <div style={{ flex: '1 1 420px', minWidth: 320 }}>
              {rootStatus === 'loading' && (
                <div className="state-box" style={{ padding: 32 }}>Loading series…</div>
              )}
              {rootStatus === 'error' && (
                <div className="state-box" style={{ padding: 32 }}>
                  Failed to load series for {state.rootId}.
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

                  <ChartErrorBoundary label="Taxonomy explorer">
                    <MultiEgcChart
                      series={chartSeries}
                      dateFrom={state.dateFrom}
                      dateTo={state.dateTo}
                      dataDateRange={dataDateRange}
                      title={computeChartTitle(state.rootId, excludedList)}
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
