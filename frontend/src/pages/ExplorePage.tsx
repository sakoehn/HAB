// ── ExplorePage ───────────────────────────────────────────────────────────────
// Five-section exploration page. Each section is a collapsible card.
//
// Sections:
//   overview   — DatasetOverviewPanel: summary stats + temporal chart
//   top-egc    — top N annotations by mean EGC, sortable table
//   by-parent  — AnnotationsByParentPanel: grouped by pathway/category
//   lookup     — annotation ID / keyword search with detail card
//   scaffolds  — ScaffoldExplorePanel: scaffold counts over time
//
// State is owned by App and passed down so the open section and loaded
// data persist when the user navigates away and returns.
//
// Sub-components DatasetOverviewPanel and AnnotationsByParentPanel are
// defined in this file because they are only used here and are tightly
// coupled to ExploreState.

import React, { useState, useEffect, useMemo } from 'react'

import type {
  ApiStatus, TopAnnotation, AnnotationValue, AnnotationItem,
  ExploreSection, ExploreSortCol, SortDir,
} from '../types'
import { SOURCE_COLORS, SOURCE_TAG_CLS, expandParentLabel } from '../constants'
import { apiFetch, downloadCsv } from '../utils/api'
import { extractEgc, computeTrend } from '../utils/stats'
import { useCopyId } from '../hooks/useCopyId'
import { CopyBtn } from '../components/ui/controls'
import { DateRangePicker } from '../components/ui/DateRangePicker'
import { ChartErrorBoundary } from '../components/ui/ChartErrorBoundary'
import { StatsPanel } from '../components/ui/StatsPanel'
import { ExternalLinks } from '../components/ui/ExternalLinks'
import { HelpTooltip } from '../components/ui/HelpTooltip'
import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import { GroupedEgcChart } from '../components/charts/GroupedEgcChart'
import { ScaffoldBtn } from '../components/scaffolds/ScaffoldBtn'
import { ScaffoldExplorePanel } from '../components/scaffolds/ScaffoldExplorePanel'

// ── ExploreState + default ─────────────────────────────────────────────────
// Co-located here — only ExplorePage uses this shape.

export type ExploreState = {
  openSection:  ExploreSection | null
  source:       string
  limit:        number
  dateFrom:     string
  dateTo:       string
  rows:         TopAnnotation[]
  sampleCount:  number | null
  status:       ApiStatus
  sortCol:      ExploreSortCol
  sortDir:      SortDir
  parentSource: string
  topFilter:    string
  // Lookup section
  lookupId:       string
  lookupSource:   string
  lookupResults:  TopAnnotation[]
  lookupSelected: TopAnnotation | null
  lookupTotal:    number
  lookupStatus:   ApiStatus
  // Scaffold section
  scaffoldInitialTerms?: { annotationId: string; source: string }[]
}

export function makeDefaultExploreState(): ExploreState {
  return {
    openSection:  null,
    source:       'kegg',
    limit:        25,
    dateFrom:     '',
    dateTo:       '',
    rows:         [],
    sampleCount:  null,
    status:       'idle',
    sortCol:      'mean_egc',
    sortDir:      'desc',
    parentSource: 'kegg',
    topFilter:    '',
    lookupId:       '',
    lookupSource:   'kegg',
    lookupResults:  [],
    lookupSelected: null,
    lookupTotal:    0,
    lookupStatus:   'idle',
    scaffoldInitialTerms: undefined,
  }
}

// ── ExploreSortTh ──────────────────────────────────────────────────────────

