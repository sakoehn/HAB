// ── ComparePage ───────────────────────────────────────────────────────────────
// Dedicated overlay page for comparing up to 4 annotation time series.
//
// State is owned by App and passed down so selections persist when the user
// navigates away and returns.
//
// Features:
//   - Search + bulk-select results (checkboxes, select-all)
//   - Up to 4 annotation slots; additional slots disabled when full
//   - Scale-mismatch warning → prompts Z-score normalize
//   - Date range filter on the overlay chart
//   - Mappings panel for each loaded annotation
//   - CSV export of all series data
//
// initialAnnotations: annotations pre-loaded from the Analyze page
// via the "→ Compare page" button in the Compare drawer.
// onConsumed: called once initialAnnotations have been loaded so App
// can clear the pending queue.

import React, { useState, useEffect, useCallback } from 'react'

import type {
  CompareState, CompareEntry, AnnotationItem, ApiStatus, SharedAnnotation,
} from '../types'
import { SOURCE_TAG_CLS } from '../constants'
import { nextColorForSource, resetSourceCounters } from '../constants'
import { apiFetch, downloadCsv } from '../utils/api'
import { isoDate } from '../utils/format'
import { extractEgc } from '../utils/stats'
import { useCopyId } from '../hooks/useCopyId'
import { CopyBtn } from '../components/ui/controls'
import { DateRangePicker } from '../components/ui/DateRangePicker'
import { ChartErrorBoundary } from '../components/ui/ChartErrorBoundary'
import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import { MappingsPanel } from '../components/mappings/MappingsPanel'

// ── State shape + default ──────────────────────────────────────────────────
// Co-located here because only ComparePage uses CompareState.

export type CompareState = {
  query:         string
  querySource:   string
  searchResults: AnnotationItem[]
  searchStatus:  ApiStatus
  entries:       CompareEntry[]
  showMappings:  boolean
  dateFrom:      string
  dateTo:        string
}

export function makeDefaultCompareState(): CompareState {
  return {
    query:         '',
    querySource:   'kegg',
    searchResults: [],
    searchStatus:  'idle',
    entries:       [],
    showMappings:  false,
    dateFrom:      '',
    dateTo:        '',
  }
}

// ── ComparePage ────────────────────────────────────────────────────────────

