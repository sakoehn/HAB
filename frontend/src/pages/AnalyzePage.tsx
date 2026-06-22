// ── AnalyzePage ───────────────────────────────────────────────────────────────
// Two-column workspace for searching annotations and building chart cards.
//
// Left column  — search bar + term tabs + LeftResultList
// Right column — scrollable chart cards + sticky action bar + Compare drawer
//
// State is owned by App and passed down so search results, open cards, and
// series data all persist when the user navigates away and returns.
//
// Sub-components defined here (only used in this page):
//   RightSingleCard  — single annotation chart card with header controls
//   RightGroupCard   — grouped/summed chart card
//   CompareDrawer    — fixed-to-viewport overlay comparison chart
//
// State shape and default are co-located at the top of this file.

import React, {
  useState, useEffect, useRef, useMemo, useCallback,
} from 'react'

import type {
  ApiStatus, AnnotationItem, RightCard,
  SeriesCache, SharedAnnotation,
} from '../types'
import { SOURCE_COLORS, SOURCE_TAG_CLS, CHART_COLORS } from '../constants'
import { nextColorForSource, resetSourceCounters } from '../constants'
import { apiFetch } from '../utils/api'
import { isoDate, fmtDate } from '../utils/format'
import { extractEgc } from '../utils/stats'
import { useCopyId } from '../hooks/useCopyId'
import { ChartErrorBoundary }  from '../components/ui/ChartErrorBoundary'
import { DateRangePicker }     from '../components/ui/DateRangePicker'
import { EgcChart }            from '../components/charts/EgcChart'
import { MultiEgcChart }       from '../components/charts/MultiEgcChart'
import { GroupedEgcChart }     from '../components/charts/GroupedEgcChart'
import { MappingsPanel }       from '../components/mappings/MappingsPanel'
import { CorrelatesPanel }     from '../components/correlates/CorrelatesPanel'
import { AnnotationInfoDrawer } from '../components/annotations/AnnotationInfoDrawer'
import { LeftResultList }      from '../components/annotations/LeftResultList'
import { ScaffoldBtn }         from '../components/scaffolds/ScaffoldBtn'

// ── AnalyzeState + default ─────────────────────────────────────────────────

export type AnalyzeState = {
  queryFields:   string[]
  sources:       string[]
  resultsByTerm: AnnotationItem[][]
  totalsByTerm:  number[]
  searchStatus:  ApiStatus
  activeTermIdx: number
  checkedByTerm: Record<string, Set<string>>
  rightCards:    RightCard[]
  seriesCache:   SeriesCache
  drawerOpen:    boolean
  drawerChecked: Set<string>
}

export function makeDefaultAnalyzeState(): AnalyzeState {
  return {
    queryFields:   [''],
    sources:       ['kegg', 'cog', 'enzyme', 'taxonomy'],
    resultsByTerm: [],
    totalsByTerm:  [],
    searchStatus:  'idle',
    activeTermIdx: 0,
    checkedByTerm: {},
    rightCards:    [],
    seriesCache:   {},
    drawerOpen:    false,
    drawerChecked: new Set(),
  }
}

// ── FirstRunHint ───────────────────────────────────────────────────────────

function FirstRunHint() {
  return (
    <div className="first-run-hint">
      <div className="frh-steps">
        <div className="frh-step">
          <div className="frh-step-num">1</div>
          <div className="frh-step-text">
            <strong>Search</strong> for a gene function — try{' '}
            <em>iron transport</em>, <em>COG0055</em>, or{' '}
            <em>photosynthesis</em>
          </div>
        </div>
        <div className="frh-step">
          <div className="frh-step-num">2</div>
          <div className="frh-step-text">
            <strong>Click +</strong> on any result to add its time series
            chart to the right panel
          </div>
        </div>
        <div className="frh-step">
          <div className="frh-step-num">3</div>
          <div className="frh-step-text">
            <strong>Compare</strong> multiple annotations using the Compare
            button at the bottom right
          </div>
        </div>
      </div>
    </div>
  )
}

// ── RightSingleCard ────────────────────────────────────────────────────────

