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

import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react'

import type {
  ApiStatus, TopAnnotation, AnnotationItem,
  ExploreSection, ExploreSortCol, SortDir,
  HierarchyPathResponse,
} from '../types'
import { SOURCE_COLORS, SOURCE_TAG_CLS, expandParentLabel, taxonomyRankLabel, taxonomyAwarePrimaryLabel, primaryLabelWithCogCategory } from '../constants'

// Annotations with no parent -- each source's top-level categories. Shared by
// Dataset Overview and Annotations by Parent. Used to be an "Ungrouped" bucket
// that ranked #1: its total summed the categories themselves, each of which
// already includes every annotation beneath it, i.e. the very genes the other
// groups count.
const TOP_LEVEL_LABEL = 'Top-level categories'
const TOP_LEVEL_TOOLTIP =
  "Annotations with no parent: each source's top-level categories (COG category letters, " +
  "KEGG's top classes, the EC classes, taxonomic domains). Each one's EGC already includes " +
  'everything beneath it, so it overlaps every group listed above -- it is shown separately ' +
  'instead of being ranked alongside them.'

// Sources whose stored `parent` holds only one of a node's possibly several
// real parents: a KEGG KO can sit in many pathways, a COG id in several
// categories. Everywhere Explore groups rows by parent, these sources use
// the real parents from /api/{source}/parents instead.
const MULTI_PARENT_SOURCES = new Set(['kegg', 'cog'])
type RealParents = Record<string, { annotation_id: string; name: string }[]>

async function fetchRealParents(source: string, rows: TopAnnotation[]): Promise<RealParents> {
  const ids = rows.map(row => row.annotation_id).join(',')
  const r = await apiFetch<{ parents: RealParents }>(`/api/${source}/parents?ids=${encodeURIComponent(ids)}`)
  return r.parents ?? {}
}

function topLevelEntryLabel(r: TopAnnotation, source: string): string {
  if (source === 'taxonomy') return r.name ?? r.annotation_id
  const withCog = primaryLabelWithCogCategory(source, r.annotation_id, r.name)
  if (withCog !== r.annotation_id) return withCog
  return r.name ? `${r.annotation_id} · ${r.name}` : r.annotation_id
}
import { apiFetch, downloadCsv } from '../utils/api'
import {
  extractEgc, computeTrend, sumMembersByTimestamp,
  resolveLookupCategory, resolveLookupScaffoldCount, resolveLookupDepth, depthLabel,
} from '../utils/stats'
import { useCopyId } from '../hooks/useCopyId'
import { CopyBtn, ResetBtn, NumberField } from '../components/ui/controls'
import { DateRangePicker } from '../components/ui/DateRangePicker'
import { ChartErrorBoundary } from '../components/ui/ChartErrorBoundary'
import { StatsPanel } from '../components/ui/StatsPanel'
import { ExternalLinks } from '../components/ui/ExternalLinks'
import { HelpTooltip } from '../components/ui/HelpTooltip'
import { Skeleton, SkeletonTable, SkeletonStatTiles, SkeletonChart } from '../components/ui/Skeleton'
import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import { GroupedEgcChart } from '../components/charts/GroupedEgcChart'
import { ScaffoldBtn } from '../components/scaffolds/ScaffoldBtn'
import { HierarchyBtn } from '../components/hierarchy/HierarchyBtn'
import { BulkDownloadPanel } from '../components/download/BulkDownloadPanel'
import { canBulkDownloadFrom } from '../utils/bulkDownload'
import { ScaffoldExplorePanel } from '../components/scaffolds/ScaffoldExplorePanel'
import type { ExploreState } from './exploreState'

// ── ExploreState + default ─────────────────────────────────────────────────
// Co-located here — only ExplorePage uses this shape.

// ── ExploreSortTh ──────────────────────────────────────────────────────────

// Exported for direct component testing (same rationale as DatasetOverviewPanel below).
export function ExploreSortTh({
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
// Exported for direct component testing (the 40-annotation fetch cap and
// the 200-row truncation check).


// Line colors for Dataset Overview's top-5 group chart.
const CHART_GROUP_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)',
  'var(--chart-4)', 'var(--amber)',
]