function ExploreSortTh({
  col, label, sortCol, sortDir, onSort,
}: {
  col:     ExploreSortCol
  label:   string
  sortCol: ExploreSortCol
  sortDir: SortDir
  onSort:  (col: ExploreSortCol) => void
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

// ── DatasetOverviewPanel ───────────────────────────────────────────────────

function DatasetOverviewPanel({
  resetKey,
  dataDateRange,
}: {
  resetKey:      number
  dataDateRange: { min: string; max: string } | null
}) {
  const [source, setSource]             = useState('kegg')
  const [dateFrom, setDateFrom]         = useState('')
  const [dateTo, setDateTo]             = useState('')
  const [rows, setRows]                 = useState<TopAnnotation[]>([])
  const [sampleCount, setSampleCount]   = useState<number | null>(null)
  const [status, setStatus]             = useState<ApiStatus>('idle')
  const [seriesData, setSeriesData]     = useState<Record<string, AnnotationItem[]>>({})
  const [seriesStatus, setSeriesStatus] = useState<ApiStatus>('idle')
  const [seriesFailed, setSeriesFailed] = useState<string[]>([])

  useEffect(() => {
    setSource('kegg'); setDateFrom(''); setDateTo('')
    setRows([]); setSampleCount(null); setStatus('idle')
    setSeriesData({}); setSeriesStatus('idle'); setSeriesFailed([])
  }, [resetKey])

  async function load() {
    setStatus('loading')
    setSeriesData({}); setSeriesStatus('idle'); setSeriesFailed([])
    try {
      let url = `/api/annotations/top?source=${source}&limit=200`
      if (dateFrom) url += `&date_from=${dateFrom}`
      if (dateTo)   url += `&date_to=${dateTo}`
      const r = await apiFetch<{ data: TopAnnotation[]; sample_count: number }>(url)
      setRows(r.data ?? [])
      setSampleCount(r.sample_count)
      setStatus('ok')
    } catch { setStatus('error') }
  }

  const parentGroups = useMemo(() => {
    const map = new Map<string, TopAnnotation[]>()
    for (const r of rows) {
      const key = r.parent ?? 'Ungrouped'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return Array.from(map.entries())
      .map(([parent, items]) => ({
        parent,
        label:  expandParentLabel(parent, source),
        sumEgc: items.reduce((s, i) => s + i.mean_egc, 0),
        count:  items.length,
        items,
      }))
      .sort((a, b) => b.sumEgc - a.sumEgc)
  }, [rows, source])

  const top5Groups = parentGroups.slice(0, 5)

  const CHART_GROUP_COLORS = [
    'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
    'var(--chart-4)', 'var(--amber)',
  ]

  async function loadTemporalChart() {
    const allAnns = top5Groups.flatMap(g => g.items).slice(0, 40)
    if (!allAnns.length) return
    setSeriesStatus('loading')
    const results = await Promise.all(
      allAnns.map(ann =>
        apiFetch<{ data: AnnotationItem[] }>(
          `/api/series/annotations?source=${source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=5000`,
        )
          .then(r => ({ id: ann.annotation_id, data: r.data ?? [], failed: false }))
          .catch(() => ({ id: ann.annotation_id, data: [] as AnnotationItem[], failed: true })),
      ),
    )
    const map: Record<string, AnnotationItem[]> = {}
    const failed: string[] = []
    for (const { id, data, failed: f } of results) {
      map[id] = data
      if (f) failed.push(id)
    }
    setSeriesData(map)
    setSeriesFailed(failed)
    setSeriesStatus('ok')
  }

  const temporalSeries = useMemo(() => {
    if (!Object.keys(seriesData).length) return []
    return top5Groups.map((group, gi) => ({
      annotationId: group.label,
      name:         group.label,
      color:        CHART_GROUP_COLORS[gi],
      source,
      data:         group.items.flatMap(ann => {
        const annData = seriesData[ann.annotation_id] ?? []
        return annData.map(d => ({ ...d, annotation_id: group.label }))
      }),
    }))
  }, [seriesData, top5Groups, source])

  const overviewStats = useMemo(() => {
    if (!rows.length) return null
    return rows.map(r => r.mean_egc)
  }, [rows])

  return (
    <div style={{ padding: '20px 24px 24px' }}>
      <div style={{ marginBottom: 14 }}><h2>Dataset Overview</h2></div>

      <div style={{
        display:    'flex',
        gap:        10,
        flexWrap:   'wrap',
        alignItems: 'center',
        marginBottom: 16,
      }}>
        <select
          className="field"
          style={{ width: 140 }}
          value={source}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) => setSource(e.target.value)}
        >
          {(['kegg', 'cog', 'enzyme', 'taxonomy'] as const).map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <DateRangePicker
          from={dateFrom} to={dateTo}
          onFrom={setDateFrom} onTo={setDateTo}
          onClear={() => { setDateFrom(''); setDateTo('') }}
          minDate={dataDateRange?.min}
          maxDate={dataDateRange?.max}
        />
        <button
          className="btn primary"
          onClick={load}
          disabled={status === 'loading'}
        >
          {status === 'loading' ? 'Loading…' : 'Load Overview'}
        </button>
        {status === 'ok' && rows.length > 0 && (
          <button
            className="btn sm"
            onClick={() => downloadCsv(
              rows.map(r => ({ ...r, source })),
              `overview_${source}.csv`,
            )}
          >
            ↓ CSV
          </button>
        )}
      </div>

      {status === 'idle' && (
        <div className="state-box" style={{ padding: 32 }}>
          <div className="state-icon">🔬</div>
          <span>Select a source type and click Load Overview.</span>
        </div>
      )}
      {status === 'loading' && (
        <div className="state-box" style={{ padding: 32 }}>
          <span>Loading dataset…</span>
        </div>
      )}
      {status === 'error' && (
        <div className="state-box error" style={{ padding: 32 }}>
          <div className="state-icon">⚠</div>
          <span>Failed to load.</span>
        </div>
      )}

      {status === 'ok' && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 20 }}>
          <div style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>
              {rows.length}
            </span>{' '}
            unique {source} annotations ·{' '}
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>
              {sampleCount}
            </span>{' '}
            samples ·{' '}
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>
              {parentGroups.length}
            </span>{' '}
            functional groups
            {dateFrom || dateTo
              ? ` · ${dateFrom || '…'} → ${dateTo || '…'}`
              : ' · all dates'}
            {rows.length === 500 && (
              <span style={{ color: 'var(--amber)', marginLeft: 6 }}>
                · showing first 500 — use date filter to narrow
              </span>
            )}
          </div>

          {overviewStats && (
            <StatsPanel
              vals={overviewStats}
              yLabel={`Mean EGC distribution · ${source}`}
            />
          )}

          <div>
            <div style={{
              font:            '600 11px var(--mono)',
              color:           'var(--text-dim)',
              textTransform:   'uppercase',
              letterSpacing:   '.14em',
              marginBottom:    12,
              display:         'flex',
              alignItems:      'center',
              justifyContent:  'space-between',
            }}>
              <span>Top Functional Groups by Σ Mean EGC</span>
              {seriesStatus === 'idle' && (
                <button className="btn sm" onClick={loadTemporalChart}>
                  Load time series →
                </button>
              )}
              {seriesStatus === 'loading' && (
                <span style={{ fontWeight: 400, color: 'var(--text-dim)' }}>
                  Loading time series…
                </span>
              )}
              {seriesStatus === 'ok' && seriesFailed.length > 0 && (
                <button className="btn sm" onClick={loadTemporalChart}>
                  ⚠ Retry time series
                </button>
              )}
            </div>

            <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginBottom: 16 }}>
              {parentGroups.slice(0, 10).map((group, i) => {
                const maxSum = parentGroups[0]?.sumEgc ?? 1
                const color  = CHART_GROUP_COLORS[i] ?? 'var(--text-dim)'
                return (
                  <div key={group.parent} style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                    <span style={{
                      font:      '400 10px var(--mono)',
                      color:     'var(--text-dim)',
                      width:     18,
                      textAlign: 'right',
                      flexShrink: 0,
                    }}>
                      {i + 1}
                    </span>
                    <span
                      style={{
                        font:         '500 12px var(--mono)',
                        color:        i < 5 ? color : 'var(--text-dim)',
                        width:        240,
                        flexShrink:   0,
                        overflow:     'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace:   'nowrap',
                      }}
                      title={group.label}
                    >
                      {group.label}
                    </span>
                    <div style={{
                      flex:       1,
                      height:     8,
                      background: 'var(--surface3)',
                      borderRadius: 2,
                      overflow:   'hidden',
                    }}>
                      <div style={{
                        height:       '100%',
                        borderRadius: 2,
                        width:        `${(group.sumEgc / maxSum) * 100}%`,
                        background:   i < 5 ? color : 'var(--text-dim)',
                        opacity:      i < 5 ? 1 : 0.4,
                      }} />
                    </div>
                    <span style={{
                      font:      '400 11px var(--mono)',
                      color:     'var(--text-dim)',
                      width:     88,
                      textAlign: 'right',
                      flexShrink: 0,
                    }}>
                      {group.sumEgc.toExponential(2)}
                    </span>
                    <span style={{
                      font:      '400 10px var(--mono)',
                      color:     'var(--text-dim)',
                      width:     60,
                      textAlign: 'right',
                      flexShrink: 0,
                    }}>
                      {group.count} ann
                    </span>
                  </div>
                )
              })}
            </div>

            {seriesStatus === 'ok' && seriesFailed.length > 0 && (
              <div
                className="state-box error"
                style={{ padding: '10px 16px', flexDirection: 'row', gap: 10, textAlign: 'left', marginBottom: 12 }}
                data-testid="overview-series-failure-warning"
              >
                <span style={{ flex: 1 }}>
                  {seriesFailed.length} annotation{seriesFailed.length !== 1 ? 's' : ''} failed
                  to load their time series ({seriesFailed.join(', ')}) — excluded from the
                  chart below.
                </span>
              </div>
            )}

            {seriesStatus === 'ok' && temporalSeries.length > 0 && (
              <div>
                <div style={{
                  font:          '600 11px var(--mono)',
                  color:         'var(--text-dim)',
                  textTransform: 'uppercase',
                  letterSpacing: '.14em',
                  marginBottom:  10,
                }}>
                  Summed EGC over time — top 5 functional groups
                </div>
                <ChartErrorBoundary label="Explore temporal chart">
                  <MultiEgcChart
                    series={temporalSeries}
                    dateFrom={dateFrom}
                    dateTo={dateTo}
                    dataDateRange={dataDateRange}
                  />
                </ChartErrorBoundary>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  )
}

// ── AnnotationsByParentPanel ───────────────────────────────────────────────

function AnnotationsByParentPanel({
  source,
  dataDateRange,
  onGoScaffoldExplore,
}: {
  source:               string
  dataDateRange?:       { min: string; max: string } | null
  onGoScaffoldExplore?: (annotationId: string, source: string) => void
}) {
  const [allRows, setAllRows]                 = useState<TopAnnotation[]>([])
  const [status, setStatus]                   = useState<ApiStatus>('idle')
  const [expandedParents, setExpandedParents] = useState<Set<string>>(new Set())
  const [showSummed, setShowSummed]           = useState(false)
  const [groupSeriesData, setGroupSeriesData] = useState<Record<string, {
    data:   Record<string, AnnotationItem[]>
    failed: string[]  // annotation_ids whose series fetch failed — kept
                       // separate from `data` so a failure never gets
                       // silently mistaken for genuinely-empty data.
    status: ApiStatus
  }>>({})
  const { copiedId, copy } = useCopyId()

  function loadTop() {
    setStatus('loading')
    setAllRows([])
    setExpandedParents(new Set())
    setGroupSeriesData({})
    apiFetch<{ data: TopAnnotation[] }>(
      `/api/annotations/top?source=${source}&limit=200`,
    )
      .then(r => { setAllRows(r.data ?? []); setStatus('ok') })
      .catch(() => setStatus('error'))
  }

  useEffect(loadTop, [source])

  const parentGroups = useMemo(() => {
    const map = new Map<string, TopAnnotation[]>()
    for (const r of allRows) {
      const key = r.parent ?? 'Ungrouped'
      if (!map.has(key)) map.set(key, [])
      map.get(key)!.push(r)
    }
    return Array.from(map.entries())
      .map(([parent, items]) => ({
        parent,
        label:  expandParentLabel(parent, source),
        items:  items.sort((a, b) => b.mean_egc - a.mean_egc),
        sumEgc: items.reduce((s, i) => s + i.mean_egc, 0),
        count:  items.length,
      }))
      .sort((a, b) => b.sumEgc - a.sumEgc)
  }, [allRows, source])

  function toggleParent(p: string) {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p); else next.add(p)
      return next
    })
  }

  async function loadGroupSeries(parent: string, items: TopAnnotation[], force = false) {
    if (!force && groupSeriesData[parent]) return
    setGroupSeriesData(prev => ({ ...prev, [parent]: { data: {}, failed: [], status: 'loading' } }))
    const results = await Promise.all(
      items.slice(0, 20).map(ann =>
        apiFetch<{ data: AnnotationItem[] }>(
          `/api/series/annotations?source=${source}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=5000`,
        )
          .then(r => ({ id: ann.annotation_id, data: r.data ?? [], failed: false }))
          .catch(() => ({ id: ann.annotation_id, data: [] as AnnotationItem[], failed: true })),
      ),
    )
    const map: Record<string, AnnotationItem[]> = {}
    const failed: string[] = []
    for (const { id, data, failed: f } of results) {
      map[id] = data
      if (f) failed.push(id)
    }
    setGroupSeriesData(prev => ({ ...prev, [parent]: { data: map, failed, status: 'ok' } }))
  }

  if (status === 'loading') return (
    <div className="state-box" style={{ padding: 32 }}>
      <span>Loading annotations…</span>
    </div>
  )
  if (status === 'error') return (
    <div className="state-box error" style={{ padding: 32 }}>
      <span>Failed to load.</span>
      <button className="btn sm" data-testid="parent-panel-retry-btn" onClick={loadTop}>
        Retry
      </button>
    </div>
  )
  if (status === 'ok' && parentGroups.length === 0) return (
    <div className="state-box" style={{ padding: 32 }}>
      <span>No parent groupings found for {source}.</span>
    </div>
  )

  // Shown inline above the toggle row when results were clipped
  const truncationNote = allRows.length === 500 ? (
    <div style={{
      font: '11px var(--mono)', color: 'var(--amber)',
      marginBottom: 10,
    }}>
      Showing first 500 annotations — use date filter in Dataset Overview to narrow.
    </div>
  ) : null

  const maxSum = parentGroups[0]?.sumEgc ?? 1

  return (
    <div>
      {truncationNote}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ font: '400 11px var(--mono)', color: 'var(--text-dim)' }}>
          View:
        </span>
        <HelpTooltip text="Individual shows each annotation's own trend. Summed by parent adds up all annotations under the same parent category into one line." />
        <button
          className={`toggle-pill ${!showSummed ? 'on' : ''}`}
          onClick={() => setShowSummed(false)}
          title="Show each annotation as its own time series — expand a parent group to see individual lines and compare trends"
        >
          Individual annotations
        </button>
        <button
          className={`toggle-pill ${showSummed ? 'on' : ''}`}
          onClick={() => setShowSummed(true)}
          title="Collapse each parent group into one row showing the sum of all member mean EGCs — useful for ranking which functional categories dominate the dataset. No time series is shown here because this is a static aggregate across all timepoints."
        >
          ∑ Summed by parent
        </button>
      </div>

      {/* ── Summed view ── */}
      {showSummed && (
        <table className="ann-table">
          <thead>
            <tr>
              <th style={{ width: 32 }}>#</th>
              <th>Parent / Category</th>
              <th>Annotations</th>
              <th>Σ Mean EGC</th>
              <th>Relative</th>
            </tr>
          </thead>
          <tbody>
            {parentGroups.map((g, i) => (
              <tr key={g.parent}>
                <td style={{ font: '400 12px var(--mono)', color: 'var(--text-dim)' }}>
                  {i + 1}
                </td>
                <td className="name-cell" style={{ fontWeight: 600 }}>{g.label}</td>
                <td style={{ font: '400 12px var(--mono)', color: 'var(--text-dim)' }}>
                  {g.count}
                </td>
                <td style={{ font: '500 12px var(--mono)', color: 'var(--teal)' }}>
                  {g.sumEgc.toExponential(2)}
                </td>
                <td style={{ minWidth: 100 }}>
                  <div style={{
                    height:       6,
                    borderRadius: 3,
                    background:   `linear-gradient(90deg, var(--teal) ${(g.sumEgc / maxSum) * 100}%, var(--surface2) 0%)`,
                    minWidth:     4,
                  }} />
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {/* ── Individual view ── */}
      {!showSummed && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {parentGroups.map(group => {
            const isOpen    = expandedParents.has(group.parent)
            const gs        = groupSeriesData[group.parent]
            const chartSeries = isOpen && gs?.status === 'ok'
              ? group.items.slice(0, 20).map(ann => ({
                  annotationId: ann.annotation_id,
                  name:         ann.name,
                  data:         gs.data[ann.annotation_id] ?? [],
                  color:        SOURCE_COLORS[source] ?? 'var(--chart-1)',
                })).filter(s => s.data.length > 0)
              : []

            return (
              <div key={group.parent} className="parent-group">
                <button
                  className={`mappings-toggle ${isOpen ? 'open' : ''}`}
                  onClick={() => {
                    toggleParent(group.parent)
                    if (!isOpen) loadGroupSeries(group.parent, group.items)
                  }}
                  style={{
                    padding:      '12px 16px',
                    background:   'var(--surface2)',
                    borderRadius: isOpen ? '8px 8px 0 0' : 8,
                  }}
                >
                  <span className="toggle-icon">▶</span>
                  <span
                    className="toggle-label"
                    style={{ fontWeight: 600, color: 'var(--text-h)' }}
                  >
                    {group.label}
                  </span>
                  <span className="toggle-count">
                    {group.count} annotations · Σ {group.sumEgc.toExponential(2)}
                  </span>
                </button>

                {isOpen && (
                  <div
                    className="expand-anim"
                    style={{ borderTop: '1px solid var(--border)', padding: '16px 20px' }}
                  >
                    {gs?.status === 'loading' && (
                      <div className="state-box" style={{ padding: 20 }}>
                        <span>Loading time series for {group.count} annotations…</span>
                      </div>
                    )}
                    {gs?.status === 'ok' && gs.failed.length > 0 && (
                      <div
                        className="state-box error"
                        style={{ padding: '10px 16px', flexDirection: 'row', gap: 10, textAlign: 'left', marginBottom: 12 }}
                        data-testid="parent-group-failure-warning"
                      >
                        <span style={{ flex: 1 }}>
                          {gs.failed.length} of {Math.min(group.items.length, 20)} annotation
                          {gs.failed.length !== 1 ? 's' : ''} failed to load
                          ({gs.failed.join(', ')}) — excluded from the chart below.
                        </span>
                        <button
                          className="btn sm"
                          data-testid="parent-group-retry-btn"
                          onClick={() => loadGroupSeries(group.parent, group.items, true)}
                        >
                          Retry
                        </button>
                      </div>
                    )}
                    {gs?.status === 'ok' && chartSeries.length > 0 && (
                      <div style={{ marginBottom: 16 }}>
                        <GroupedEgcChart
                          allSeries={chartSeries}
                          groupLabel={group.label}
                          dataDateRange={dataDateRange}
                        />
                      </div>
                    )}

                    <table className="ann-table" style={{ borderRadius: 6 }}>
                      <thead>
                        <tr>
                          <th>Annotation ID</th>
                          <th>Name</th>
                          <th>Mean EGC</th>
                          <th>Samples</th>
                          <th title="Δ EGC (raw): last-quarter mean minus first-quarter mean">
                            Trend Δ EGC
                          </th>
                          <th>Scaffolds</th>
                        </tr>
                      </thead>
                      <tbody>
                        {group.items.map(row => {
                          const seriesVals = (gs?.data?.[row.annotation_id] ?? [])
                            .map(d => extractEgc(d.value))
                            .filter((v): v is number => v !== null)
                          const trend = computeTrend(seriesVals)
                          return (
                            <tr key={row.annotation_id}>
                              <td className="id-cell">
                                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                  <CopyBtn
                                    id={row.annotation_id}
                                    copiedId={copiedId}
                                    onCopy={copy}
                                  />
                                  {row.annotation_id}
                                </div>
                              </td>
                              <td className="name-cell">{row.name ?? '—'}</td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                                {row.mean_egc.toExponential(2)}
                              </td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                                {row.sample_count}
                              </td>
                              <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                                {trend === null ? (
                                  <span style={{ color: 'var(--text-dim)' }}>—</span>
                                ) : trend > 0 ? (
                                  <span
                                    style={{ color: 'var(--teal)' }}
                                    title={`+${trend.toExponential(2)} EGC (raw)`}
                                  >
                                    ↑ {trend.toExponential(2)}
                                  </span>
                                ) : (
                                  <span
                                    style={{ color: 'var(--coral)' }}
                                    title={`${trend.toExponential(2)} EGC (raw)`}
                                  >
                                    ↓ {Math.abs(trend).toExponential(2)}
                                  </span>
                                )}
                              </td>
                              <td>
                                <ScaffoldBtn
                                  annotationId={row.annotation_id}
                                  source={source}
                                  onGoExplore={onGoScaffoldExplore}
                                />
                              </td>
                            </tr>
                          )
                        })}
                      </tbody>
                    </table>
                  </div>
                )}
              </div>
            )
          })}
        </div>
      )}
    </div>
  )
}

// ── ExplorePage ────────────────────────────────────────────────────────────

export function ExplorePage({
  state,
  setState,
  resetKey,
  dataDateRange,
  indexReady,
  onSendToAnalyze,
  onGoScaffoldExplore,
}: {
  state:               ExploreState
  setState:            (updater: (prev: ExploreState) => ExploreState) => void
  resetKey:            number
  dataDateRange:       { min: string; max: string } | null
  indexReady:          boolean
  onSendToAnalyze:     (annotationId: string) => void
  onGoScaffoldExplore: (annotationId: string, source: string) => void
}) {
  const { copiedId, copy } = useCopyId()

  async function load() {
    setState(prev => ({ ...prev, status: 'loading' }))
    try {
      let url = `/api/annotations/top?source=${state.source}&limit=${state.limit}`
      if (state.dateFrom) url += `&date_from=${state.dateFrom}`
      if (state.dateTo)   url += `&date_to=${state.dateTo}`
      const r = await apiFetch<{ data: TopAnnotation[]; sample_count: number }>(url)
      setState(prev => ({
        ...prev,
        rows:        r.data ?? [],
        sampleCount: r.sample_count,
        status:      'ok',
      }))
    } catch {
      setState(prev => ({ ...prev, status: 'error' }))
    }
  }

  function toggleSort(col: ExploreSortCol) {
    setState(prev => ({
      ...prev,
      sortCol: col,
      sortDir: prev.sortCol === col
        ? (prev.sortDir === 'asc' ? 'desc' : 'asc')
        : 'desc',
    }))
  }

  // A failed request and a genuinely empty result must stay distinguishable
  // (status 'error' vs. 'ok' with an empty lookupResults) — otherwise a
  // timeout looks identical to "this annotation doesn't exist."
  async function runLookupSearch() {
    const term = state.lookupId.trim()
    if (!term) return
    setState(prev => ({ ...prev, lookupStatus: 'loading', lookupSelected: null }))
    try {
      const url = `/api/search/annotations?q=${encodeURIComponent(term)}&sources=${state.lookupSource}&page_size=25`
      const r   = await apiFetch<{ data: TopAnnotation[]; total: number }>(url)
      const results = r.data ?? []
      setState(prev => ({
        ...prev,
        lookupResults:  results,
        lookupSelected: results.length === 1 ? results[0] : null,
        lookupTotal:    r.total ?? results.length,
        lookupStatus:   'ok',
      }))
    } catch {
      setState(prev => ({ ...prev, lookupStatus: 'error' }))
    }
  }

  const sorted = useMemo(() => {
    const q = state.topFilter.toLowerCase().trim()
    return [...state.rows]
      .filter(r => !q
        || r.annotation_id.toLowerCase().includes(q)
        || (r.name   ?? '').toLowerCase().includes(q)
        || (r.parent ?? '').toLowerCase().includes(q),
      )
      .sort((a, b) => {
        const av = a[state.sortCol] as number | string
        const bv = b[state.sortCol] as number | string
        if (typeof av === 'number' && typeof bv === 'number') {
          return state.sortDir === 'asc' ? av - bv : bv - av
        }
        return state.sortDir === 'asc'
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av))
      })
  }, [state.rows, state.sortCol, state.sortDir, state.topFilter])

  const maxMean = Math.max(...state.rows.map(r => r.mean_egc), 1)

  function toggleSection(s: ExploreSection) {
    setState(prev => ({ ...prev, openSection: prev.openSection === s ? null : s }))
  }

  const SortTh = ({ col, label }: { col: ExploreSortCol; label: string }) => (
    <ExploreSortTh
      col={col} label={label}
      sortCol={state.sortCol} sortDir={state.sortDir}
      onSort={toggleSort}
    />
  )

  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Explore Annotations</h1>
          <p className="subtitle">
            Dataset overview · top annotations by abundance · parent groupings
          </p>
        </div>
      </div>

      <div className="page-body">

        {/* ── Section cards ── */}
        <div className="explore-section-cards">
          {([
            {
              id:   'overview' as ExploreSection,
              icon: '📈',
              label: 'Dataset Overview',
              desc:  'Functional group breakdown with bar chart, stats, and temporal trends for top parent categories',
            },
            {
              id:   'top-egc' as ExploreSection,
              icon: '📊',
              label: 'Top EGC Annotations',
              desc:  'Sortable table of highest mean-abundance annotations — filter by source, date range, or keyword',
            },
            {
              id:   'by-parent' as ExploreSection,
              icon: '🌿',
              label: 'Annotations by Parent',
              desc:  'Browse grouped by parent category or pathway, with sum toggle',
            },
            {
              id:   'lookup' as ExploreSection,
              icon: '🔎',
              label: 'Annotation Lookup',
              desc:  'Full metadata and external database links for any annotation ID',
            },
            {
              id:   'scaffolds' as ExploreSection,
              icon: '🧬',
              label: 'Scaffold Information',
              desc:  'Scaffold and gene counts over time, per annotation term',
            },
          ] as const).map(card => (
            <button
              key={card.id}
              className={`explore-card ${state.openSection === card.id ? 'active' : ''}`}
              onClick={() => toggleSection(card.id)}
            >
              <div className="explore-card-icon">{card.icon}</div>
              <div>
                <div className="explore-card-label">{card.label}</div>
                <div className="explore-card-desc">{card.desc}</div>
              </div>
            </button>
          ))}
        </div>

        {/* ── Dataset Overview ── */}
        {state.openSection === 'overview' && (
          <div className="explore-panel expand-anim">
            <DatasetOverviewPanel
              resetKey={resetKey}
              dataDateRange={dataDateRange}
            />
          </div>
        )}

        {/* ── Top EGC Annotations ── */}
        {state.openSection === 'top-egc' && (
          <div className="explore-panel expand-anim">
            <div style={{ padding: '20px 24px 0' }}>
              <div style={{ marginBottom: 12 }}><h2>Top EGC Annotations</h2></div>
              <div style={{
                display:    'flex',
                gap:        10,
                flexWrap:   'wrap',
                alignItems: 'center',
                marginBottom: 10,
              }}>
                <select
                  className="field"
                  style={{ width: 140 }}
                  value={state.source}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setState(prev => ({ ...prev, source: e.target.value }))
                  }
                >
                  {['kegg', 'cog', 'enzyme', 'taxonomy'].map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                  <label style={{
                    fontSize:   13,
                    fontFamily: 'var(--mono)',
                    color:      'var(--text-dim)',
                  }}>
                    Top N:
                  </label>
                  <input
                    className="field"
                    type="number"
                    min={5}
                    max={200}
                    value={state.limit}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setState(prev => ({
                        ...prev,
                        limit: Math.max(5, Math.min(200, Number(e.target.value))),
                      }))
                    }
                    style={{ width: 80 }}
                  />
                </div>
                <DateRangePicker
                  from={state.dateFrom}
                  to={state.dateTo}
                  onFrom={v => setState(prev => ({ ...prev, dateFrom: v }))}
                  onTo={v => setState(prev => ({ ...prev, dateTo: v }))}
                  onClear={() => setState(prev => ({ ...prev, dateFrom: '', dateTo: '' }))}
                  minDate={dataDateRange?.min}
                  maxDate={dataDateRange?.max}
                />
                <button
                  className="btn primary"
                  onClick={load}
                  disabled={state.status === 'loading'}
                >
                  {state.status === 'loading' ? 'Loading…' : 'Load'}
                </button>
                {state.status === 'ok' && state.rows.length > 0 && (
                  <button
                    className="btn sm"
                    onClick={() => downloadCsv(
                      sorted.map(r => ({ ...r, source: state.source })),
                      `top_${state.source}_annotations.csv`,
                    )}
                  >
                    ↓ CSV
                  </button>
                )}
              </div>

              {state.status === 'ok' && state.sampleCount !== null && (
                <div style={{
                  marginBottom: 8,
                  fontSize:     12,
                  fontFamily:   'var(--mono)',
                  color:        'var(--text-dim)',
                }}>
                  Based on {state.sampleCount} sample
                  {state.sampleCount !== 1 ? 's' : ''}
                  {state.dateFrom || state.dateTo
                    ? ` · ${state.dateFrom || '…'} → ${state.dateTo || '…'}`
                    : ' (all dates)'}
                </div>
              )}

              {state.status === 'ok' && state.rows.length > 0 && (
                <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 12 }}>
                  <input
                    className="field"
                    placeholder="Filter by ID, name, or parent group…"
                    value={state.topFilter}
                    onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                      setState(prev => ({ ...prev, topFilter: e.target.value }))
                    }
                    style={{ flex: 1, maxWidth: 360 }}
                  />
                  {state.topFilter && (
                    <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                      {sorted.length} of {state.rows.length}
                    </span>
                  )}
                  {state.topFilter && (
                    <button
                      className="btn ghost sm"
                      onClick={() => setState(prev => ({ ...prev, topFilter: '' }))}
                    >
                      ✕
                    </button>
                  )}
                </div>
              )}
            </div>

            {state.status === 'idle' && (
              <div className="state-box" style={{ padding: 32 }}>
                <div className="state-icon">📊</div>
                <span>Choose a source type and click Load to view top annotations.</span>
              </div>
            )}
            {state.status === 'loading' && (
              <div className="state-box" style={{ padding: 32 }}>
                <span>Computing top annotations…</span>
              </div>
            )}
            {state.status === 'error' && (
              <div className="state-box error" style={{ padding: 32 }}>
                <div className="state-icon">⚠</div>
                <span>Failed to load — is the API running?</span>
              </div>
            )}

            {state.status === 'ok' && sorted.length > 0 && (
              <div style={{ padding: '0 0 20px' }}>
                <table className="ann-table" style={{
                  borderRadius: 0,
                  border:       'none',
                  borderTop:    '1px solid var(--border)',
                }}>
                  <thead>
                    <tr>
                      <th style={{ width: 32 }}>#</th>
                      <th>Annotation ID</th>
                      <th>Name</th>
                      <th>Group</th>
                      <SortTh col="mean_egc"     label="Mean EGC"  />
                      <SortTh col="sample_count" label="Samples"   />
                      <th>Scaffolds</th>
                      <th>Relative</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((row, i) => (
                      <tr key={row.annotation_id}>
                        <td style={{
                          color:      'var(--text-dim)',
                          fontFamily: 'var(--mono)',
                          fontSize:   12,
                        }}>
                          {i + 1}
                        </td>
                        <td className="id-cell">
                          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                            <CopyBtn
                              id={row.annotation_id}
                              copiedId={copiedId}
                              onCopy={copy}
                            />
                            {row.annotation_id}
                          </div>
                        </td>
                        <td className="name-cell">{row.name ?? '—'}</td>
                        <td style={{
                          fontFamily:   'var(--mono)',
                          fontSize:     11,
                          color:        'var(--text-dim)',
                          maxWidth:     180,
                          overflow:     'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace:   'nowrap',
                        }}
                          title={
                            row.parent
                              ? expandParentLabel(row.parent, state.source)
                              : undefined
                          }
                        >
                          {row.parent
                            ? expandParentLabel(row.parent, state.source)
                            : '—'}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                          {row.mean_egc.toExponential(2)}
                        </td>
                        <td style={{ fontFamily: 'var(--mono)', fontSize: 13 }}>
                          {row.sample_count}
                        </td>
                        <td>
                          <ScaffoldBtn
                            annotationId={row.annotation_id}
                            source={state.source}
                            onGoExplore={onGoScaffoldExplore}
                          />
                        </td>
                        <td style={{ minWidth: 80 }}>
                          <div style={{
                            height:       6,
                            borderRadius: 3,
                            background:   `linear-gradient(90deg, var(--teal) ${(row.mean_egc / maxMean) * 100}%, var(--surface2) 0%)`,
                            minWidth:     4,
                          }} />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Annotations by Parent ── */}
        {state.openSection === 'by-parent' && (
          <div className="explore-panel expand-anim">
            <div style={{ padding: '20px 24px 16px', display: 'flex', gap: 12, alignItems: 'center' }}>
              <h2>Annotations by Parent</h2>
              <select
                className="field"
                style={{ width: 140 }}
                value={state.parentSource}
                onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                  setState(prev => ({ ...prev, parentSource: e.target.value }))
                }
              >
                {['kegg', 'cog', 'enzyme', 'taxonomy'].map(s => (
                  <option key={s} value={s}>{s}</option>
                ))}
              </select>
            </div>
            <div style={{ padding: '0 24px 24px' }}>
              <AnnotationsByParentPanel
                source={state.parentSource}
                dataDateRange={dataDateRange}
                onGoScaffoldExplore={onGoScaffoldExplore}
              />
            </div>
          </div>
        )}

        {/* ── Annotation Lookup ── */}
        {state.openSection === 'lookup' && (
          <div className="explore-panel expand-anim">
            <div style={{ padding: '20px 24px 24px' }}>
              <div style={{ marginBottom: 4 }}><h2>Annotation Lookup</h2></div>
              <p style={{
                font:         '12px var(--sans)',
                color:        'var(--text-dim)',
                marginBottom: 16,
              }}>
                Search by ID, name, or keyword — exact IDs return one result;
                general terms return a ranked list.
              </p>

              <div style={{
                display:    'flex',
                gap:        10,
                alignItems: 'center',
                flexWrap:   'wrap',
                marginBottom: 20,
              }}>
                <select
                  className="field"
                  style={{ width: 130 }}
                  value={state.lookupSource}
                  onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
                    setState(prev => ({
                      ...prev,
                      lookupSource:   e.target.value,
                      lookupResults:  [],
                      lookupSelected: null,
                      lookupTotal:    0,
                      lookupStatus:   'idle',
                    }))
                  }
                >
                  {(['kegg', 'cog', 'enzyme', 'taxonomy'] as const).map(s => (
                    <option key={s} value={s}>{s}</option>
                  ))}
                </select>
                <input
                  className="field"
                  placeholder="ID (K02014) or keyword (iron transport, siderophore…)"
                  value={state.lookupId}
                  style={{ flex: 1, minWidth: 220, maxWidth: 420 }}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) =>
                    setState(prev => ({
                      ...prev,
                      lookupId:       e.target.value,
                      lookupResults:  [],
                      lookupSelected: null,
                      lookupTotal:    0,
                      lookupStatus:   'idle',
                    }))
                  }
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') {
                      (e.currentTarget.nextElementSibling as HTMLButtonElement)?.click()
                    }
                  }}
                />
                <button
                  className="btn primary"
                  disabled={!state.lookupId.trim() || state.lookupStatus === 'loading'}
                  onClick={runLookupSearch}
                >
                  {state.lookupStatus === 'loading' ? 'Searching…' : 'Search'}
                </button>
              </div>

              {state.lookupStatus === 'idle' && (
                <div className="state-box" style={{ padding: 28 }}>
                  <div className="state-icon">🔎</div>
                  <span>Enter an ID or keyword and press Search or Enter.</span>
                </div>
              )}

              {state.lookupStatus === 'error' && (
                <div className="state-box error" style={{ padding: 20 }}>
                  <div className="state-icon">⚠</div>
                  <span>
                    Search failed — the request may have timed out.
                  </span>
                  <button className="btn sm" data-testid="lookup-retry-btn" onClick={runLookupSearch}>
                    Retry
                  </button>
                </div>
              )}

              {state.lookupStatus === 'ok' && state.lookupResults.length === 0 && (
                <div className="state-box" style={{ padding: 20 }}>
                  <div className="state-icon">∅</div>
                  <span>
                    No results for <strong>{state.lookupId}</strong> in{' '}
                    {state.lookupSource}.
                    {!indexReady && (
                      <span style={{
                        display: 'block', marginTop: 6,
                        color: 'var(--amber)', fontSize: 12,
                        fontFamily: 'var(--mono)',
                      }}>
                        ⚠ Search index is still building — try again in a few seconds.
                      </span>
                    )}
                  </span>
                </div>
              )}

              {state.lookupStatus === 'ok' && state.lookupResults.length > 0 && (
                <div style={{ display: 'flex', gap: 16, alignItems: 'flex-start' }}>
                  {/* Result list */}
                  <div style={{ flex: '0 0 300px', minWidth: 0 }}>
                    <div style={{
                      font:          '10px var(--mono)',
                      color:         'var(--text-dim)',
                      letterSpacing: '.06em',
                      textTransform: 'uppercase',
                      padding:       '0 2px 8px',
                    }}>
                      {state.lookupTotal} result
                      {state.lookupTotal !== 1 ? 's' : ''}
                      {state.lookupTotal > state.lookupResults.length &&
                        ` · showing ${state.lookupResults.length}`}
                      {' · click to view details'}
                    </div>
                    <div style={{
                      border:       '1px solid var(--border)',
                      borderRadius: 7,
                      overflow:     'hidden',
                      maxHeight:    480,
                      overflowY:    'auto',
                    }}>
                      {state.lookupResults.map(row => {
                        const isSelected =
                          state.lookupSelected?.annotation_id === row.annotation_id
                        return (
                          <div
                            key={row.annotation_id}
                            onClick={() =>
                              setState(prev => ({ ...prev, lookupSelected: row }))
                            }
                            style={{
                              padding:      '9px 12px',
                              borderBottom: '1px solid var(--border)',
                              cursor:       'pointer',
                              background:   isSelected
                                ? 'rgba(61,217,184,.08)'
                                : 'var(--surface)',
                              borderLeft:   isSelected
                                ? '3px solid var(--teal)'
                                : '3px solid transparent',
                              transition:   'background .1s',
                            }}
                          >
                            <div style={{
                              display:      'flex',
                              alignItems:   'center',
                              gap:          6,
                              marginBottom: 2,
                            }}>
                              <span style={{
                                font:  '600 12px var(--mono)',
                                color: 'var(--teal)',
                              }}>
                                {row.annotation_id}
                              </span>
                              <span style={{
                                font:  '400 10px var(--mono)',
                                color: 'var(--text-dim)',
                              }}>
                                {row.mean_egc.toExponential(2)}
                              </span>
                            </div>
                            {row.name && (
                              <div style={{
                                font:         '12px var(--sans)',
                                color:        'var(--text-dim)',
                                whiteSpace:   'nowrap',
                                overflow:     'hidden',
                                textOverflow: 'ellipsis',
                              }}>
                                {row.name}
                              </div>
                            )}
                          </div>
                        )
                      })}
                    </div>
                  </div>

                  {/* Detail card */}
                  <div style={{ flex: 1, minWidth: 0 }}>
                    {state.lookupSelected ? (() => {
                      const r      = state.lookupSelected
                      const v      = r.value as AnnotationValue | null | undefined
                      const parent = r.parent
                        ? expandParentLabel(r.parent, state.lookupSource)
                        : null
                      const category = v?.category
                        ? expandParentLabel(v.category, state.lookupSource)
                        : null
                      const scaffoldCount = v?.scaffolds
                        ? Object.keys(v.scaffolds).length
                        : null

                      const depthLabel = (depth: number) => {
                        if (state.lookupSource === 'kegg')    return { 1: 'pathway class', 2: 'subcategory', 3: 'pathway', 4: 'leaf (KO)' }[depth] ?? String(depth)
                        if (state.lookupSource === 'cog')     return { 1: 'category', 2: 'leaf (COG)' }[depth] ?? String(depth)
                        if (state.lookupSource === 'enzyme')  return { 1: 'class', 2: 'subclass', 3: 'sub-subclass', 4: 'leaf (EC)' }[depth] ?? String(depth)
                        return String(depth)
                      }

                      return (
                        <div className="lookup-result">
                          <div className="lookup-header">
                            <span className={`tag ${SOURCE_TAG_CLS[state.lookupSource] ?? ''}`}>
                              {state.lookupSource}
                            </span>
                            <span className="lookup-id">{r.annotation_id}</span>
                            {r.name && (
                              <span className="lookup-name">{r.name}</span>
                            )}
                          </div>
                          <div className="lookup-meta-grid">
                            {category && (
                              <div className="lookup-meta-row">
                                <span className="lookup-meta-label">Category</span>
                                <span className="lookup-meta-value">{category}</span>
                              </div>
                            )}
                            {parent && (
                              <div className="lookup-meta-row">
                                <span className="lookup-meta-label">Parent</span>
                                <span className="lookup-meta-value">{parent}</span>
                              </div>
                            )}
                            {v?.depth != null && (
                              <div className="lookup-meta-row">
                                <span className="lookup-meta-label">
                                  Depth
                                  <HelpTooltip text="Depth = how deep this term sits in its hierarchy (e.g. KEGG depth 3 = pathway level). Meaning depends on the annotation source." />
                                </span>
                                <span className="lookup-meta-value mono">
                                  {v.depth}
                                  <span style={{
                                    marginLeft:  6,
                                    fontFamily:  'var(--sans)',
                                    fontSize:    11,
                                    color:       'var(--text-dim)',
                                    fontWeight:  400,
                                  }}>
                                    ({depthLabel(v.depth)})
                                  </span>
                                </span>
                              </div>
                            )}
                            <div className="lookup-meta-row">
                              <span className="lookup-meta-label">Mean EGC</span>
                              <span className="lookup-meta-value mono">
                                {r.mean_egc.toExponential(3)}
                              </span>
                            </div>
                            <div className="lookup-meta-row">
                              <span className="lookup-meta-label">Max EGC</span>
                              <span className="lookup-meta-value mono">
                                {r.max_egc.toExponential(3)}
                              </span>
                            </div>
                            {r.mean_norm_egc != null && (
                              <div className="lookup-meta-row">
                                <span
                                  className="lookup-meta-label"
                                  title="Mean EGC / total sample depth — comparable across samples"
                                >
                                  Mean norm EGC
                                </span>
                                <span className="lookup-meta-value mono">
                                  {r.mean_norm_egc.toExponential(3)}
                                </span>
                              </div>
                            )}
                            {r.max_norm_egc != null && (
                              <div className="lookup-meta-row">
                                <span className="lookup-meta-label">Max norm EGC</span>
                                <span className="lookup-meta-value mono">
                                  {r.max_norm_egc.toExponential(3)}
                                </span>
                              </div>
                            )}
                            <div className="lookup-meta-row">
                              <span className="lookup-meta-label">Samples</span>
                              <span className="lookup-meta-value mono">
                                {r.sample_count} / 128
                              </span>
                            </div>
                            {scaffoldCount != null && (
                              <div className="lookup-meta-row">
                                <span
                                  className="lookup-meta-label"
                                  title="Unique scaffold IDs in the earliest sample this annotation appears in"
                                >
                                  Scaffolds (sample)
                                </span>
                                <span className="lookup-meta-value mono">
                                  {scaffoldCount}
                                </span>
                              </div>
                            )}
                          </div>
                          <div className="lookup-links-section">
                            <div className="lookup-links-label">External Databases</div>
                            <div className="lookup-links">
                              <ExternalLinks
                                annotationId={r.annotation_id}
                                source={state.lookupSource}
                              />
                            </div>
                          </div>
                          <div style={{
                            padding:    '12px 18px',
                            borderTop:  '1px solid var(--border)',
                            background: 'var(--surface2)',
                          }}>
                            <button
                              className="btn sm primary"
                              onClick={() => onSendToAnalyze(r.annotation_id)}
                              title={`Search for ${r.annotation_id} in Analyze`}
                            >
                              → View Timeseries in Analyze
                            </button>
                          </div>
                        </div>
                      )
                    })() : (
                      <div className="state-box" style={{
                        padding:      28,
                        border:       '1px dashed var(--border)',
                        borderRadius: 8,
                      }}>
                        <div className="state-icon">←</div>
                        <span style={{ fontSize: 13 }}>
                          Select a result to see full details and database links.
                        </span>
                      </div>
                    )}
                  </div>
                </div>
              )}
            </div>
          </div>
        )}

        {/* ── Scaffold Information ── */}
        {state.openSection === 'scaffolds' && (
          <div className="explore-panel expand-anim">
            <ScaffoldExplorePanel
              initialTerms={state.scaffoldInitialTerms}
              dataDateRange={dataDateRange}
            />
          </div>
        )}

      </div>
    </div>
  )
}