function RightSingleCard({
  card,
  seriesCache,
  onRemove,
  onAddAnnotation,
  onGoExplore,
  dataDateRange,
}: {
  card:            Extract<RightCard, { kind: 'single' }>
  seriesCache:     SeriesCache
  onRemove:        () => void
  onAddAnnotation: (annotationId: string, source: string, name: string | null) => void
  onGoExplore:     (annotationId: string, source: string) => void
  dataDateRange?:  { min: string; max: string } | null
}) {
  const cached = seriesCache[card.key]

  const quickStats = useMemo(() => {
    if (cached?.status !== 'ok' || !cached.data.length) return null
    const vals = cached.data
      .map(d => extractEgc(d.value))
      .filter((v): v is number => v !== null)
    if (!vals.length) return null
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    return { mean, n: vals.length }
  }, [cached])

  return (
    <div className="al-right-card">
      <div className="al-right-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <div style={{
            width:        8,
            height:       8,
            borderRadius: '50%',
            background:   card.color,
            flexShrink:   0,
          }} />
          <span className="al-right-card-id">{card.annotationId}</span>
          <span className={`tag ${SOURCE_TAG_CLS[card.source] ?? ''}`}>
            {card.source}
          </span>
          {card.name && (
            <span className="al-right-card-name">— {card.name}</span>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
          {quickStats && (
            <span style={{
              font:       '400 11px var(--mono)',
              color:      'var(--text-dim)',
              whiteSpace: 'nowrap',
            }}>
              mean {quickStats.mean.toExponential(2)} · {quickStats.n} samples
            </span>
          )}
          <AnnotationInfoDrawer
            annotationId={card.annotationId}
            source={card.source}
            name={card.name}
            parent={card.parent}
          />
          <ScaffoldBtn
            annotationId={card.annotationId}
            source={card.source}
            onGoExplore={onGoExplore}
          />
          <button
            className="al-card-close"
            onClick={onRemove}
            title="Remove chart"
          >
            ×
          </button>
        </div>
      </div>

      {cached?.status === 'loading' && (
        <div className="state-box" style={{ padding: 20 }}>
          <span>Loading time series…</span>
        </div>
      )}
      {cached?.status === 'error' && (
        <div className="state-box error" style={{ padding: 20 }}>
          <span>Failed to load.</span>
        </div>
      )}
      {cached?.status === 'ok' && (
        <>
          <ChartErrorBoundary label={card.annotationId}>
            <EgcChart
              data={cached.data}
              annotationId={card.annotationId}
              annotationName={card.name}
              color={card.color}
              source={card.source}
              dataDateRange={dataDateRange}
            />
          </ChartErrorBoundary>
          <MappingsPanel
            annotationId={card.annotationId}
            source={card.source}
          />
          <CorrelatesPanel
            annotationId={card.annotationId}
            source={card.source}
            onAddAnnotation={onAddAnnotation}
          />
        </>
      )}
    </div>
  )
}

// ── RightGroupCard ─────────────────────────────────────────────────────────

function RightGroupCard({
  card,
  seriesCache,
  onRemove,
  dataDateRange,
}: {
  card:           Extract<RightCard, { kind: 'group' }>
  seriesCache:    SeriesCache
  onRemove:       () => void
  dataDateRange?: { min: string; max: string } | null
}) {
  const allSeries = card.annotationIds
    .map((id, i) => ({
      annotationId: id,
      name:         null,
      data:         seriesCache[`${id}::${card.sources[i]}`]?.data ?? [],
      color:        SOURCE_COLORS[card.sources[i]] ?? CHART_COLORS[i % CHART_COLORS.length],
    }))
    .filter(s => s.data.length > 0)

  const loading = card.annotationIds.some(
    (id, i) => seriesCache[`${id}::${card.sources[i]}`]?.status === 'loading',
  )

  return (
    <div className="al-right-card al-right-card-group">
      <div className="al-right-card-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 }}>
          <span style={{ fontSize: 14, color: 'var(--teal)', flexShrink: 0 }}>∑</span>
          <span className="al-right-card-id">Grouped: {card.label}</span>
          <span className="tag" style={{
            background:  'var(--teal-dim)',
            color:       'var(--teal)',
            borderColor: 'rgba(61,217,184,.22)',
            flexShrink:  0,
          }}>
            {card.annotationIds.length} annotations
          </span>
        </div>
        <button className="al-card-close" onClick={onRemove} title="Remove chart">
          ×
        </button>
      </div>

      {/* Compact annotation list */}
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4, marginBottom: 10 }}>
        {card.annotationIds.map(id => (
          <span key={id} style={{
            font:        '400 10px var(--mono)',
            color:       'var(--text-dim)',
            background:  'var(--surface2)',
            border:      '1px solid var(--border)',
            borderRadius: 3,
            padding:     '1px 6px',
          }}>
            {id}
          </span>
        ))}
      </div>

      {loading && (
        <div className="state-box" style={{ padding: 20 }}>
          <span>Loading series data…</span>
        </div>
      )}
      {!loading && allSeries.length > 0 && (
        <ChartErrorBoundary label={card.label}>
          <GroupedEgcChart
            allSeries={allSeries}
            groupLabel={card.label}
            dataDateRange={dataDateRange}
          />
        </ChartErrorBoundary>
      )}
      {!loading && allSeries.length === 0 && (
        <div className="state-box" style={{ padding: 20 }}>
          <span>No data loaded yet.</span>
        </div>
      )}
    </div>
  )
}