export function ComparePage({
  state,
  setState,
  initialAnnotations,
  onConsumed,
  dataDateRange,
  onGoScaffoldExplore,
}: {
  state:                CompareState
  setState:             (updater: (prev: CompareState) => CompareState) => void
  initialAnnotations:   SharedAnnotation[]
  onConsumed:           () => void
  dataDateRange?:       { min: string; max: string } | null
  onGoScaffoldExplore?: (annotationId: string, source: string) => void
}) {
  const { copiedId, copy } = useCopyId()

  // Load annotations arriving from the Analyze page Compare drawer
  useEffect(() => {
    if (!initialAnnotations.length) return
    onConsumed()
    resetSourceCounters()

    const toLoad  = initialAnnotations.slice(0, 4)
    const colors  = toLoad.map(ann => nextColorForSource(ann.source))

    setState(prev => ({
      ...prev,
      entries: toLoad.map((ann, i) => ({
        annotationId: ann.annotationId,
        source:       ann.source,
        name:         ann.name,
        data:         [],
        status:       'loading' as ApiStatus,
        color:        colors[i],
      })),
    }))

    Promise.all(
      toLoad.map((ann, i) =>
        apiFetch<{ data: AnnotationItem[] }>(
          `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotationId)}&page_size=5000`,
        )
          .then(json => ({ ann, i, data: json.data ?? [] }))
          .catch(() => ({ ann, i, data: [] as AnnotationItem[] })),
      ),
    ).then(results => {
      setState(prev => ({
        ...prev,
        entries: results.map(({ ann, i, data }) => ({
          annotationId: ann.annotationId,
          source:       ann.source,
          name:         ann.name,
          data,
          status:       (data.length > 0 ? 'ok' : 'error') as ApiStatus,
          color:        colors[i],
        })),
      }))
    })
  }, [initialAnnotations])

  // ── Bulk-select state ──────────────────────────────────────────────────
  const [bulkSelected, setBulkSelected] = useState<Set<string>>(new Set())

  async function searchForAdd() {
    const q = state.query.trim()
    if (!q) return
    setState(prev => ({ ...prev, searchStatus: 'loading' }))
    setBulkSelected(new Set())
    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/search/annotations?q=${encodeURIComponent(q)}&sources=${state.querySource}&page_size=500`,
      )
      const seen   = new Set<string>()
      const unique = (json.data ?? []).filter(r => {
        if (seen.has(r.annotation_id)) return false
        seen.add(r.annotation_id)
        return true
      })
      setState(prev => ({ ...prev, searchResults: unique, searchStatus: 'ok' }))
    } catch {
      setState(prev => ({ ...prev, searchStatus: 'error' }))
    }
  }

  function toggleBulkSelect(annotationId: string) {
    setBulkSelected(prev => {
      const next = new Set(prev)
      if (next.has(annotationId)) {
        next.delete(annotationId)
      } else if (state.entries.length + next.size < 4) {
        next.add(annotationId)
      }
      return next
    })
  }

  async function addSelectedAnnotations() {
    const toAdd  = state.searchResults.filter(r => bulkSelected.has(r.annotation_id))
    if (!toAdd.length) return

    const colors     = toAdd.map(ann => nextColorForSource(ann.source))
    const newEntries: CompareEntry[] = toAdd.map((ann, i) => ({
      annotationId: ann.annotation_id,
      source:       ann.source,
      name:         ann.name,
      data:         [],
      status:       'loading' as ApiStatus,
      color:        colors[i],
    }))

    setState(prev => ({
      ...prev,
      entries:       [...prev.entries, ...newEntries].slice(0, 4),
      searchResults: [],
      query:         '',
    }))
    setBulkSelected(new Set())

    await Promise.all(toAdd.map(async (ann, i) => {
      try {
        const json = await apiFetch<{ data: AnnotationItem[] }>(
          `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=5000`,
        )
        setState(prev => ({
          ...prev,
          entries: prev.entries.map(e =>
            e.annotationId === ann.annotation_id && e.source === ann.source
              ? { ...e, data: json.data ?? [], status: 'ok' }
              : e,
          ),
        }))
      } catch {
        setState(prev => ({
          ...prev,
          entries: prev.entries.map(e =>
            e.annotationId === ann.annotation_id && e.source === ann.source
              ? { ...e, status: 'error' }
              : e,
          ),
        }))
      }
    }))
  }

  // Legacy single-add (clicking a result row directly)
  async function addAnnotation(ann: AnnotationItem) {
    if (state.entries.length >= 4) return
    if (state.entries.some(
      e => e.annotationId === ann.annotation_id && e.source === ann.source,
    )) return

    const color = nextColorForSource(ann.source)
    setState(prev => ({
      ...prev,
      entries: [...prev.entries, {
        annotationId: ann.annotation_id,
        source:       ann.source,
        name:         ann.name,
        data:         [],
        status:       'loading' as ApiStatus,
        color,
      }],
      searchResults: [],
      query:         '',
    }))

    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/series/annotations?source=${ann.source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=5000`,
      )
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.annotationId === ann.annotation_id && e.source === ann.source
            ? { ...e, data: json.data ?? [], status: 'ok' }
            : e,
        ),
      }))
    } catch {
      setState(prev => ({
        ...prev,
        entries: prev.entries.map(e =>
          e.annotationId === ann.annotation_id && e.source === ann.source
            ? { ...e, status: 'error' }
            : e,
        ),
      }))
    }
  }

  const readyEntries   = state.entries.filter(e => e.status === 'ok')
  const slotsRemaining = 4 - state.entries.length

  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Compare Annotations</h1>
          <p className="subtitle">
            Overlay up to 4 annotations · L1 normalize · LOWESS smooth ·
            4 max keeps the chart readable
          </p>
        </div>
      </div>

      <div className="page-body">

        {/* ── Add annotations ── */}
        <div>
          <div style={{ marginBottom: 8 }}><h2>Add Annotations</h2></div>
          <div className="search-bar" style={{ marginBottom: 10 }}>
            <select
              className="field"
              style={{ width: 130, flex: 'none' }}
              value={state.querySource}
              onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                setState(prev => ({ ...prev, querySource: e.target.value }))
              }
            >
              {['kegg', 'cog', 'enzyme', 'taxonomy'].map(s => (
                <option key={s} value={s}>{s}</option>
              ))}
            </select>
            <input
              className="field"
              placeholder="Search annotation ID or name…"
              value={state.query}
              onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                setState(prev => ({ ...prev, query: e.target.value }))
              }
              onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                if (e.key === 'Enter') searchForAdd()
              }}
            />
            <button
              className="btn primary"
              onClick={searchForAdd}
              disabled={state.entries.length >= 4}
            >
              Find
            </button>
          </div>

          {/* ── Search results with bulk-select ── */}
          {state.searchStatus === 'ok' && state.searchResults.length > 0 && (
            <div style={{ marginBottom: 12 }}>
              <div style={{
                background:   'var(--surface)',
                border:       '1px solid var(--border)',
                borderRadius: 8,
                overflow:     'hidden',
              }}>
                {/* Header: select-all + bulk add */}
                <div style={{
                  display:      'flex',
                  alignItems:   'center',
                  gap:          12,
                  padding:      '9px 16px',
                  background:   'var(--surface3)',
                  borderBottom: '1px solid var(--border)',
                }}>
                  <label style={{
                    display:    'flex',
                    alignItems: 'center',
                    gap:        7,
                    cursor:     'pointer',
                    font:       '400 12px var(--mono)',
                    color:      'var(--text-dim)',
                  }}>
                    <input
                      type="checkbox"
                      checked={
                        bulkSelected.size > 0 &&
                        state.searchResults
                          .slice(0, slotsRemaining)
                          .every(r => bulkSelected.has(r.annotation_id))
                      }
                      onChange={() => {
                        const allSlice = state.searchResults
                          .slice(0, slotsRemaining)
                          .map(r => r.annotation_id)
                        const allSelected = allSlice.every(id => bulkSelected.has(id))
                        setBulkSelected(new Set(allSelected ? [] : allSlice))
                      }}
                    />
                    Select all visible
                  </label>
                  <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                    {state.searchResults.length} results ·{' '}
                    {slotsRemaining} slot{slotsRemaining !== 1 ? 's' : ''} available
                  </span>
                  {bulkSelected.size > 0 ? (
                    <button
                      className="btn sm primary"
                      style={{ marginLeft: 'auto' }}
                      onClick={addSelectedAnnotations}
                    >
                      + Add {bulkSelected.size} selected
                    </button>
                  ) : (
                    <span style={{
                      marginLeft: 'auto',
                      font:       '11px var(--mono)',
                      color:      'var(--text-dim)',
                    }}>
                      Check boxes below, or click a row to add one
                    </span>
                  )}
                </div>

                {/* Result rows */}
                {state.searchResults.slice(0, 12).map((r, i) => {
                  const alreadyAdded = state.entries.some(
                    e => e.annotationId === r.annotation_id && e.source === r.source,
                  )
                  const isChecked = bulkSelected.has(r.annotation_id)
                  const canAdd    = !alreadyAdded && slotsRemaining > 0

                  return (
                    <div
                      key={i}
                      style={{
                        display:      'flex',
                        alignItems:   'center',
                        gap:          12,
                        padding:      '10px 16px',
                        cursor:       canAdd ? 'pointer' : 'default',
                        opacity:      alreadyAdded ? 0.45 : 1,
                        borderBottom: i < Math.min(12, state.searchResults.length) - 1
                          ? '1px solid var(--border)'
                          : 'none',
                        background:   isChecked ? 'var(--teal-dim)' : 'transparent',
                        transition:   'background .12s',
                      }}
                      onClick={() =>
                        canAdd && !bulkSelected.size ? addAnnotation(r) : undefined
                      }
                      onMouseEnter={e => {
                        if (!isChecked) e.currentTarget.style.background = 'var(--surface2)'
                      }}
                      onMouseLeave={e => {
                        e.currentTarget.style.background =
                          isChecked ? 'var(--teal-dim)' : ''
                      }}
                    >
                      <input
                        type="checkbox"
                        checked={isChecked}
                        disabled={!canAdd}
                        onChange={() => toggleBulkSelect(r.annotation_id)}
                        onClick={e => e.stopPropagation()}
                        style={{ flexShrink: 0 }}
                      />
                      <span style={{
                        fontFamily: 'var(--mono)',
                        fontSize:   13,
                        color:      'var(--teal)',
                        flexShrink: 0,
                      }}>
                        {r.annotation_id}
                      </span>
                      <span style={{
                        fontSize:     14,
                        color:        'var(--text-h)',
                        flex:         1,
                        overflow:     'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace:   'nowrap',
                      }}>
                        {r.name ?? '—'}
                      </span>
                      <span className={`tag ${SOURCE_TAG_CLS[r.source] ?? ''}`}>
                        {r.source}
                      </span>
                      {alreadyAdded
                        ? <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>added</span>
                        : <span style={{ color: 'var(--teal)', fontSize: 18 }}>+</span>
                      }
                    </div>
                  )
                })}
              </div>
            </div>
          )}

          {state.searchStatus === 'error' && (
            <div className="state-box error" style={{ padding: '12px' }}>
              <span>Search failed.</span>
            </div>
          )}
        </div>

        {/* ── Selected annotations ── */}
        {state.entries.length > 0 && (
          <div>
            <div style={{ marginBottom: 10 }}><h2>Selected Annotations</h2></div>
            <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', marginBottom: 16 }}>
              {state.entries.map(e => (
                <div
                  className="compare-chip"
                  key={`${e.annotationId}::${e.source}`}
                >
                  <div className="chip-color" style={{ background: e.color }} />
                  <CopyBtn
                    id={e.annotationId}
                    copiedId={copiedId}
                    onCopy={copy}
                  />
                  <span>{e.annotationId}</span>
                  <span style={{ color: 'var(--text-dim)', fontSize: 12 }}>
                    {e.source}
                  </span>
                  {e.status === 'loading' && (
                    <span style={{ fontSize: 12, color: 'var(--text-dim)' }}>…</span>
                  )}
                  <button
                    className="chip-remove"
                    onClick={() => setState(prev => {
                      const next = prev.entries.filter(
                        x => !(x.annotationId === e.annotationId && x.source === e.source),
                      )
                      if (next.length === 0) resetSourceCounters()
                      return { ...prev, entries: next }
                    })}
                  >
                    ×
                  </button>
                </div>
              ))}
              {state.entries.length < 4 && (
                <span style={{
                  fontSize:   13,
                  fontFamily: 'var(--mono)',
                  color:      'var(--text-dim)',
                  alignSelf:  'center',
                }}>
                  + add up to {4 - state.entries.length} more
                </span>
              )}
            </div>

            {/* ── Overlay chart ── */}
            {readyEntries.length > 0 && (
              <>
                <div style={{
                  display:    'flex',
                  gap:        10,
                  alignItems: 'center',
                  marginBottom: 12,
                  flexWrap:   'wrap',
                }}>
                  <DateRangePicker
                    from={state.dateFrom}
                    to={state.dateTo}
                    onFrom={v => setState(prev => ({ ...prev, dateFrom: v }))}
                    onTo={v => setState(prev => ({ ...prev, dateTo: v }))}
                    onClear={() =>
                      setState(prev => ({ ...prev, dateFrom: '', dateTo: '' }))
                    }
                    minDate={dataDateRange?.min}
                    maxDate={dataDateRange?.max}
                  />
                  <button
                    className="btn sm"
                    style={{ marginLeft: 'auto' }}
                    onClick={() => {
                      const rowsOut: Record<string, unknown>[] = []
                      for (const e of readyEntries) {
                        for (const d of e.data) {
                          const iso = isoDate(d.timepoint?.datetime ?? '')
                          if (state.dateFrom && iso < state.dateFrom) continue
                          if (state.dateTo   && iso > state.dateTo)   continue
                          rowsOut.push({
                            annotation_id: e.annotationId,
                            source:        e.source,
                            sample:        d.sample,
                            date:          d.timepoint?.datetime ?? '',
                            egc:           extractEgc(d.value),
                          })
                        }
                      }
                      downloadCsv(rowsOut, 'compare_egc.csv')
                    }}
                  >
                    ↓ CSV
                  </button>
                </div>

                <ChartErrorBoundary label="Compare overlay">
                  <MultiEgcChart
                    series={readyEntries.map(e => ({
                      annotationId: e.annotationId,
                      name:         e.name,
                      data:         e.data,
                      color:        e.color,
                      source:       e.source,
                    }))}
                    dateFrom={state.dateFrom}
                    dateTo={state.dateTo}
                    dataDateRange={dataDateRange}
                    onGoScaffoldExplore={onGoScaffoldExplore}
                  />
                </ChartErrorBoundary>
              </>
            )}

            {/* ── Mappings ── */}
            {readyEntries.length > 0 && (
              <div style={{ marginTop: 16 }}>
                <hr className="divider" />
                <button
                  className={`mappings-toggle ${state.showMappings ? 'open' : ''}`}
                  onClick={() =>
                    setState(prev => ({ ...prev, showMappings: !prev.showMappings }))
                  }
                >
                  <span className="toggle-icon">▶</span>
                  <span className="toggle-label">
                    View Mappings for All Selected Annotations
                  </span>
                </button>
                {state.showMappings && readyEntries.map(e => (
                  <div
                    key={`${e.annotationId}::${e.source}`}
                    style={{ marginBottom: 16 }}
                  >
                    <div style={{
                      marginBottom: 6,
                      display:      'flex',
                      alignItems:   'center',
                      gap:          8,
                    }}>
                      <div style={{
                        width:        10,
                        height:       10,
                        borderRadius: '50%',
                        background:   e.color,
                      }} />
                      <span style={{
                        fontSize:   13,
                        fontFamily: 'var(--mono)',
                        color:      'var(--text-h)',
                      }}>
                        {e.annotationId}
                      </span>
                      <span className={`tag ${SOURCE_TAG_CLS[e.source] ?? ''}`}>
                        {e.source}
                      </span>
                    </div>
                    <MappingsPanel
                      annotationId={e.annotationId}
                      source={e.source}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        )}

        {/* ── Empty state ── */}
        {state.entries.length === 0 && (
          <div className="state-box">
            <div className="state-icon">📊</div>
            <span>
              Search for annotations above. Select one or more checkboxes,
              then click &quot;Add N selected&quot; — or click any row directly
              to add it.
            </span>
          </div>
        )}

      </div>
    </div>
  )
}