export function DatasetOverviewPanel({
  resetKey,
  dataDateRange,
}: {
  resetKey:      number
  dataDateRange: { min: string; max: string } | null
}) {
  const [source, setSource]             = useState('taxonomy')
  const [dateFrom, setDateFrom]         = useState('')
  const [dateTo, setDateTo]             = useState('')
  const [rows, setRows]                 = useState<TopAnnotation[]>([])
  const [sampleCount, setSampleCount]   = useState<number | null>(null)
  const [status, setStatus]             = useState<ApiStatus>('idle')
  const [seriesData, setSeriesData]     = useState<Record<string, AnnotationItem[]>>({})
  const [seriesStatus, setSeriesStatus] = useState<ApiStatus>('idle')
  const [seriesFailed, setSeriesFailed] = useState<string[]>([])
  const [seriesTruncatedFrom, setSeriesTruncatedFrom] = useState<number | null>(null)
  const [topLevelOpen, setTopLevelOpen] = useState(false)
  // Every real parent per row for kegg/cog (see MULTI_PARENT_SOURCES); null
  // when not applicable or when the lookup failed, which falls back to each
  // row's single stored parent.
  const [realParents, setRealParents]   = useState<RealParents | null>(null)

  // `rows` is only ever correct for whatever (source, dateFrom, dateTo) was
  // actually sent with the request that produced it -- not necessarily what
  // `source`/`dateFrom`/`dateTo` hold NOW, since the user can change the
  // dropdown/date fields at any time, including while a request is still
  // in flight. Everything that displays, labels, or follow-up-fetches from
  // `rows` (CSV export, the summary line, expandParentLabel,
  // loadTemporalChart's own request) reads `loadedParams` instead -- the
  // actual parameters snapshotted at the moment `rows` was set.
  const [loadedParams, setLoadedParams] = useState<{ source: string; dateFrom: string; dateTo: string } | null>(null)
  const requestSeqRef = useRef(0)
  const chartSeqRef   = useRef(0)

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A page reset (new resetKey) clears this panel.
    setSource('taxonomy'); setDateFrom(''); setDateTo('')
    setRows([]); setSampleCount(null); setStatus('idle')
    setLoadedParams(null)
    setSeriesData({}); setSeriesStatus('idle'); setSeriesFailed([])
    setSeriesTruncatedFrom(null)
    setTopLevelOpen(false)
    setRealParents(null)
    requestSeqRef.current++ // anything still loading belongs to the old page
  }, [resetKey])

  async function load() {
    const requestId = ++requestSeqRef.current
    const params = { source, dateFrom, dateTo }
    setStatus('loading')
    setSeriesData({}); setSeriesStatus('idle'); setSeriesFailed([])
    setSeriesTruncatedFrom(null)
    setTopLevelOpen(false)
    try {
      let url = `/api/annotations/top?source=${params.source}&limit=200`
      if (params.dateFrom) url += `&date_from=${params.dateFrom}`
      if (params.dateTo)   url += `&date_to=${params.dateTo}`
      const r = await apiFetch<{ data: TopAnnotation[]; sample_count: number }>(url)
      if (requestId !== requestSeqRef.current) return // a newer load() has since started
      let parents: RealParents | null = null
      if (MULTI_PARENT_SOURCES.has(params.source) && (r.data ?? []).length > 0) {
        try {
          parents = await fetchRealParents(params.source, r.data ?? [])
        } catch {
          parents = null // group by each row's single stored parent instead
        }
        if (requestId !== requestSeqRef.current) return
      }
      setRealParents(parents)
      setRows(r.data ?? [])
      setSampleCount(r.sample_count)
      setLoadedParams(params)
      setStatus('ok')
    } catch {
      if (requestId !== requestSeqRef.current) return
      setStatus('error')
    }
  }

  // Rows with no parent are the top-level categories -- kept out of the
  // ranked groups and the chart (see TOP_LEVEL_TOOLTIP), listed separately.
  const topLevelRows = useMemo(
    () => rows.filter(r => r.parent == null).sort((a, b) => b.mean_egc - a.mean_egc),
    [rows],
  )

  const parentGroups = useMemo(() => {
    const loadedSource = loadedParams?.source ?? source
    const map = new Map<string, { label: string; items: TopAnnotation[] }>()
    const addTo = (key: string, label: string, row: TopAnnotation) => {
      if (!map.has(key)) map.set(key, { label, items: [] })
      map.get(key)!.items.push(row)
    }
    for (const r of rows) {
      if (r.parent == null) continue
      // A multi-parent KO / multi-category COG counts toward every real
      // parent it has, so group totals can overlap (same as Annotations
      // by Parent).
      const real = realParents?.[r.annotation_id]
      if (real && real.length > 0) {
        for (const p of real) addTo(p.annotation_id, p.name, r)
      } else {
        addTo(r.parent, expandParentLabel(r.parent, loadedSource), r)
      }
    }
    return Array.from(map.entries())
      .map(([parent, { label, items }]) => ({
        parent,
        label,
        sumEgc: items.reduce((s, i) => s + i.mean_egc, 0),
        count:  items.length,
        items,
      }))
      .sort((a, b) => b.sumEgc - a.sumEgc)
  }, [rows, loadedParams, realParents, source])

  const top5Groups = parentGroups.slice(0, 5)

  async function loadTemporalChart() {
    const allMembers = top5Groups.flatMap(g => g.items)
    const allAnns = allMembers.slice(0, 40)
    if (!allAnns.length) return
    // Dropped if the rows change (load() or a reset) or the chart is
    // loaded again before this finishes.
    const rowsRequestId  = requestSeqRef.current
    const chartRequestId = ++chartSeqRef.current
    // The actually-loaded source, not the live dropdown -- switching
    // the source after loading rows (but before clicking this) must not
    // silently fetch a different source's time series for rows still
    // labelled/grouped under the one that was really loaded.
    const loadedSource = loadedParams?.source ?? source
    // Silently dropping members past the 40-annotation fetch budget could
    // zero out an entire later group's summed total with no indication
    // anything was cut -- surfaced explicitly instead.
    setSeriesTruncatedFrom(allMembers.length > allAnns.length ? allMembers.length : null)
    setSeriesStatus('loading')
    const results = await Promise.all(
      allAnns.map(ann =>
        apiFetch<{ data: AnnotationItem[] }>(
          `/api/series/annotations?source=${loadedSource}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=500`,
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
    if (rowsRequestId !== requestSeqRef.current || chartRequestId !== chartSeqRef.current) return
    setSeriesData(map)
    setSeriesFailed(failed)
    setSeriesStatus('ok')
  }

  const temporalSeries = useMemo(() => {
    if (!Object.keys(seriesData).length) return []
    // seriesData was fetched under loadedSource (loadTemporalChart),
    // not necessarily whatever the dropdown shows right now -- everything
    // derived from it must agree, or a source-switch after loading would
    // silently mislabel real kegg data as e.g. cog.
    const loadedSource = loadedParams?.source ?? source
    return top5Groups.map((group, gi) => ({
      // id must be unique per series -- group.label alone isn't guaranteed
      // to be (two different parent categories can share a display name). gi is this group's fixed position in the
      // top-5 list, safe to use since MultiEgcChart only uses id for
      // internal row-keying, never display.
      id:           `group-${gi}`,
      annotationId: group.label,
      name:         group.label,
      color:        CHART_GROUP_COLORS[gi],
      source:       loadedSource,
      // Summed per timestamp across members, not raw per-member points --
      // see sumMembersByTimestamp's docstring for why.
      data: sumMembersByTimestamp(
        group.items.map(ann => ann.annotation_id),
        seriesData,
        group.label,
        loadedSource,
      ),
    }))
  }, [seriesData, top5Groups, loadedParams, source])

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
              // The source these rows were actually loaded under, not
              // whichever the dropdown currently shows.
              rows.map(r => ({ ...r, source: loadedParams?.source ?? source })),
              `overview_${loadedParams?.source ?? source}.csv`,
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
        <div>
          <span className="sr-only">Loading dataset…</span>
          <Skeleton height={12} width={280} style={{ marginBottom: 16 }} />
          <SkeletonStatTiles count={9} />
          <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 10 }}>
            {Array.from({ length: 6 }).map((_, i) => (
              <div key={i} style={{ display: 'flex', alignItems: 'center', gap: 10 }} aria-hidden="true">
                <Skeleton height={10} width={18} />
                <Skeleton height={10} width={`${70 - i * 8}%`} />
              </div>
            ))}
          </div>
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
            unique {loadedParams?.source ?? source} annotations ·{' '}
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>
              {sampleCount}
            </span>{' '}
            samples ·{' '}
            <span style={{ color: 'var(--teal)', fontWeight: 600 }}>
              {parentGroups.length}
            </span>{' '}
            functional groups
            {loadedParams && (loadedParams.dateFrom || loadedParams.dateTo)
              ? ` · ${loadedParams.dateFrom || '…'} → ${loadedParams.dateTo || '…'}`
              : ' · all dates'}
            {rows.length === 200 && (
              <span style={{ color: 'var(--amber)', marginLeft: 6 }}>
                · showing first 200 by mean EGC, the most the server returns
              </span>
            )}
          </div>

          {overviewStats && (
            <StatsPanel
              vals={overviewStats}
              yLabel={`Mean EGC distribution · ${loadedParams?.source ?? source}`}
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
              <span>
                Top Functional Groups by Σ Mean EGC
                <HelpTooltip text="Each group here is formed by an annotation's own immediate parent, with no regard for hierarchy depth -- a broad category and one of its own sub-categories can both appear as separate groups in this same list. When that happens their totals are not independent peers: the sub-category's whole total is already included inside its parent category's total, so summing group totals together (or comparing them side by side in the chart below) can overstate how much of the dataset each one really represents." />
              </span>
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

            {topLevelRows.length > 0 && (
              <div style={{ marginBottom: 16 }}>
                <div
                  data-testid="overview-top-level-row"
                  style={{ display: 'flex', alignItems: 'center', gap: 8, font: '500 12px var(--mono)', color: 'var(--text-dim)' }}
                >
                  <button
                    className="btn sm ghost"
                    aria-expanded={topLevelOpen}
                    onClick={() => setTopLevelOpen(o => !o)}
                  >
                    {topLevelOpen ? '▾' : '▸'} {TOP_LEVEL_LABEL}
                  </button>
                  <HelpTooltip text={TOP_LEVEL_TOOLTIP} />
                  <span>{topLevelRows.length} · not ranked</span>
                </div>
                {topLevelOpen && (
                  <div data-testid="overview-top-level-list" style={{ display: 'flex', flexDirection: 'column', gap: 4, padding: '6px 0 0 28px' }}>
                    {topLevelRows.map(r => (
                      <div key={r.annotation_id} style={{ display: 'flex', gap: 12, font: '400 12px var(--mono)' }}>
                        <span style={{ flex: 1, color: 'var(--text-h)' }}>{topLevelEntryLabel(r, loadedParams?.source ?? source)}</span>
                        <span style={{ color: 'var(--text-dim)' }}>{r.mean_egc.toExponential(2)}</span>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            )}

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

            {seriesStatus === 'ok' && seriesTruncatedFrom != null && (
              <div
                className="state-box error"
                style={{ padding: '10px 16px', flexDirection: 'row', gap: 10, textAlign: 'left', marginBottom: 12 }}
                data-testid="overview-series-truncated-warning"
              >
                <span style={{ flex: 1 }}>
                  The top 5 groups have {seriesTruncatedFrom} member annotations combined, but
                  only the first 40 were fetched — one or more groups' summed totals below may
                  be undercounted.
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
                  {/* Must read loadedParams, not the live dateFrom/dateTo
                      above, like every sibling render site in this section
                      (the summary line, CSV filename, yLabel) -- otherwise
                      typing a new date into the picker after loading,
                      without reloading, would narrow the chart while the
                      summary line above it still describes what was loaded. */}
                  <MultiEgcChart
                    series={temporalSeries}
                    dateFrom={loadedParams?.dateFrom ?? ''}
                    dateTo={loadedParams?.dateTo ?? ''}
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

// Exported for direct component testing (same rationale as DatasetOverviewPanel above).
export function AnnotationsByParentPanel({
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
  // `source` is a prop that can change
  // (parent dropdown) while a previous source's request is still in
  // flight -- without a sequence guard, the slower (stale) response could
  // land after the newer one and get labelled under the new `source`,
  // showing e.g. real kegg rows grouped/labelled as "cog". `loadedSource`
  // is the source that ACTUALLY produced `allRows`, used for every label
  // derived from it (expandParentLabel here); the live `source` prop is
  // only for the request itself and the dropdown's own display elsewhere.
  const [loadedSource, setLoadedSource] = useState(source)
  const requestSeqRef = useRef(0)
  // A KEGG row's stored `parent` is
  // last-occurrence-wins -- only ONE of its possibly-many real immediate
  // parents. Resolved in bulk (one request for the whole batch, not 200
  // individual lookups) via /api/kegg/parents, keyed by annotation_id.
  // Never populated for non-kegg sources, which are never multi-parent.
  const [multiParents, setMultiParents] = useState<Record<string, { annotation_id: string; name: string }[]>>({})
  // Tracks specifically whether the /kegg/parents bulk lookup itself
  // failed, as distinct from multiParents being legitimately empty (e.g. a
  // non-kegg source, or a kegg source where every row happened to resolve
  // zero real parents). Drives both the visible warning below and the
  // single-parent fallback in parentGroups.
  const [multiParentsFetchFailed, setMultiParentsFetchFailed] = useState(false)

  function loadTop() {
    const requestId = ++requestSeqRef.current
    const requestedSource = source
    setStatus('loading')
    setAllRows([])
    setMultiParents({})
    setMultiParentsFetchFailed(false)
    setExpandedParents(new Set())
    setGroupSeriesData({})
    apiFetch<{ data: TopAnnotation[] }>(
      `/api/annotations/top?source=${requestedSource}&limit=200`,
    )
      .then(async r => {
        if (requestId !== requestSeqRef.current) return // superseded by a newer source change
        const rows = r.data ?? []
        setAllRows(rows)
        setLoadedSource(requestedSource)

        if (MULTI_PARENT_SOURCES.has(requestedSource) && rows.length > 0) {
          // Stays in 'loading' until this resolves too, so the panel
          // never flashes a transient "everything in Ungrouped" grouping
          // before the real multi-parent buckets are known.
          try {
            const parents = await fetchRealParents(requestedSource, rows)
            if (requestId !== requestSeqRef.current) return
            setMultiParents(parents)
          } catch {
            if (requestId !== requestSeqRef.current) return
            setMultiParents({})
            setMultiParentsFetchFailed(true) // parentGroups below now actually falls back to single-parent grouping
          }
        }
        setStatus('ok')
      })
      .catch(() => {
        if (requestId !== requestSeqRef.current) return
        setStatus('error')
      })
  }

  // eslint-disable-next-line react-hooks/set-state-in-effect -- Changing source starts a new load, which first shows its loading state.
  useEffect(loadTop, [source])

  const parentGroups = useMemo(() => {
    const map = new Map<string, { label: string; items: TopAnnotation[] }>()
    const addTo = (key: string, label: string, row: TopAnnotation) => {
      if (!map.has(key)) map.set(key, { label, items: [] })
      map.get(key)!.items.push(row)
    }

    for (const r of allRows) {
      // The real-parents lookup returns every requested id: an empty list
      // means the row has no parent (top-level). A row missing from the
      // response entirely is unknown, so it falls through to its stored parent.
      const parents = multiParents[r.annotation_id]
      if (MULTI_PARENT_SOURCES.has(loadedSource) && !multiParentsFetchFailed && parents !== undefined) {
        if (parents.length > 0) {
          // File under EVERY real parent -- a multi-parent KO's EGC
          // counts toward each real pathway/category it belongs to, the
          // same as COG's multi-category rollup. Group totals summed
          // ACROSS groups therefore won't equal a flat dataset total.
          for (const p of parents) addTo(p.annotation_id, p.name, r)
        } else {
          // No real parent at all = a top-level category (see TOP_LEVEL_TOOLTIP)
          addTo('Ungrouped', TOP_LEVEL_LABEL, r)
        }
      } else {
        // Also the single-parent fallback for kegg when /kegg/parents
        // itself failed -- every row still carries its own
        // (last-occurrence-wins) single
        // `parent` field from /annotations/top, which is strictly better
        // than dumping everything into one undifferentiated "Ungrouped"
        // bucket.
        const key = r.parent ?? 'Ungrouped'
        addTo(key, r.parent == null ? TOP_LEVEL_LABEL : expandParentLabel(key, loadedSource), r)
      }
    }

    return Array.from(map.entries())
      .map(([parent, { label, items }]) => ({
        parent,
        label,
        items:  items.sort((a, b) => b.mean_egc - a.mean_egc),
        sumEgc: items.reduce((s, i) => s + i.mean_egc, 0),
        count:  items.length,
      }))
      // Top-level categories go last: their totals overlap every other
      // group's, so ranking them first by size would be misleading.
      .sort((a, b) =>
        Number(a.parent === 'Ungrouped') - Number(b.parent === 'Ungrouped') || b.sumEgc - a.sumEgc)
  }, [allRows, loadedSource, multiParents, multiParentsFetchFailed])

  function toggleParent(p: string) {
    setExpandedParents(prev => {
      const next = new Set(prev)
      if (next.has(p)) next.delete(p); else next.add(p)
      return next
    })
  }

  async function loadGroupSeries(parent: string, items: TopAnnotation[], force = false) {
    if (!force && groupSeriesData[parent]) return
    // Series are kept by parent name, which another source can share --
    // a fetch that outlives its rows (a source change) must not land.
    const rowsRequestId = requestSeqRef.current
    setGroupSeriesData(prev => ({ ...prev, [parent]: { data: {}, failed: [], status: 'loading' } }))
    const results = await Promise.all(
      items.slice(0, 20).map(ann =>
        // loadedSource, not the live `source` prop -- these items came
        // from allRows, which was loaded under loadedSource; fetching their
        // series under a source the user has since switched to would ask
        // for the wrong annotations entirely.
        apiFetch<{ data: AnnotationItem[] }>(
          `/api/series/annotations?source=${loadedSource}&annotation_id=${encodeURIComponent(ann.annotation_id)}&page_size=500`,
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
    if (rowsRequestId !== requestSeqRef.current) return
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
      <span>No parent groupings found for {loadedSource}.</span>
    </div>
  )

  // Shown inline above the toggle row when results were clipped.
  // Must match the fetch's own `limit=200` above, or a truncated list
  // would look complete.
  const truncationNote = allRows.length === 200 ? (
    <div style={{
      font: '11px var(--mono)', color: 'var(--amber)',
      marginBottom: 10,
    }}>
      Showing first 200 annotations by mean EGC, the most the server returns.
    </div>
  ) : null

  // Shown when /kegg/parents failed -- every row below is then grouped by
  // its own single stored
  // parent (expandParentLabel(r.parent, ...), the same as any non-kegg
  // source) rather than the real, possibly-multiple parents
  // /kegg/parents would have resolved, so a multi-parent KO only
  // appears under one of its real groups right now.
  const multiParentsWarning = MULTI_PARENT_SOURCES.has(loadedSource) && multiParentsFetchFailed ? (
    <div
      className="state-box error"
      style={{ padding: '10px 16px', flexDirection: 'row', gap: 10, textAlign: 'left', marginBottom: 12 }}
      data-testid="kegg-parents-fetch-failure-warning"
    >
      <span style={{ flex: 1 }}>
        Couldn't load full parent info for these annotations — grouping by each
        one's single stored parent instead, so one with several real parents may be
        missing from some of its groups.
      </span>
      <button className="btn sm" data-testid="kegg-parents-retry-btn" onClick={loadTop}>
        Retry
      </button>
    </div>
  ) : null

  const maxSum = parentGroups[0]?.sumEgc ?? 1

  return (
    <div>
      {multiParentsWarning}
      {truncationNote}
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 14 }}>
        <span style={{ font: '400 11px var(--mono)', color: 'var(--text-dim)' }}>
          View:
        </span>
        <HelpTooltip text="Group trend & detail shows each parent group's summed trend over time, with a table below it breaking that total down by individual annotation. Summed by parent instead shows a static ranked table of parent-group totals — no time series. For KEGG, a KO with more than one real pathway/category appears (with its full EGC) in every real group it belongs to, so group totals summed together can exceed a flat sum of every annotation." />
        <button
          className={`toggle-pill ${!showSummed ? 'on' : ''}`}
          onClick={() => setShowSummed(false)}
          title="Expand a parent group to see its summed trend over time, plus a table of each individual annotation's own stats"
        >
          Group trend & detail
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
                  color:        SOURCE_COLORS[loadedSource] ?? 'var(--chart-1)',
                })).filter(s => s.data.length > 0)
              : []

            return (
              <div key={group.parent} className="parent-group">
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
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
                {group.parent === 'Ungrouped' && <HelpTooltip text={TOP_LEVEL_TOOLTIP} />}
                </div>

                {isOpen && (
                  <div
                    className="expand-anim"
                    style={{ borderTop: '1px solid var(--border)', padding: '16px 20px' }}
                  >
                    {gs?.status === 'loading' && (
                      <div style={{ marginBottom: 16 }}>
                        <span className="sr-only">
                          Loading time series for {group.count} annotations…
                        </span>
                        <SkeletonChart height={280} />
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
                    {gs?.status === 'ok' && group.items.length > 20 && (
                      <div
                        className="state-box error"
                        style={{ padding: '10px 16px', flexDirection: 'row', gap: 10, textAlign: 'left', marginBottom: 12 }}
                        data-testid="parent-group-trend-truncated-warning"
                      >
                        <span style={{ flex: 1 }}>
                          {/* The summed trend
                              below only fetches the first 20 of this group's
                              {group.items.length} members -- disclosed here
                              instead of silently undercounting the total. */}
                          This group has {group.items.length} member annotations, but the summed
                          trend below only includes the first 20 — it may be undercounted.
                        </span>
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
                          <th>Hierarchy</th>
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
                                  source={loadedSource}
                                  name={row.name}
                                  onGoExplore={onGoScaffoldExplore}
                                />
                              </td>
                              <td>
                                <HierarchyBtn
                                  annotationId={row.annotation_id}
                                  source={loadedSource}
                                  name={row.name}
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
  onReset
}: {
  state:               ExploreState
  setState:            (updater: (prev: ExploreState) => ExploreState) => void
  resetKey:            number
  dataDateRange:       { min: string; max: string } | null
  indexReady:          boolean
  onSendToAnalyze:     (annotationId: string) => void
  onGoScaffoldExplore: (annotationId: string, source: string) => void
  onReset:             () => void
}) {
  const { copiedId, copy } = useCopyId()
  // Request-sequence guards so a slower,
  // superseded response (e.g. from a source the user has since switched
  // away from) can't land after a newer one and overwrite it.
  const topRequestSeqRef    = useRef(0)
  const lookupRequestSeqRef = useRef(0)
  // Everything that labels/links/filters the lookup card's ALREADY-
  // LOADED results reads this instead of the live `state.lookupSource` --
  // the dropdown itself is the one place that still needs the live value.
  const effectiveLookupSource = state.lookupLoadedSource ?? state.lookupSource
  // Same rationale for the Top EGC Annotations table's already-loaded
  // `state.rows` -- the source dropdown for THIS section is the one place
  // that still needs the live `state.source`.
  const effectiveTopSource = state.loadedParams?.source ?? state.source

  // The same real-multi-parent bulk lookup AnnotationsByParentPanel does
  // (/api/kegg/parents), for this table's own "Group" column -- row.parent
  // alone is the single last-occurrence-wins stored value, e.g. "Exosome"
  // (one of its rarest real categories) for K00134/GAPDH, whose 9 real
  // parents include Glycolysis.
  const [topRealParents, setTopRealParents]             = useState<Record<string, { annotation_id: string; name: string }[]>>({})
  const [topRealParentsFailed, setTopRealParentsFailed] = useState(false)

  // A KEGG KO's stored `parent` is
  // last-occurrence-wins -- only ONE of its possibly-many real immediate
  // parents (e.g. K00844/hexokinase has 14; GAPDH, pyruvate kinase and
  // enolase are also real multi-parent nodes). kegg_paths already has
  // every real path (built for the hierarchy popup, /api/kegg/path), so
  // the lookup card fetches it directly instead of trusting the single
  // stored value -- Enzyme/Taxonomy are never multi-parent (confirmed
  // directly against the real db: 0 of 7,333 real EC nodes are
  // multi-parent; taxonomy's `parent` is a full lineage-prefix, never
  // ambiguous), so only kegg and cog need this treatment. COG's version
  // (below) reads /api/cog/path the same way -- there are 340 real
  // multi-category COGs (e.g. COG0028 is real under both category E and H),
  // all recorded in cog_paths (the table the hierarchy popup uses), while
  // the single stored `parent`/`category` column only ever holds one.
  const [lookupKeggParents, setLookupKeggParents] = useState<
    { annotation_id: string; name: string }[] | null
  >(null)
  // Same real-path data as lookupKeggParents above, just the OTHER end of
  // each path (depth-1, the real top-level category) instead of the
  // immediate parent -- the single stored (last-occurrence-wins) category
  // would contradict the Parent row beneath it (e.g. "Brite Hierarchies"
  // for K00134/GAPDH, whose real pathways include Glycolysis).
  const [lookupKeggCategories, setLookupKeggCategories] = useState<
    { annotation_id: string; name: string }[] | null
  >(null)
  // A COG id's real categories (depth-1 is the ONLY level
  // above a leaf COG id, so "category" and "immediate parent" are the same
  // single real value here -- unlike kegg's 4-level hierarchy, there's no
  // separate "parent" concept to also show).
  const [lookupCogCategories, setLookupCogCategories] = useState<
    { annotation_id: string; name: string }[] | null
  >(null)
  const lookupParentsSeqRef = useRef(0)

  useEffect(() => {
    const sel = state.lookupSelected
    // Bumped unconditionally (not just on the branch that actually
    // fetches) so a fetch started while this effect last ran for kegg/cog
    // can never be mistaken for current after a later run bails out
    // early (switched away, or no selection) -- without this, that early
    // return would leave the ref exactly where the in-flight fetch left
    // it, so its eventual resolution would still pass the "is this still
    // current" check below even though the state it was for is no longer
    // active.
    const requestId = ++lookupParentsSeqRef.current
    // eslint-disable-next-line react-hooks/set-state-in-effect -- A new selection clears the previous one's parents before fetching its own.
    setLookupKeggParents(null)
    setLookupKeggCategories(null)
    setLookupCogCategories(null)
    if (!sel) return

    if (effectiveLookupSource === 'cog') {
      apiFetch<HierarchyPathResponse>(`/api/cog/path?id=${encodeURIComponent(sel.annotation_id)}`)
        .then(r => {
          if (requestId !== lookupParentsSeqRef.current) return // superseded by a newer selection
          const byId = new Map<string, { annotation_id: string; name: string }>()
          for (const path of r.paths) {
            const category = path[0]
            if (category) byId.set(category.annotation_id, category)
          }
          setLookupCogCategories(Array.from(byId.values()))
        })
        .catch(() => {
          if (requestId !== lookupParentsSeqRef.current) return
          setLookupCogCategories([]) // fetch failed -- fall back to showing nothing rather than a stale/wrong single value
        })
      return
    }

    if (effectiveLookupSource !== 'kegg') return

    apiFetch<HierarchyPathResponse>(`/api/kegg/path?id=${encodeURIComponent(sel.annotation_id)}`)
      .then(r => {
        if (requestId !== lookupParentsSeqRef.current) return // superseded by a newer selection
        const depth = r.paths[0]?.length ?? 0
        if (depth < 2) {
          // A-level root -- no parent above it, and no distinct category
          // above it either (it IS the category).
          setLookupKeggParents([])
          setLookupKeggCategories([])
          return
        }
        const parentsById = new Map<string, { annotation_id: string; name: string }>()
        const categoriesById = new Map<string, { annotation_id: string; name: string }>()
        for (const path of r.paths) {
          const immediate = path[depth - 2]
          if (immediate) parentsById.set(immediate.annotation_id, immediate)
          const category = path[0]
          if (category) categoriesById.set(category.annotation_id, category)
        }
        setLookupKeggParents(Array.from(parentsById.values()))
        setLookupKeggCategories(Array.from(categoriesById.values()))
      })
      .catch(() => {
        if (requestId !== lookupParentsSeqRef.current) return
        // fetch failed -- fall back to showing nothing rather than a stale/wrong single value
        setLookupKeggParents([])
        setLookupKeggCategories([])
      })
  }, [state.lookupSelected, effectiveLookupSource])

  async function load() {
    const requestId = ++topRequestSeqRef.current
    const params = { source: state.source, dateFrom: state.dateFrom, dateTo: state.dateTo }
    // A rank filter chosen for the previous rows may match none of the new
    // ones (and their ranks can mean something else for another source).
    setState(prev => ({ ...prev, status: 'loading', topRankFilter: new Set() }))
    setTopRealParents({})
    setTopRealParentsFailed(false)
    try {
      let url = `/api/annotations/top?source=${params.source}&limit=${state.limit}`
      if (params.dateFrom) url += `&date_from=${params.dateFrom}`
      if (params.dateTo)   url += `&date_to=${params.dateTo}`
      const r = await apiFetch<{ data: TopAnnotation[]; sample_count: number }>(url)
      if (requestId !== topRequestSeqRef.current) return // superseded
      const rows = r.data ?? []

      // Stays 'loading' until this resolves too (same reasoning as
      // AnnotationsByParentPanel.loadTop) -- never flash the single wrong
      // stored parent before the real multi-parent data is known.
      if (MULTI_PARENT_SOURCES.has(params.source) && rows.length > 0) {
        try {
          const parents = await fetchRealParents(params.source, rows)
          if (requestId !== topRequestSeqRef.current) return
          setTopRealParents(parents)
        } catch {
          if (requestId !== topRequestSeqRef.current) return
          setTopRealParentsFailed(true) // Group column below falls back to the single stored parent
        }
      }

      setState(prev => ({
        ...prev,
        rows,
        sampleCount: r.sample_count,
        loadedParams: params,
        status:      'ok',
      }))
    } catch {
      if (requestId !== topRequestSeqRef.current) return
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

  function toggleTopRank(depth: number) {
    setState(prev => {
      const next = new Set(prev.topRankFilter)
      if (next.has(depth)) next.delete(depth); else next.add(depth)
      return { ...prev, topRankFilter: next }
    })
  }

  function clearTopRankFilter() {
    setState(prev => ({ ...prev, topRankFilter: new Set() }))
  }

  function toggleLookupRank(depth: number) {
    setState(prev => {
      const next = new Set(prev.lookupRankFilter)
      if (next.has(depth)) next.delete(depth); else next.add(depth)
      return { ...prev, lookupRankFilter: next }
    })
  }

  function clearLookupRankFilter() {
    setState(prev => ({ ...prev, lookupRankFilter: new Set() }))
  }

  // depth is real for every source, not just taxonomy
  // (annotation_catalog/annotation_series carry it for kegg/cog/enzyme
  // too), so rank-filtering works for every source.
  const availableLookupRanks = useMemo(
    () => [...new Set(
        state.lookupResults
          .map(r => r.depth)
          .filter((d): d is number => d != null),
      )].sort((a, b) => a - b),
    [state.lookupResults],
  )

  const visibleLookupResults = useMemo(
    () => state.lookupRankFilter.size === 0
      ? state.lookupResults
      : state.lookupResults.filter(r => r.depth != null && state.lookupRankFilter.has(r.depth)),
    [state.lookupResults, state.lookupRankFilter],
  )

  // A failed request and a genuinely empty result must stay distinguishable
  // (status 'error' vs. 'ok' with an empty lookupResults) — otherwise a
  // timeout looks identical to "this annotation doesn't exist."
  async function runLookupSearch() {
    const term = state.lookupId.trim()
    if (!term) return
    const requestId = ++lookupRequestSeqRef.current
    const requestedSource = state.lookupSource
    setState(prev => ({ ...prev, lookupStatus: 'loading', lookupSelected: null, lookupRankFilter: new Set() }))
    try {
      const url = `/api/search/annotations?q=${encodeURIComponent(term)}&sources=${requestedSource}&page_size=25`
      const r   = await apiFetch<{ data: TopAnnotation[]; total: number }>(url)
      if (requestId !== lookupRequestSeqRef.current) return // superseded
      const results = r.data ?? []
      setState(prev => ({
        ...prev,
        lookupResults:      results,
        lookupSelected:     results.length === 1 ? results[0] : null,
        lookupTotal:        r.total ?? results.length,
        lookupLoadedSource: requestedSource,
        lookupStatus:       'ok',
      }))
    } catch {
      if (requestId !== lookupRequestSeqRef.current) return
      setState(prev => ({ ...prev, lookupStatus: 'error' }))
    }
  }

  // taxonomyRankLabel's named rungs (Domain/Phylum/.../Strain) only apply to
  // taxonomy's own ladder -- reusing it unconditionally for e.g. a kegg
  // depth=1 node would mislabel it "Domain". Falls back to the same
  // generic "Level N" taxonomyRankLabel already uses for an out-of-range
  // taxonomy depth.
  function rankPillLabel(depth: number, source: string): string {
    return source === 'taxonomy' ? taxonomyRankLabel(depth) : depthLabel(depth, source)
  }

  // Rank column / CSV `rank`: the same per-source names as the Lookup card's
  // Depth row and the Rank filter pills (depthLabel). Taxonomy's domain is
  // the first segment of its lineage id.
  function topRankLabel(row: TopAnnotation): string {
    if (row.depth == null) return '—'
    const domain = effectiveTopSource === 'taxonomy' ? row.annotation_id.split(';')[0] : null
    return depthLabel(row.depth, effectiveTopSource, domain)
  }

  // The Group column's display -- real
  // multi-parent data (topRealParents) when it's available for this row,
  // falling back to the single stored `parent` field otherwise (a
  // non-kegg source, a kegg root with no real parent above it, or
  // topRealParentsFailed). label is what's shown in the cell; title is
  // the full real parent list for the tooltip when there's more than one.
  // full: every real parent, readable, for the CSV `group` column ('' when
  // there is no parent).
  const topGroupDisplay = useCallback((row: TopAnnotation): { label: string; title: string | undefined; full: string } => {
    const parents = MULTI_PARENT_SOURCES.has(effectiveTopSource) ? topRealParents[row.annotation_id] : undefined
    if (parents && parents.length > 0) {
      const names = parents.map(p => p.name)
      return {
        label: names.length > 1 ? `${names[0]} (+${names.length - 1} more)` : names[0],
        title: names.join(', '),
        full:  names.join('; '),
      }
    }
    const expanded = row.parent ? expandParentLabel(row.parent, effectiveTopSource) : '—'
    return { label: expanded, title: expanded === '—' ? undefined : expanded, full: expanded === '—' ? '' : expanded }
  }, [effectiveTopSource, topRealParents])

  // Ranks actually present among the loaded rows — mirrors LeftResultList's
  // availableSources/availableRanks pattern on the Analyze page. depth is
  // real for every source (see get_top_annotations_from_catalog_sql/
  // get_top_annotations_sql), so this reads r.depth directly — a parent's
  // EGC is the sum of its descendants, so without rank-filtering,
  // kegg/cog/enzyme top lists are 100% branch/rollup nodes by default.
  const availableTopRanks = useMemo(
    () => [...new Set(
        state.rows.map(r => r.depth).filter((d): d is number => d != null),
      )].sort((a, b) => a - b),
    [state.rows],
  )

  const sorted = useMemo(() => {
    const q = state.topFilter.toLowerCase().trim()
    return [...state.rows]
      .filter(r => !q
        || r.annotation_id.toLowerCase().includes(q)
        || (r.name   ?? '').toLowerCase().includes(q)
        || (r.parent ?? '').toLowerCase().includes(q)
        // Also test the Group column's actual DISPLAYED label, not just
        // the raw stored r.parent code -- the text on screen is
        // topGroupDisplay's expanded label (e.g. "Glycolysis /
        // Gluconeogenesis" for the bare stored code "00010"), which is
        // what a user types.
        || topGroupDisplay(r).label.toLowerCase().includes(q),
      )
      .filter(r => state.topRankFilter.size === 0
        || (r.depth != null && state.topRankFilter.has(r.depth)),
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
  }, [state.rows, state.sortCol, state.sortDir, state.topFilter, state.topRankFilter, topGroupDisplay])

  // Must scale against `sorted` (what's
  // actually visible after the rank/text filters), not the unfiltered
  // state.rows -- otherwise narrowing to e.g. a specific rank still
  // scales every visible bar against a since-filtered-out branch/rollup
  // node's much larger mean, making every bar in the narrowed view read
  // as nearly empty even though they're the ones actually on screen.
  const maxMean = Math.max(...sorted.map(r => r.mean_egc), 1)

  // Sections opened at least once stay mounted (just hidden) when another
  // is open, so Dataset Overview and Annotations by Parent keep what they
  // loaded instead of starting over. Tracked during render so a section
  // opened from elsewhere (e.g. a handoff) counts too.
  const [visitedSections, setVisitedSections] = useState<Set<ExploreSection>>(
    () => new Set(state.openSection ? [state.openSection] : []),
  )
  if (state.openSection && !visitedSections.has(state.openSection)) {
    setVisitedSections(new Set(visitedSections).add(state.openSection))
  }
  const sectionStyle = (s: ExploreSection) => (state.openSection === s ? undefined : { display: 'none' })

  function toggleSection(s: ExploreSection) {
    setState(prev => ({ ...prev, openSection: prev.openSection === s ? null : s }))
  }

  return (
    <div className="page-fade">
      <div className="page-header">
        <div className="page-header-left">
          <h1>Explore Annotations</h1>
          <p className="subtitle">
            Dataset overview · top annotations by abundance · parent groupings
          </p>
        </div>
        <div className="page-header-actions">
          <ResetBtn onClick={onReset} title="Clear All Tabs" label="Clear Page" small/>
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
            {
              id:   'bulk-download' as ExploreSection,
              icon: '⬇',
              label: 'Bulk Download',
              desc:  'Download the time series of every taxon at one rank under a chosen taxon (e.g. every family in a class)',
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
        {visitedSections.has('overview') && (
          <div className="explore-panel expand-anim" style={sectionStyle('overview')}>
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
                  <NumberField
                    className="field"
                    min={5}
                    max={200}
                    value={state.limit}
                    onChange={limit => setState(prev => ({ ...prev, limit }))}
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
                      // rank/group: exactly what the table shows, readable on
                      // their own; raw depth/parent codes are kept as-is.
                      sorted.map(r => ({
                        ...r,
                        source: effectiveTopSource,
                        rank:   topRankLabel(r),
                        group:  topGroupDisplay(r).full,
                      })),
                      `top_${effectiveTopSource}_annotations.csv`,
                    )}
                  >
                    ↓ CSV
                  </button>
                )}
              </div>

              {(availableTopRanks.length > 1 || state.topRankFilter.size > 0) && (
                <div className="al-source-filter al-rank-filter" style={{ marginBottom: 10, borderRadius: 6 }}>
                  <span className="al-rank-filter-label">Rank</span>
                  <button
                    className={`al-source-pill ${state.topRankFilter.size === 0 ? 'al-source-pill-active' : ''}`}
                    onClick={clearTopRankFilter}
                  >
                    All
                  </button>
                  <HelpTooltip text="Narrows the table below to the selected taxonomic rank(s) — doesn't re-fetch, just filters what's already loaded." />
                  {/* Intentionally no domain passed here -- this pill represents
                      every taxon at this depth across the whole result set, which can
                      span multiple domains (e.g. a Bacteria leaf and a Eukaryota leaf
                      both at depth 6) at once. There's no single correct domain for a
                      depth-only aggregate like this one. */}
                  {availableTopRanks.map(depth => (
                    <button
                      key={depth}
                      className={`al-source-pill ${state.topRankFilter.has(depth) ? 'al-source-pill-active' : ''}`}
                      onClick={() => toggleTopRank(depth)}
                    >
                      {rankPillLabel(depth, effectiveTopSource)}
                    </button>
                  ))}
                </div>
              )}

              {state.status === 'ok' && state.sampleCount !== null && (
                <div style={{
                  marginBottom: 8,
                  fontSize:     12,
                  fontFamily:   'var(--mono)',
                  color:        'var(--text-dim)',
                }}>
                  Based on {state.sampleCount} sample
                  {state.sampleCount !== 1 ? 's' : ''}
                  {/* Must read loadedParams, not the live dateFrom/dateTo
                      above -- sampleCount describes what was actually loaded
                      (see the comment on the ExploreState type). Otherwise
                      editing the date picker after loading, without clicking
                      Load again, would flip this suffix to the unloaded value
                      while sampleCount still describes the old request. */}
                  {state.loadedParams?.dateFrom || state.loadedParams?.dateTo
                    ? ` · ${state.loadedParams?.dateFrom || '…'} → ${state.loadedParams?.dateTo || '…'}`
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
                <div className="state-icon">🏆</div>
                <span>Choose a source type and click Load to view top annotations.</span>
              </div>
            )}
            {state.status === 'loading' && (
              <div style={{ padding: '20px 16px 4px' }}>
                <div style={{ font: '11px var(--mono)', color: 'var(--text-dim)', marginBottom: 4 }}>
                  Computing top annotations…
                </div>
                <SkeletonTable columns={8} rows={8} />
              </div>
            )}
            {state.status === 'error' && (
              <div className="state-box error" style={{ padding: 32 }}>
                <div className="state-icon">⚠</div>
                <span>Failed to load — is the API running?</span>
              </div>
            )}

            {state.status === 'ok' && MULTI_PARENT_SOURCES.has(effectiveTopSource) && topRealParentsFailed && (
              <div
                className="state-box error"
                style={{ padding: '10px 16px', flexDirection: 'row', gap: 10, textAlign: 'left', margin: '0 0 12px' }}
                data-testid="top-kegg-parents-fetch-failure-warning"
              >
                <span style={{ flex: 1 }}>
                  Couldn't load full parent info for these annotations — the Group
                  column below shows each one's single stored parent instead, which may
                  be only one of several real parents.
                </span>
                <button className="btn sm" data-testid="top-kegg-parents-retry-btn" onClick={load}>
                  Retry
                </button>
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
                      <th>Rank</th>
                      <th>Group</th>
                      <ExploreSortTh col="mean_egc"     label="Mean EGC" sortCol={state.sortCol} sortDir={state.sortDir} onSort={toggleSort} />
                      <ExploreSortTh col="sample_count" label="Samples"  sortCol={state.sortCol} sortDir={state.sortDir} onSort={toggleSort} />
                      <th>Scaffolds</th>
                      <th>Hierarchy</th>
                      <th>Relative</th>
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.length === 0 && state.rows.length > 0 && (
                      <tr>
                        <td colSpan={99} style={{ padding: '18px 16px', color: 'var(--text-dim)', textAlign: 'center' }}>
                          No rows match the filters above ({state.rows.length} loaded).{' '}
                          <button
                            className="btn sm ghost"
                            onClick={() => setState(prev => ({ ...prev, topRankFilter: new Set(), topFilter: '' }))}
                          >
                            Clear filters
                          </button>
                        </td>
                      </tr>
                    )}
                    {sorted.map((row, i) => {
                      const group = topGroupDisplay(row)
                      return (
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
                          fontFamily: 'var(--mono)',
                          fontSize:   11,
                          color:      'var(--text-dim)',
                          whiteSpace: 'nowrap',
                        }}>
                          {topRankLabel(row)}
                        </td>
                        <td style={{
                          fontFamily:   'var(--mono)',
                          fontSize:     11,
                          color:        'var(--text-dim)',
                          maxWidth:     180,
                          overflow:     'hidden',
                          textOverflow: 'ellipsis',
                          whiteSpace:   'nowrap',
                        }}
                          title={group.title}
                        >
                          {group.label}
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
                            source={effectiveTopSource}
                            name={row.name}
                            onGoExplore={onGoScaffoldExplore}
                          />
                        </td>
                        <td>
                          <HierarchyBtn
                            annotationId={row.annotation_id}
                            source={effectiveTopSource}
                            name={row.name}
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
                      )
                    })}
                  </tbody>
                </table>
              </div>
            )}
          </div>
        )}

        {/* ── Annotations by Parent ── */}
        {visitedSections.has('by-parent') && (
          <div className="explore-panel expand-anim" style={sectionStyle('by-parent')}>
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
                key={resetKey}
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
                      lookupRankFilter: new Set(),
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
                    {effectiveLookupSource}.
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
                <>
                  {(availableLookupRanks.length > 1 || state.lookupRankFilter.size > 0) && (
                    <div className="al-source-filter al-rank-filter" style={{ marginBottom: 10, borderRadius: 6 }}>
                      <span className="al-rank-filter-label">Rank</span>
                      <button
                        className={`al-source-pill ${state.lookupRankFilter.size === 0 ? 'al-source-pill-active' : ''}`}
                        onClick={clearLookupRankFilter}
                      >
                        All
                      </button>
                      <HelpTooltip text="Narrows the result list below to the selected taxonomic rank(s) — doesn't re-search, just filters what's already loaded." />
                      {/* See the matching comment on availableTopRanks above --
                          a depth-only aggregate can span multiple domains at once. */}
                      {availableLookupRanks.map(depth => (
                        <button
                          key={depth}
                          className={`al-source-pill ${state.lookupRankFilter.has(depth) ? 'al-source-pill-active' : ''}`}
                          onClick={() => toggleLookupRank(depth)}
                        >
                          {rankPillLabel(depth, effectiveLookupSource)}
                        </button>
                      ))}
                    </div>
                  )}
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
                      {state.lookupRankFilter.size > 0
                        ? <>{visibleLookupResults.length} of {state.lookupResults.length}</>
                        : <>{state.lookupTotal} result{state.lookupTotal !== 1 ? 's' : ''}</>
                      }
                      {state.lookupRankFilter.size === 0 && state.lookupTotal > state.lookupResults.length &&
                        ` · showing ${state.lookupResults.length}`}
                      {' · click to view details'}
                      {' · sorted by mean EGC'}
                      <HelpTooltip text="EGC here is the mean across samples where the annotation was actually detected, not all 128 -- an annotation detected in only a few samples can rank above one detected everywhere. Check the (N/128) next to a row's number, when shown, before comparing two rows' rank." />
                    </div>
                    <div style={{
                      border:       '1px solid var(--border)',
                      borderRadius: 7,
                      overflow:     'hidden',
                      maxHeight:    480,
                      overflowY:    'auto',
                    }}>
                      {visibleLookupResults.map(row => {
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
                              <span
                                title={row.annotation_id}
                                style={{
                                  font:      '600 12px var(--mono)',
                                  color:     'var(--teal)',
                                  fontStyle: effectiveLookupSource === 'taxonomy' ? 'italic' : 'normal',
                                  whiteSpace:   'nowrap',
                                  overflow:     'hidden',
                                  textOverflow: 'ellipsis',
                                  flex:         1,
                                  minWidth:     0,
                                }}
                              >
                                {taxonomyAwarePrimaryLabel(effectiveLookupSource, row.annotation_id, row.name)}
                              </span>
                              <span
                                style={{
                                  font:  '400 10px var(--mono)',
                                  color: 'var(--text-dim)',
                                  flexShrink: 0,
                                }}
                                title={
                                  // mean_egc is a mean over only the
                                  // samples where the annotation was
                                  // actually detected (see
                                  // LeftResultList's own note), so say so.
                                  row.sample_count != null
                                    ? `Mean when detected, across ${row.sample_count} of 128 samples`
                                    : undefined
                                }
                              >
                                {row.mean_egc.toExponential(2)}
                                {row.sample_count != null && row.sample_count < 128 && (
                                  <span style={{ opacity: 0.7 }}>
                                    {' '}({row.sample_count}/128)
                                  </span>
                                )}
                              </span>
                            </div>
                            {row.name && effectiveLookupSource !== 'taxonomy' && (
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
                      // kegg's real (possibly multiple) parents come
                      // from lookupKeggParents (fetched from /api/kegg/path,
                      // the real ancestor data), not r.parent -- the single
                      // stored value is last-occurrence-wins and often wrong
                      // for a multi-parent KO. Enzyme/taxonomy have at most
                      // one real parent, so r.parent is still correct there.
                      // cog is suppressed too (see keggCategoryNames's own
                      // comment below) -- it has no separate "parent" vs.
                      // "category" distinction to begin with.
                      const parent = (effectiveLookupSource === 'kegg' || effectiveLookupSource === 'cog')
                        ? null
                        : (r.parent ? expandParentLabel(r.parent, effectiveLookupSource) : null)
                      const keggParentNames = effectiveLookupSource === 'kegg' && lookupKeggParents
                        ? lookupKeggParents.map(p => p.name)
                        : null
                      // Same reasoning as `parent` above -- kegg's real
                      // category is the SAME kegg_paths data
                      // lookupKeggParents already uses, not the single stored
                      // `category` field (also last-occurrence-wins).
                      // Suppressed here exactly like `parent` is, so the
                      // generic row below never shows the stale value for
                      // kegg OR cog -- cog has the same multi-category shape
                      // (340 real multi-category COGs, e.g. COG0028 real
                      // under both E and H), and
                      // cogCategoryNames below reads the same cog_paths
                      // data the hierarchy popup already uses instead.
                      const keggCategoryNames = effectiveLookupSource === 'kegg' && lookupKeggCategories
                        ? lookupKeggCategories.map(c => c.name)
                        : null
                      const cogCategoryNames = effectiveLookupSource === 'cog' && lookupCogCategories
                        ? lookupCogCategories.map(c => c.name)
                        : null
                      const rawCategory = resolveLookupCategory(r)
                      const category    = (effectiveLookupSource === 'kegg' || effectiveLookupSource === 'cog')
                        ? null
                        : (rawCategory ? expandParentLabel(rawCategory, effectiveLookupSource) : null)
                      const scaffoldCount = resolveLookupScaffoldCount(r)
                      const depth         = resolveLookupDepth(r)

                      return (
                        <div className="lookup-result">
                          <div className="lookup-header">
                            <span className={`tag ${SOURCE_TAG_CLS[effectiveLookupSource] ?? ''}`}>
                              {effectiveLookupSource}
                            </span>
                            <span
                              className="lookup-id"
                              title={r.annotation_id}
                              style={effectiveLookupSource === 'taxonomy' ? { fontStyle: 'italic' } : undefined}
                            >
                              {taxonomyAwarePrimaryLabel(effectiveLookupSource, r.annotation_id, r.name)}
                            </span>
                            {r.name && effectiveLookupSource !== 'taxonomy' && (
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
                            {keggCategoryNames && keggCategoryNames.length > 0 && (
                              <div className="lookup-meta-row" data-testid="lookup-kegg-categories">
                                <span className="lookup-meta-label">
                                  Categor{keggCategoryNames.length > 1 ? 'ies' : 'y'}
                                  {keggCategoryNames.length > 1 && (
                                    <HelpTooltip text={`This KO has real parents in ${keggCategoryNames.length} different top-level KEGG categories -- every one is shown here, not just one.`} />
                                  )}
                                </span>
                                <span className="lookup-meta-value">{keggCategoryNames.join(', ')}</span>
                              </div>
                            )}
                            {cogCategoryNames && cogCategoryNames.length > 0 && (
                              <div className="lookup-meta-row" data-testid="lookup-cog-categories">
                                <span className="lookup-meta-label">
                                  Categor{cogCategoryNames.length > 1 ? 'ies' : 'y'}
                                  {cogCategoryNames.length > 1 && (
                                    <HelpTooltip text={`This COG has ${cogCategoryNames.length} real categories -- every one is shown here, not just one.`} />
                                  )}
                                </span>
                                <span className="lookup-meta-value">{cogCategoryNames.join(', ')}</span>
                              </div>
                            )}
                            {parent && (
                              <div className="lookup-meta-row">
                                <span className="lookup-meta-label">Parent</span>
                                <span className="lookup-meta-value">{parent}</span>
                              </div>
                            )}
                            {keggParentNames && keggParentNames.length > 0 && (
                              <div className="lookup-meta-row" data-testid="lookup-kegg-parents">
                                <span className="lookup-meta-label">
                                  Parent{keggParentNames.length > 1 ? 's' : ''}
                                  {keggParentNames.length > 1 && (
                                    <HelpTooltip text={`This KO has ${keggParentNames.length} real parent pathways in KEGG's hierarchy (ko00001.keg) -- every one is shown here, not just one.`} />
                                  )}
                                </span>
                                <span className="lookup-meta-value">{keggParentNames.join(', ')}</span>
                              </div>
                            )}
                            {depth != null && (
                              <div className="lookup-meta-row">
                                <span className="lookup-meta-label">
                                  Depth
                                  <HelpTooltip text="Depth = how deep this term sits in its hierarchy (e.g. KEGG depth 3 = pathway level). Meaning depends on the annotation source." />
                                </span>
                                <span className="lookup-meta-value mono">
                                  {depth}
                                  <span style={{
                                    marginLeft:  6,
                                    fontFamily:  'var(--sans)',
                                    fontSize:    11,
                                    color:       'var(--text-dim)',
                                    fontWeight:  400,
                                  }}>
                                    ({depthLabel(depth, effectiveLookupSource, rawCategory)})
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
                                  title="Unique scaffold IDs in one sample this annotation appears in (not an aggregate across samples)"
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
                                source={effectiveLookupSource}
                                name={r.name}
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
                            {canBulkDownloadFrom(effectiveLookupSource, depth) && (
                              <button
                                className="btn sm"
                                style={{ marginLeft: 8 }}
                                onClick={() => setState(prev => ({
                                  ...prev,
                                  openSection: 'bulk-download',
                                  bulkDownloadInitialParent: {
                                    lineage: r.annotation_id,
                                    source:  effectiveLookupSource,
                                    depth:   depth ?? undefined,
                                    name:    r.name ?? undefined,
                                  },
                                }))}
                                title={`Download the time series of every term below ${r.annotation_id}`}
                              >
                                ↓ Bulk download from here
                              </button>
                            )}
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
                </>
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

        {/* ── Bulk Download ── */}
        {visitedSections.has('bulk-download') && (
          <div className="explore-panel expand-anim" style={sectionStyle('bulk-download')}>
            <BulkDownloadPanel
              key={resetKey}
              initialParent={state.bulkDownloadInitialParent}
              dataDateRange={dataDateRange}
            />
          </div>
        )}

      </div>
    </div>
  )
}