// ── CompareDrawer ──────────────────────────────────────────────────────────

function CompareDrawer({
  rightCards,
  seriesCache,
  drawerChecked,
  onToggleChecked,
  onClose,
  onSendToComparePage,
  dataDateRange,
  onGoScaffoldExplore,
}: {
  rightCards:           RightCard[]
  seriesCache:          SeriesCache
  drawerChecked:        Set<string>
  onToggleChecked:      (key: string) => void
  onClose:              () => void
  onSendToComparePage:  (anns: SharedAnnotation[]) => void
  dataDateRange?:       { min: string; max: string } | null
  onGoScaffoldExplore?: (annotationId: string, source: string) => void
}) {
  const [dateFrom, setDateFrom] = useState('')
  const [dateTo, setDateTo]     = useState('')
  const [drawerH, setDrawerH]   = useState(360)
  const [dragging, setDragging] = useState(false)
  const dragStartY  = useRef(0)
  const dragStartH  = useRef(0)

  function onGripMouseDown(e: React.MouseEvent) {
    e.preventDefault()
    dragStartY.current = e.clientY
    dragStartH.current = drawerH
    setDragging(true)

    function onMove(ev: MouseEvent) {
      const delta = dragStartY.current - ev.clientY
      const maxH  = Math.floor(window.innerHeight * 0.75)
      setDrawerH(Math.max(220, Math.min(maxH, dragStartH.current + delta)))
    }
    function onUp() {
      setDragging(false)
      document.removeEventListener('mousemove', onMove)
      document.removeEventListener('mouseup', onUp)
    }
    document.addEventListener('mousemove', onMove)
    document.addEventListener('mouseup', onUp)
  }

  const eligibleCards = rightCards.filter(
    c => c.kind === 'single',
  ) as Extract<RightCard, { kind: 'single' }>[]

  const activeSeries = eligibleCards
    .filter(c => drawerChecked.has(c.key) && seriesCache[c.key]?.status === 'ok')
    .map(c => ({
      annotationId: c.annotationId,
      name:         c.name,
      data:         seriesCache[c.key]!.data,
      color:        c.color,
      source:       c.source,
      isGrouped:    false,
    }))

  return (
    <div className="al-drawer" style={{ height: drawerH }}>
      <div
        className={`al-drawer-resize-grip ${dragging ? 'dragging' : ''}`}
        onMouseDown={onGripMouseDown}
        title="Drag to resize compare panel"
      />

      <div className="al-drawer-header">
        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
          <span className="al-drawer-title">Compare</span>
          <span style={{ font: '10px var(--mono)', color: 'var(--text-dim)' }}>
            drag top edge to resize
          </span>
        </div>
        <div style={{
          display:  'flex',
          gap:      8,
          alignItems: 'center',
          flexWrap: 'wrap',
        }}>
          <DateRangePicker
            from={dateFrom}
            to={dateTo}
            onFrom={setDateFrom}
            onTo={setDateTo}
            onClear={() => { setDateFrom(''); setDateTo('') }}
            minDate={dataDateRange?.min}
            maxDate={dataDateRange?.max}
          />
          {activeSeries.length > 0 && (
            <button
              className="btn sm"
              onClick={() => onSendToComparePage(
                activeSeries.map(s => {
                  const card = eligibleCards.find(
                    c => c.annotationId === s.annotationId,
                  )
                  return {
                    annotationId: s.annotationId,
                    source:       card?.source ?? 'kegg',
                    name:         s.name,
                  }
                }),
              )}
              title="Open full Compare page with these annotations"
            >
              → Compare page
            </button>
          )}
          <button className="btn sm ghost" onClick={onClose}>✕ Close</button>
        </div>
      </div>

      <div className="al-drawer-body">
        {/* Checkbox selector */}
        <div className="al-drawer-checklist">
          <div style={{
            font:          '600 9px var(--mono)',
            color:         'var(--text-dim)',
            textTransform: 'uppercase',
            letterSpacing: '.14em',
            marginBottom:  8,
          }}>
            Include in chart
          </div>
          {eligibleCards.length === 0 && (
            <span style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>
              Add single annotation charts to the right panel first.
            </span>
          )}
          {eligibleCards.map(c => (
            <label key={c.key} className="al-drawer-check-row">
              <input
                type="checkbox"
                checked={drawerChecked.has(c.key)}
                onChange={() => onToggleChecked(c.key)}
              />
              <div style={{
                width:        8,
                height:       8,
                borderRadius: '50%',
                background:   c.color,
                flexShrink:   0,
              }} />
              <span style={{
                fontFamily: 'var(--mono)',
                fontSize:   12,
                color:      'var(--teal)',
                flexShrink: 0,
              }}>
                {c.annotationId}
              </span>
              {c.name && (
                <span style={{
                  fontSize:     11,
                  color:        'var(--text-dim)',
                  overflow:     'hidden',
                  textOverflow: 'ellipsis',
                  whiteSpace:   'nowrap',
                }}>
                  {c.name}
                </span>
              )}
              <span
                className={`tag ${SOURCE_TAG_CLS[c.source] ?? ''}`}
                style={{ marginLeft: 'auto', flexShrink: 0 }}
              >
                {c.source}
              </span>
            </label>
          ))}
        </div>

        {/* Multi-line chart */}
        <div className="al-drawer-chart">
          {activeSeries.length < 2 && (
            <div className="state-box" style={{ padding: 24 }}>
              <div className="state-icon">📊</div>
              <span>
                Check at least 2 annotations on the left to compare them.
              </span>
            </div>
          )}
          {activeSeries.length >= 2 && (
            <ChartErrorBoundary label="Compare overlay">
              <MultiEgcChart
                series={activeSeries}
                dateFrom={dateFrom}
                dateTo={dateTo}
                dataDateRange={dataDateRange}
                onGoScaffoldExplore={onGoScaffoldExplore}
              />
            </ChartErrorBoundary>
          )}
        </div>
      </div>
    </div>
  )
}

// ── AnalyzePage ────────────────────────────────────────────────────────────

export function AnalyzePage({
  state,
  setState,
  indexReady,
  onSendToCompare,
  onGoScaffoldExplore,
  dataDateRange,
}: {
  state:               AnalyzeState
  setState:            (updater: (prev: AnalyzeState) => AnalyzeState) => void
  indexReady:          boolean
  onSendToCompare:     (anns: SharedAnnotation[]) => void
  onGoScaffoldExplore: (annotationId: string, source: string) => void
  dataDateRange?:      { min: string; max: string } | null
}) {
  const { copiedId, copy } = useCopyId()
  const firstInputRef      = useRef<HTMLInputElement>(null)

  useEffect(() => { firstInputRef.current?.focus() }, [])

  // Re-search when index becomes ready but results lack stats
  useEffect(() => {
    if (!indexReady) return
    const hasResultsWithoutStats = state.resultsByTerm.some(
      rows => rows.length > 0 && rows[0].mean_egc == null,
    )
    if (hasResultsWithoutStats) runSearch()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [indexReady])

  const activeTerms   = state.queryFields.map(q => q.trim()).filter(q => q.length > 0)
  const activeTermIdx = Math.min(
    state.activeTermIdx,
    Math.max(0, activeTerms.length - 1),
  )
  const activeTerm = activeTerms[activeTermIdx] ?? ''

  const uniqueByTerm = useMemo(() =>
    state.resultsByTerm.map(termRows => {
      const seen = new Set<string>()
      return termRows.filter(r => {
        const key = `${r.annotation_id}::${r.source}`
        if (seen.has(key)) return false
        seen.add(key); return true
      })
    }),
  [state.resultsByTerm])

  const activeRows = uniqueByTerm[activeTermIdx] ?? []

  const rightCardKeys = useMemo(
    () => new Set(
      state.rightCards
        .filter(c => c.kind === 'single')
        .map(c => c.key),
    ),
    [state.rightCards],
  )

  const activeChecked = state.checkedByTerm[activeTerm] ?? new Set<string>()

  // ── Series fetcher ───────────────────────────────────────────────────
  const fetchSeries = useCallback(async (annotationId: string, source: string) => {
    const key = `${annotationId}::${source}`
    if (state.seriesCache[key]) return
    setState(prev => ({
      ...prev,
      seriesCache: {
        ...prev.seriesCache,
        [key]: { data: [], status: 'loading' },
      },
    }))
    try {
      const json = await apiFetch<{ data: AnnotationItem[] }>(
        `/api/series/annotations?source=${source}&annotation_id=${encodeURIComponent(annotationId)}&page_size=5000`,
      )
      setState(prev => ({
        ...prev,
        seriesCache: {
          ...prev.seriesCache,
          [key]: { data: json.data ?? [], status: 'ok' },
        },
      }))
    } catch {
      setState(prev => ({
        ...prev,
        seriesCache: {
          ...prev.seriesCache,
          [key]: { data: [], status: 'error' },
        },
      }))
    }
  }, [state.seriesCache, setState])

  // ── Search ──────────────────────────────────────────────────────────
  async function runSearch() {
    if (activeTerms.length === 0 || state.sources.length === 0) return
    setState(prev => ({
      ...prev,
      searchStatus:  'loading',
      resultsByTerm: [],
      totalsByTerm:  [],
      activeTermIdx: 0,
      checkedByTerm: {},
    }))
    try {
      const src       = state.sources.map(s => `sources=${s}`).join('&')
      const responses = await Promise.all(
        activeTerms.map(term =>
          apiFetch<{ data: AnnotationItem[]; total: number }>(
            `/api/search/annotations?q=${encodeURIComponent(term)}&${src}&page_size=5000`,
          ),
        ),
      )
      setState(prev => ({
        ...prev,
        resultsByTerm: responses.map(r => r.data ?? []),
        totalsByTerm:  responses.map(r => r.total ?? r.data?.length ?? 0),
        searchStatus:  'ok',
      }))
    } catch {
      setState(prev => ({ ...prev, searchStatus: 'error' }))
    }
  }

  // ── Left column actions ──────────────────────────────────────────────
  function toggleCheck(key: string) {
    setState(prev => {
      const cur = new Set(prev.checkedByTerm[activeTerm] ?? [])
      if (cur.has(key)) cur.delete(key); else cur.add(key)
      return {
        ...prev,
        checkedByTerm: { ...prev.checkedByTerm, [activeTerm]: cur },
      }
    })
  }

  function addSingleCard(ann: AnnotationItem) {
    const key = `${ann.annotation_id}::${ann.source}`
    if (state.rightCards.some(c => c.key === key)) return
    const card: RightCard = {
      kind:         'single',
      key,
      annotationId: ann.annotation_id,
      source:       ann.source,
      name:         ann.name,
      color:        nextColorForSource(ann.source),
      parent:       (ann as AnnotationItem & { parent?: string | null }).parent ?? null,
    }
    setState(prev => ({
      ...prev,
      rightCards:    [...prev.rightCards, card],
      drawerChecked: new Set([...prev.drawerChecked, key]),
    }))
    fetchSeries(ann.annotation_id, ann.source)
  }

  function addSelectedAsIndividual() {
    const rows  = activeRows.filter(
      r => activeChecked.has(`${r.annotation_id}::${r.source}`),
    )
    const toAdd = rows.filter(
      r => !state.rightCards.some(c => c.key === `${r.annotation_id}::${r.source}`),
    )
    if (!toAdd.length) return

    const newCards: RightCard[] = toAdd.map(ann => ({
      kind:         'single' as const,
      key:          `${ann.annotation_id}::${ann.source}`,
      annotationId: ann.annotation_id,
      source:       ann.source,
      name:         ann.name,
      color:        nextColorForSource(ann.source),
      parent:       (ann as AnnotationItem & { parent?: string | null }).parent ?? null,
    }))
    const newKeys = new Set(newCards.map(c => c.key))
    setState(prev => ({
      ...prev,
      rightCards:    [...prev.rightCards, ...newCards],
      drawerChecked: new Set([...prev.drawerChecked, ...newKeys]),
      checkedByTerm: { ...prev.checkedByTerm, [activeTerm]: new Set() },
    }))
    toAdd.forEach(ann => fetchSeries(ann.annotation_id, ann.source))
  }

  async function addSelectedAsGroup() {
    const termIdx = Math.min(
      state.activeTermIdx,
      Math.max(0, activeTerms.length - 1),
    )
    const termKey = activeTerms[termIdx] ?? ''
    const checked = state.checkedByTerm[termKey] ?? new Set<string>()
    const rows    = (uniqueByTerm[termIdx] ?? []).filter(
      r => checked.has(`${r.annotation_id}::${r.source}`),
    )
    if (rows.length < 2) {
      alert('Select at least 2 annotations to create a group chart.')
      return
    }

    const MAX_GROUP = 20
    const capped    = rows.slice(0, MAX_GROUP)
    if (rows.length > MAX_GROUP) {
      alert(
        `Group capped at ${MAX_GROUP} annotations for performance. ` +
        `Only the first ${MAX_GROUP} will be included.`,
      )
    }

    const termLabel = activeTerms[termIdx] ?? 'group'
    const label     = `${termLabel} (${capped.length})`
    const key       = `group::${termLabel}::${Date.now()}`
    const card: RightCard = {
      kind:          'group',
      key,
      label,
      annotationIds: capped.map(r => r.annotation_id),
      sources:       capped.map(r => r.source),
    }
    setState(prev => ({
      ...prev,
      rightCards:    [...prev.rightCards, card],
      checkedByTerm: { ...prev.checkedByTerm, [termKey]: new Set() },
    }))

    const missing = capped.filter(
      r => !state.seriesCache[`${r.annotation_id}::${r.source}`],
    )
    await Promise.all(
      missing.map(ann => fetchSeries(ann.annotation_id, ann.source)),
    )
  }

  function removeCard(cardKey: string) {
    setState(prev => ({
      ...prev,
      rightCards:    prev.rightCards.filter(c => c.key !== cardKey),
      drawerChecked: new Set([...prev.drawerChecked].filter(k => k !== cardKey)),
    }))
  }

  function toggleDrawerCheck(key: string) {
    setState(prev => {
      const next = new Set(prev.drawerChecked)
      if (next.has(key)) next.delete(key); else next.add(key)
      return { ...prev, drawerChecked: next }
    })
  }

  const hasResults =
    state.searchStatus === 'ok' &&
    state.resultsByTerm.some(r => r.length > 0)

  const allUniqueRows = useMemo(() => {
    const seen = new Set<string>()
    return state.resultsByTerm.flat().filter(r => {
      const key = `${r.annotation_id}::${r.source}`
      if (seen.has(key)) return false
      seen.add(key); return true
    })
  }, [state.resultsByTerm])

  return (
    <div className="page-fade al-page">

      {/* ── Page header ── */}
      <div className="page-header">
        <div className="page-header-left">
          <h1>Analyze Annotations</h1>
          <p className="subtitle">
            Search across all 128 samples · select results to add charts ·
            compare overlays
          </p>
        </div>
      </div>

      {/* ── Search section ── */}
      <div className="al-topbar">
        <div style={{ marginBottom: 8 }}><h2>Search</h2></div>
        <div className="al-search-area">
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6, flex: 1 }}>
            {state.queryFields.map((q, idx) => (
              <div key={idx} className="search-bar">
                <input
                  ref={idx === 0 ? firstInputRef : undefined}
                  className="field"
                  placeholder={
                    idx === 0
                      ? 'e.g. iron, K02014, transport…'
                      : `Term ${idx + 1}`
                  }
                  value={q}
                  onChange={(e: React.ChangeEvent<HTMLInputElement>) => {
                    const next = [...state.queryFields]
                    next[idx]  = e.target.value
                    setState(prev => ({ ...prev, queryFields: next }))
                  }}
                  onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
                    if (e.key === 'Enter') runSearch()
                  }}
                />
                {state.queryFields.length > 1 && (
                  <button
                    className="btn ghost sm"
                    style={{ flex: 'none' }}
                    onClick={() => setState(prev => ({
                      ...prev,
                      queryFields: prev.queryFields.filter((_, i) => i !== idx),
                    }))}
                  >
                    ✕
                  </button>
                )}
              </div>
            ))}
          </div>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <button
              className="btn primary"
              onClick={runSearch}
              disabled={state.searchStatus === 'loading'}
            >
              {state.searchStatus === 'loading' ? 'Searching…' : 'Search'}
            </button>
            <button
              className="btn sm ghost"
              onClick={() => setState(prev => ({
                ...prev,
                queryFields: [...prev.queryFields, ''],
              }))}
              title="Add another search term — each gets its own tab"
            >
              + Add term
            </button>
          </div>
        </div>

        {/* Source toggles */}
        <div style={{
          display:    'flex',
          gap:        10,
          alignItems: 'center',
          flexWrap:   'wrap',
          marginTop:  10,
        }}>
          <div className="search-sources">
            {(['kegg', 'cog', 'enzyme', 'taxonomy'] as const).map(src => (
              <label
                key={src}
                className={`source-toggle ${state.sources.includes(src) ? 'active' : ''}`}
              >
                <input
                  type="checkbox"
                  checked={state.sources.includes(src)}
                  onChange={() => setState(prev => ({
                    ...prev,
                    sources: prev.sources.includes(src)
                      ? prev.sources.filter(x => x !== src)
                      : [...prev.sources, src],
                  }))}
                />
                <span style={{
                  width:        9,
                  height:       9,
                  borderRadius: '50%',
                  background:   SOURCE_COLORS[src],
                  flexShrink:   0,
                  display:      'inline-block',
                }} />
                {src}
              </label>
            ))}
          </div>
          <p className="subtitle" style={{ marginLeft: 4 }}>
            ···Click to exclude annotation type
          </p>
          {hasResults && (
            <div style={{
              display:    'flex',
              gap:        6,
              marginLeft: 'auto',
              alignItems: 'center',
            }}>
              <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                {allUniqueRows.length} unique annotations
              </span>
            </div>
          )}
        </div>
      </div>

      {/* ── States ── */}
      {state.searchStatus === 'idle' && <FirstRunHint />}
      {state.searchStatus === 'loading' && (
        <div className="state-box">
          <span>Searching across all samples…</span>
        </div>
      )}
      {state.searchStatus === 'error' && (
        <div className="state-box error">
          <div className="state-icon">⚠</div>
          <span>Search failed — is the FastAPI server running?</span>
        </div>
      )}
      {state.searchStatus === 'ok' && !hasResults && (
        <div className="state-box">
          <div className="state-icon">∅</div>
          <span>
            No annotations found for{' '}
            {activeTerms.map(t => `"${t}"`).join(' or ')}
          </span>
        </div>
      )}

      {/* ── Two-column workspace ── */}
      {hasResults && (
        <div className="al-workspace">

          {/* LEFT COLUMN */}
          <div className="al-left">
            <div className="al-term-tabs">
              {activeTerms.map((term, i) => (
                <button
                  key={i}
                  className={`al-term-tab ${activeTermIdx === i ? 'active' : ''}`}
                  onClick={() => setState(prev => ({ ...prev, activeTermIdx: i }))}
                >
                  {term}
                  <span className="al-tab-count">
                    {state.totalsByTerm[i] ?? uniqueByTerm[i]?.length ?? 0}
                  </span>
                </button>
              ))}
            </div>

            <LeftResultList
              rows={activeRows}
              termLabel={activeTerms[activeTermIdx] ?? ''}
              checkedKeys={activeChecked}
              seriesCache={state.seriesCache}
              rightCardKeys={rightCardKeys}
              copiedId={copiedId}
              onCopy={copy}
              onToggleCheck={toggleCheck}
              onAddSingle={addSingleCard}
              onAddSelected={addSelectedAsIndividual}
              onGroupSelected={addSelectedAsGroup}
              total={state.totalsByTerm[activeTermIdx] ?? activeRows.length}
            />
          </div>

          {/* RIGHT COLUMN */}
          <div className={`al-right ${state.drawerOpen ? 'al-right-drawer-open' : ''}`}>

            {/* Sticky action bar */}
            <div className="al-right-actionbar">
              <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                {state.rightCards.length === 0
                  ? 'Click + on results to add charts'
                  : `${state.rightCards.length} chart${state.rightCards.length !== 1 ? 's' : ''} open`}
              </span>
              <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                {/* Copy all open KEGG IDs + open Color Mapper */}
                {(() => {
                  const keggIds = state.rightCards
                    .filter(c => c.kind === 'single' && c.source === 'kegg')
                    .map(c => (c as Extract<RightCard, { kind: 'single' }>).annotationId)
                  return keggIds.length > 0 ? (
                    <button
                      className="btn sm ghost"
                      title={`Copy ${keggIds.length} KEGG ID${keggIds.length > 1 ? 's' : ''} to clipboard, then open KEGG Color Mapper`}
                      onClick={async () => {
                        try {
                          await navigator.clipboard.writeText(keggIds.join('\n'))
                        } catch {}
                        window.open(
                          'https://www.genome.jp/kegg/mapper/color.html',
                          '_blank',
                          'noopener',
                        )
                      }}
                    >
                      Color Mapper ({keggIds.length}) ⎘
                    </button>
                  ) : null
                })()}
                <button
                  className={`btn sm ${state.drawerOpen ? 'primary' : ''}`}
                  onClick={() =>
                    setState(prev => ({ ...prev, drawerOpen: !prev.drawerOpen }))
                  }
                  disabled={
                    state.rightCards.filter(c => c.kind === 'single').length < 2
                  }
                  title={
                    state.rightCards.filter(c => c.kind === 'single').length < 2
                      ? 'Add at least 2 single annotation charts to compare'
                      : 'Toggle overlay comparison chart'
                  }
                >
                  {state.drawerOpen ? '▼ Close Compare' : '▲ Compare'}
                </button>
              </div>
            </div>

            {/* Scrollable chart cards */}
            <div className="al-right-cards">
              {state.rightCards.length === 0 && (
                <div className="state-box" style={{ padding: '48px 24px' }}>
                  <div className="state-icon">📈</div>
                  <span>
                    Click <strong>+</strong> on any result to add its chart here,
                    or check multiple rows and use <strong>+ Add N</strong>.
                  </span>
                </div>
              )}
              {state.rightCards.map(card =>
                card.kind === 'single' ? (
                  <RightSingleCard
                    key={card.key}
                    card={card}
                    seriesCache={state.seriesCache}
                    dataDateRange={dataDateRange}
                    onRemove={() => removeCard(card.key)}
                    onGoExplore={onGoScaffoldExplore}
                    onAddAnnotation={(annId, src, name) => {
                      addSingleCard({
                        annotation_id: annId,
                        source:        src,
                        name,
                        sample:        '',
                        timepoint:     null,
                        value:         null,
                      } as AnnotationItem)
                    }}
                  />
                ) : (
                  <RightGroupCard
                    key={card.key}
                    card={card}
                    seriesCache={state.seriesCache}
                    dataDateRange={dataDateRange}
                    onRemove={() => removeCard(card.key)}
                  />
                ),
              )}
            </div>

            {/* Compare drawer */}
            {state.drawerOpen && (
              <CompareDrawer
                rightCards={state.rightCards}
                seriesCache={state.seriesCache}
                drawerChecked={state.drawerChecked}
                onToggleChecked={toggleDrawerCheck}
                onClose={() =>
                  setState(prev => ({ ...prev, drawerOpen: false }))
                }
                onSendToComparePage={onSendToCompare}
                dataDateRange={dataDateRange}
                onGoScaffoldExplore={onGoScaffoldExplore}
              />
            )}
          </div>

        </div>
      )}
    </div>
  )
}
