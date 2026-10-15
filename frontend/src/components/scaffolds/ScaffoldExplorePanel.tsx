// ── ScaffoldExplorePanel ──────────────────────────────────────────────────────
// "Scaffold Information" section in the Explore page.
// Allows researchers to track scaffold and gene counts over time for one or
// more annotation terms simultaneously.
//
// Features:
//   - Search by annotation ID or name within a chosen source (all 4 types)
//   - Taxonomy rank filter pills — one for the search results dropdown,
//     one (separate) for the tracked/active terms list below it, which
//     also narrows the chart and per-term detail tables it feeds
//   - Multiple terms tracked in parallel (each gets a color)
//   - Aggregated or split-by-term line/bar chart
//   - Per-term expandable detail table (date, time, scaffolds, genes)
//   - Date range filter applied to both chart and detail tables
//   - initialTerms: optional pre-loaded terms from ScaffoldBtn "→ Explore" nav

// @ts-expect-error plotly.js-dist-min ships no .d.ts; types from @types/plotly.js
import PlotlyBase from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'
import React, { useState, useEffect, useMemo } from 'react'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = createPlotlyComponent(PlotlyBase as any)

function resolveCssVar(value: string, fallback: string): string {
  if (typeof document === 'undefined' || !value.startsWith('var(')) return value
  const name = value.slice(4, -1).trim()
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

// Builds one Plotly trace (line or bar) from a series of scaffold summary
// rows — shared by the aggregated/split chart and the per-term chart.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildScaffoldTrace(
  label:  string,
  color:  string,
  data:   { date: string; scaffold_count: number; gene_count: number }[],
  metric: 'scaffold_count' | 'gene_count',
  type:   'line' | 'bar',
): Record<string, unknown> {
  const resolvedColor = resolveCssVar(color, '#4f8ef7')
  const xs    = data.map(d => toPlotlyDate(parseDateTime(d.date)))
  const ys    = data.map(d => d[metric])
  const cdata = data.map(d => `${fmtDate(d.date)} ${fmtTime(d.date)}`)
  if (type === 'bar') {
    return {
      type: 'bar', x: xs, y: ys,
      name: label, marker: { color: resolvedColor },
      customdata: cdata,
      hovertemplate: '<b>%{customdata}</b><br>' + label + ': %{y}<extra></extra>',
    }
  }
  return {
    type: 'scatter', mode: 'lines+markers',
    x: xs, y: ys,
    line: { color: resolvedColor, width: 2 }, marker: { color: resolvedColor, size: 4 },
    name: label, connectgaps: false,
    customdata: cdata,
    hovertemplate: '<b>%{customdata}</b><br>' + label + ': %{y}<extra></extra>',
  }
}

// Filters a term's scaffold summary rows to a date range and sorts
// chronologically — used by the per-term "View chart" toggle, and by
// chartSeries below for the split-by-term case.
//
// dateFrom/dateTo are bare "YYYY-MM-DD" from <input type="date">, while
// r.date is the raw datetime the scaffold summary endpoint returns (unpadded
// "M/D/YY H:MM", e.g. "5/27/21 13:00" — see FastAPI/api/index.py's
// _parse_any_datetime docstring). Comparing them as plain text is wrong
// (W15): different formats entirely, so a date_to emptied everything and a
// date_from filtered nothing. isoDate() normalizes r.date to the same
// "YYYY-MM-DD" shape first.
export function filterSummaryForChart(
  rows:     ScaffoldSummaryRow[],
  dateFrom: string,
  dateTo:   string,
): ScaffoldSummaryRow[] {
  return rows
    .filter(r => {
      const iso = isoDate(r.date)
      if (dateFrom && iso < dateFrom) return false
      if (dateTo   && iso > dateTo)   return false
      return true
    })
    .sort((a, b) => parseDateTime(a.date) - parseDateTime(b.date))
}

export type AggregatedChartRow = { date: string; scaffold_count: number; gene_count: number }

// Sums scaffold_count/gene_count across every term's rows, per date, within
// a date range — the "aggregated" (non-split) chart mode. Same date-range
// handling as filterSummaryForChart, see its docstring for why raw text
// comparison is wrong here (W15).
export function buildAggregatedChartRows(
  terms:    { summary: ScaffoldSummaryRow[] }[],
  dateFrom: string,
  dateTo:   string,
): AggregatedChartRow[] {
  const dateMap: Record<string, AggregatedChartRow> = {}
  for (const term of terms) {
    for (const row of term.summary) {
      const iso = isoDate(row.date)
      if (dateFrom && iso < dateFrom) continue
      if (dateTo   && iso > dateTo)   continue
      if (!dateMap[row.date]) {
        dateMap[row.date] = { scaffold_count: 0, gene_count: 0, date: row.date }
      }
      dateMap[row.date].scaffold_count += row.scaffold_count
      dateMap[row.date].gene_count     += row.gene_count
    }
  }
  return Object.values(dateMap).sort((a, b) => parseDateTime(a.date) - parseDateTime(b.date))
}

import type { ApiStatus, ScaffoldExploreTerm, ScaffoldSummaryRow, ScaffoldDetailRow, TopAnnotation } from '../../types'
import { SOURCE_TAG_CLS, taxonomyAwarePrimaryLabel, primaryLabelWithCogCategory, taxonomyRankLabel } from '../../constants'
import { apiFetch, downloadCsv } from '../../utils/api'
import { fmtDate, fmtTime, parseDateTime, isoDate, toPlotlyDate } from '../../utils/format'
import { minMeanMax } from '../../utils/stats'
import { PLOTLY_HOVERLABEL } from '../../utils/chartTheme'
import { taxonomyDepthFromId } from '../../utils/taxonomy'
import { filterRedundantAnnotations, type DroppedRedundancy } from '../../utils/annotationHierarchy'
import { DateRangePicker } from '../ui/DateRangePicker'
import { HelpTooltip } from '../ui/HelpTooltip'

const TERM_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
  '#0072B2',  // Blue — Wong CB-safe
  '#D55E00',  // Vermilion — Wong 
  '#56B4E9',  // Sky Blue — Wong
  '#CC79A7',  // Reddish Purple — Wong
]

const ALL_SOURCES = ['kegg', 'cog', 'enzyme', 'taxonomy'] as const

// Number of per-term detail rows shown before the user clicks "Show all".
// Exported so tests can assert against the real value instead of hand-typing
// their own copy of it.
export const DETAIL_PAGE = 10

export function ScaffoldExplorePanel({
  initialTerms,
  dataDateRange,
}: {
  initialTerms?:  { annotationId: string; source: string }[]
  dataDateRange?: { min: string; max: string } | null
}) {
  const [terms, setTerms]               = useState<ScaffoldExploreTerm[]>([])
  const [searchQ, setSearchQ]           = useState('')
  const [searchSrc, setSearchSrc]       = useState('taxonomy')
  const [searchRes, setSearchRes]       = useState<TopAnnotation[]>([])
  const [searchStatus, setSearchStatus] = useState<ApiStatus>('idle')
  // Taxonomy rank multi-select filter for the search results below — only
  // shown when searchSrc === 'taxonomy'. Real `depth` comes straight off
  // each row (search results carry it, unlike /annotations/top).
  const [rankFilter, setRankFilter]     = useState<Set<number>>(new Set())
  // Separate rank filter for the tracked/active terms list (and the chart +
  // detail table it feeds) — terms can span multiple sources at once
  // (unlike the search dropdown, which is scoped to one source), so this
  // only ever narrows the taxonomy subset of `terms`, same rule as
  // LeftResultList's rank filter on the Analyze page. ScaffoldExploreTerm
  // has no `depth` field, so rank is derived from the lineage-prefix id.
  const [termRankFilter, setTermRankFilter] = useState<Set<number>>(new Set())
  const [dateFrom, setDateFrom]         = useState('')
  const [dateTo, setDateTo]             = useState('')
  const [chartMetric, setChartMetric]   = useState<'scaffold_count' | 'gene_count'>('scaffold_count')
  const [chartType, setChartType]       = useState<'line' | 'bar'>('line')
  const [splitByTerm, setSplitByTerm]   = useState(false)

  // Load terms passed in from navigation (e.g. "→ Explore" from Analyze).
  // Depends on a stable key so re-navigation with new terms is detected
  // even though the panel stays mounted. O(1) key comparison per render.
  const initialTermsKey = initialTerms
    ?.map(t => `${t.annotationId}::${t.source}`)
    .join(',') ?? ''

  useEffect(() => {
    if (!initialTerms?.length) return
    // Clear existing suggested terms so the incoming terms are prominent,
    // but preserve any manually-added terms the researcher already has.
    setTerms(prev => prev.filter(t => !t.suggested))
    initialTerms.forEach(t => addTerm(t.annotationId, t.source))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [initialTermsKey])

  // Auto-load top-10 EGC annotations for the selected source as "suggested"
  // terms, so the panel isn't empty before the user searches. Re-runs when
  // `searchSrc` changes, but only replaces terms if the current term list
  // is empty or contains only previously-suggested terms — a user who has
  // added their own terms keeps them when switching source.
  useEffect(() => {
    if (initialTerms?.length) return // navigation-provided terms take priority

    const allSuggestedOrEmpty = terms.length === 0 || terms.every(t => t.suggested)
    if (!allSuggestedOrEmpty) return

    let cancelled = false

    async function loadSuggestions() {
      try {
        const r = await apiFetch<{ data: TopAnnotation[] }>(
          `/api/annotations/top?source=${searchSrc}&limit=10`,
        )
        if (cancelled) return
        const top = r.data ?? []
        // Replace any existing suggestions with the new source's suggestions
        setTerms(prev => prev.filter(t => !t.suggested))
        top.forEach(ann => addTerm(ann.annotation_id, searchSrc, true))
      } catch {
        // Silently ignore — empty state remains as fallback
      }
    }

    loadSuggestions()
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [searchSrc])

  // ── Add / remove terms ─────────────────────────────────────────────────

  async function addTerm(annotationId: string, source: string, suggested = false) {
    setTerms(prev => {
      if (prev.some(t => t.annotationId === annotationId && t.source === source)) return prev
      const color = TERM_COLORS[prev.length % TERM_COLORS.length]
      return [...prev, {
        annotationId, source, summary: [], status: 'loading', color, expanded: false,
        expandedSample: null, detailRows: [], detailTotal: 0, detailStatus: 'idle',
        detailShowAll: false, detailLoadingMore: false,
        suggested, chartVisible: false,
      }]
    })
    try {
      const r = await apiFetch<{ data: ScaffoldSummaryRow[] }>(
        `/api/annotations/scaffolds/summary?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`,
      )
      setTerms(prev => prev.map(t =>
        t.annotationId === annotationId && t.source === source
          ? { ...t, summary: r.data ?? [], status: 'ok' }
          : t,
      ))
    } catch {
      setTerms(prev => prev.map(t =>
        t.annotationId === annotationId && t.source === source
          ? { ...t, status: 'error' }
          : t,
      ))
    }
  }

  function removeTerm(annotationId: string, source: string) {
    setTerms(prev => prev.filter(t =>
      !(t.annotationId === annotationId && t.source === source),
    ))
  }

  function clearSuggestions() {
    setTerms(prev => prev.filter(t => !t.suggested))
  }
  // Requests only the clicked sample's scaffolds (bounded server-side —
  // see api/routes.py 2026-07-28) instead of downloading every sample for
  // this term and filtering client-side. DETAIL_FETCH_PAGE covers the
  // overwhelming majority of real samples in one request; the rare sample
  // whose scaffold count exceeds it is completed lazily via
  // showAllTermDetail, only if the user clicks "Show all".
  const DETAIL_FETCH_PAGE = 500

  async function loadTermDetail(annotationId: string, source: string, sample: string) {
    const term = terms.find(t => t.annotationId === annotationId && t.source === source)
    if (!term) return

    if (term.expandedSample === sample) {
      setTerms(prev => prev.map(t =>
        t.annotationId === annotationId && t.source === source
          ? { ...t, expandedSample: null }
          : t,
      ))
      return
    }

    setTerms(prev => prev.map(t =>
      t.annotationId === annotationId && t.source === source
        ? {
            ...t, expandedSample: sample, detailRows: [], detailTotal: 0,
            detailShowAll: false, detailStatus: 'loading',
          }
        : t,
    ))

    try {
      const r = await apiFetch<{ data: ScaffoldDetailRow[]; total: number }>(
        `/api/annotations/scaffolds?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`
        + `&sample=${encodeURIComponent(sample)}&page=1&page_size=${DETAIL_FETCH_PAGE}`,
      )
      setTerms(prev => prev.map(t =>
        t.annotationId === annotationId && t.source === source
          ? { ...t, detailRows: r.data ?? [], detailTotal: r.total ?? 0, detailStatus: 'ok' }
          : t,
      ))
    } catch {
      setTerms(prev => prev.map(t =>
        t.annotationId === annotationId && t.source === source
          ? { ...t, detailStatus: 'error' }
          : t,
      ))
    }
  }

  // Reveals the full list for one (term, sample) pair. Instant if the
  // first page already covered everything (true for virtually all real
  // samples); fetches remaining pages first for the rare sample whose
  // count exceeds DETAIL_FETCH_PAGE.
  async function showAllTermDetail(annotationId: string, source: string, sample: string) {
    setTerms(prev => prev.map(t =>
      t.annotationId === annotationId && t.source === source
        ? { ...t, detailShowAll: true }
        : t,
    ))

    const term = terms.find(t => t.annotationId === annotationId && t.source === source)
    if (!term || term.detailRows.length >= term.detailTotal) return

    setTerms(prev => prev.map(t =>
      t.annotationId === annotationId && t.source === source
        ? { ...t, detailLoadingMore: true }
        : t,
    ))
    try {
      let all = term.detailRows
      let page = 2 // page 1 was already loaded by loadTermDetail before this button can appear
      while (all.length < term.detailTotal) {
        const r = await apiFetch<{ data: ScaffoldDetailRow[]; total: number }>(
          `/api/annotations/scaffolds?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`
          + `&sample=${encodeURIComponent(sample)}&page=${page}&page_size=${DETAIL_FETCH_PAGE}`,
        )
        if (!r.data || r.data.length === 0) break
        all = all.concat(r.data)
        page += 1
      }
      const finalRows = all
      setTerms(prev => prev.map(t =>
        t.annotationId === annotationId && t.source === source
          ? { ...t, detailRows: finalRows }
          : t,
      ))
    } finally {
      setTerms(prev => prev.map(t =>
        t.annotationId === annotationId && t.source === source
          ? { ...t, detailLoadingMore: false }
          : t,
      ))
    }
  }

  // ── Search ─────────────────────────────────────────────────────────────

  async function runSearch() {
    if (!searchQ.trim()) return
    setSearchStatus('loading')
    setSearchRes([])
    try {
      const r = await apiFetch<{ data: TopAnnotation[] }>(
        `/api/search/annotations?q=${encodeURIComponent(searchQ)}&sources=${searchSrc}&page_size=20`,
      )
      setSearchRes(r.data ?? [])
      setSearchStatus('ok')
    } catch {
      setSearchStatus('error')
    }
  }

  function handleSourceChange(src: string) {
    setSearchSrc(src)
    setSearchRes([])
    setSearchStatus('idle')
    setSearchQ('')
    setRankFilter(new Set())
  }

  function toggleRank(depth: number) {
    setRankFilter(prev => {
      const next = new Set(prev)
      if (next.has(depth)) next.delete(depth); else next.add(depth)
      return next
    })
  }

  const clearRankFilter = () => setRankFilter(new Set())

  const availableRanks = useMemo(
    () => searchSrc !== 'taxonomy'
      ? []
      : [...new Set(searchRes.map(r => r.depth).filter((d): d is number => d != null))].sort((a, b) => a - b),
    [searchRes, searchSrc],
  )

  const visibleSearchRes = useMemo(
    () => rankFilter.size === 0 || searchSrc !== 'taxonomy'
      ? searchRes
      : searchRes.filter(r => r.depth != null && rankFilter.has(r.depth)),
    [searchRes, rankFilter, searchSrc],
  )

  function toggleTermRank(depth: number) {
    setTermRankFilter(prev => {
      const next = new Set(prev)
      if (next.has(depth)) next.delete(depth); else next.add(depth)
      return next
    })
  }

  const clearTermRankFilter = () => setTermRankFilter(new Set())

  const availableTermRanks = useMemo(
    () => [...new Set(
      terms.filter(t => t.source === 'taxonomy').map(t => taxonomyDepthFromId(t.annotationId)),
    )].sort((a, b) => a - b),
    [terms],
  )

  const visibleTerms = useMemo(
    () => termRankFilter.size === 0
      ? terms
      : terms.filter(t => t.source !== 'taxonomy' || termRankFilter.has(taxonomyDepthFromId(t.annotationId))),
    [terms, termRankFilter],
  )

  const readyTerms = useMemo(
    () => visibleTerms.filter(t => t.status === 'ok' && t.summary.length > 0),
    [visibleTerms],
  )

  // W22 (docs/AUDIT-2026-09-22.md): the default "All terms" line sums every
  // ready term's scaffold/gene counts together with zero ancestor/
  // descendant awareness -- egc/scaffold/gene counts are hierarchical
  // rollups, so a nested chain (e.g. the real default top-10 taxonomy
  // terms: Bacteria ⊃ Proteobacteria ⊃ Alphaproteobacteria ⊃ ...) gets
  // double-, triple-, or worse-counted. Confirmed against the audit's own
  // live numbers: summing just 3 of those nested terms gave 375,910
  // scaffolds where the true distinct count (Bacteria's own) was 198,368.
  // Only matters for the AGGREGATED view -- split-by-term shows each
  // term's own line separately, nothing gets summed, nothing to drop.
  const [redundancy, setRedundancy] = useState<{
    droppedKeys: Set<string>
    dropped:     DroppedRedundancy[]
  }>({ droppedKeys: new Set(), dropped: [] })

  const readyTermsKey = readyTerms.map(t => `${t.source}::${t.annotationId}`).join(',')

  useEffect(() => {
    if (splitByTerm || readyTerms.length < 2) {
      setRedundancy({ droppedKeys: new Set(), dropped: [] })
      return
    }
    let cancelled = false
    filterRedundantAnnotations(
      readyTerms.map(t => ({ annotationId: t.annotationId, source: t.source })),
    ).then(({ dropped }) => {
      if (cancelled) return
      setRedundancy({
        droppedKeys: new Set(dropped.map(d => `${d.candidate.source}::${d.candidate.annotationId}`)),
        dropped,
      })
    })
    return () => { cancelled = true }
    // readyTermsKey is the real dependency (stable across re-renders that
    // don't change WHICH terms are ready) -- readyTerms itself is a new
    // array reference every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [readyTermsKey, splitByTerm])

  // ── Chart data ─────────────────────────────────────────────────────────

  // G3 (docs/AUDIT-2026-10-05.md): lifted out of chartSeries below so the
  // subtitle render site can read the same post-redundancy-filter count
  // the legend/sum already use, instead of recomputing (and silently
  // disagreeing with) its own pre-filter count from visibleTerms.
  const aggregatedTerms = useMemo(
    () => readyTerms.filter(t => !redundancy.droppedKeys.has(`${t.source}::${t.annotationId}`)),
    [readyTerms, redundancy],
  )

  const chartSeries = useMemo(() => {
    if (!readyTerms.length) return []

    if (splitByTerm) {
      return readyTerms.map(term => ({
        id:    term.annotationId,
        label: term.annotationId,
        color: term.color,
        data:  filterSummaryForChart(term.summary, dateFrom, dateTo),
      }))
    }

    if (!aggregatedTerms.length) return []

    return [{
      id:    'aggregated',
      label: `All terms (${aggregatedTerms.length})`,
      color: 'var(--chart-1)',
      data:  buildAggregatedChartRows(aggregatedTerms, dateFrom, dateTo),
    }]
  }, [readyTerms, aggregatedTerms, dateFrom, dateTo, splitByTerm])

  const chartRows = useMemo(() => {
    const dateSet = new Set<string>()
    for (const s of chartSeries) for (const d of s.data) dateSet.add(d.date)
    return Array.from(dateSet)
      .sort((a, b) => parseDateTime(a) - parseDateTime(b))
      .map(date => {
        const row: Record<string, string | number> = { date }
        for (const s of chartSeries) {
          const found = s.data.find(d => d.date === date)
          row[s.id]   = found ? found[chartMetric] : 0
        }
        return row
      })
  }, [chartSeries, chartMetric])

  // ── CSV export ─────────────────────────────────────────────────────────

  function handleExportChartCsv() {
    const countCol = chartMetric === 'scaffold_count' ? 'scaffold_count' : 'gene_count'
    const rows: Record<string, unknown>[] = []
    for (const row of chartRows) {
      const fullDate = row.date as string
      for (const s of chartSeries) {
        rows.push({
          term: s.id,
          date: fmtDate(fullDate),
          time: fmtTime(fullDate),
          [countCol]: row[s.id],
        })
      }
    }
    downloadCsv(rows, `scaffold_${chartMetric}_over_time.csv`)
  }

  // ── Render ─────────────────────────────────────────────────────────────

  return (
    <div style={{ padding: '20px 24px 32px', display: 'flex', flexDirection: 'column', gap: 20 }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
        <h2>Scaffold Information</h2>
        {terms.length > 0 && (
          <button
            className="btn sm ghost"
            onClick={() => {
              setTerms([])
              setSearchQ('')
              setSearchRes([])
              setSearchStatus('idle')
            }}
            title="Clear all scaffold terms — does not affect Analyze, Compare, or Explore state"
          >
            ✕ Clear scaffolds
          </button>
        )}
      </div>

      {/* ── Search bar ── */}
      <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap', alignItems: 'center' }}>
        <select
          className="field"
          style={{ width: 130 }}
          value={searchSrc}
          onChange={(e: React.ChangeEvent<HTMLSelectElement>) =>
            handleSourceChange(e.target.value)
          }
        >
          {ALL_SOURCES.map(s => (
            <option key={s} value={s}>{s}</option>
          ))}
        </select>
        <input
          className="field"
          placeholder="Search annotation ID or name…"
          value={searchQ}
          style={{ flex: 1, minWidth: 200, maxWidth: 360 }}
          onChange={(e: React.ChangeEvent<HTMLInputElement>) => setSearchQ(e.target.value)}
          onKeyDown={(e: React.KeyboardEvent<HTMLInputElement>) => {
            if (e.key === 'Enter') runSearch()
          }}
        />
        <button
          className="btn primary"
          onClick={runSearch}
          disabled={searchStatus === 'loading'}
        >
          {searchStatus === 'loading' ? 'Searching…' : 'Search'}
        </button>
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

      {/* ── Search results ── */}
      {searchStatus === 'error' && (
        <div className="state-box error" style={{ padding: 16 }}>
          <span>Search failed — is the API running?</span>
        </div>
      )}

      {searchStatus === 'ok' && searchRes.length === 0 && (
        <div className="state-box" style={{ padding: 16 }}>
          <span>No results found for "{searchQ}" in {searchSrc}.</span>
        </div>
      )}

      {searchStatus === 'ok' && searchRes.length > 0 && (
        <>
          {availableRanks.length > 1 && (
            <div className="al-source-filter al-rank-filter" style={{ marginBottom: 8, borderRadius: 6 }}>
              <span className="al-rank-filter-label">Rank</span>
              <button
                className={`al-source-pill ${rankFilter.size === 0 ? 'al-source-pill-active' : ''}`}
                onClick={clearRankFilter}
              >
                All
              </button>
              <HelpTooltip text="Narrows the results below to the selected taxonomic rank(s) — doesn't re-search, just filters what's already loaded." />
              {/* W7: no domain passed -- a depth-only aggregate here can span
                  multiple domains at once, so there's no single correct one. */}
              {availableRanks.map(depth => (
                <button
                  key={depth}
                  className={`al-source-pill ${rankFilter.has(depth) ? 'al-source-pill-active' : ''}`}
                  onClick={() => toggleRank(depth)}
                >
                  {taxonomyRankLabel(depth)}
                </button>
              ))}
            </div>
          )}
          <div style={{
          border: '1px solid var(--border)', borderRadius: 7,
          background: 'var(--surface)', overflow: 'hidden',
          maxHeight: 260, overflowY: 'auto',
        }}>
          <div style={{
            padding: '6px 12px', font: '10px var(--mono)', color: 'var(--text-dim)',
            background: 'var(--surface3)', borderBottom: '1px solid var(--border)',
          }}>
            {rankFilter.size > 0
              ? <>{visibleSearchRes.length} of {searchRes.length} results</>
              : <>{searchRes.length} results</>
            } — click to add
          </div>
          {visibleSearchRes.map(r => {
            const already = terms.some(t => t.annotationId === r.annotation_id && t.source === searchSrc)
            return (
              <div
                key={r.annotation_id}
                onClick={() => !already && addTerm(r.annotation_id, searchSrc)}
                style={{
                  display: 'flex', alignItems: 'center', gap: 10,
                  padding: '8px 14px',
                  cursor: already ? 'default' : 'pointer',
                  opacity: already ? 0.5 : 1,
                  borderBottom: '1px solid var(--border)',
                }}
                onMouseEnter={e => { if (!already) e.currentTarget.style.background = 'var(--surface2)' }}
                onMouseLeave={e => { e.currentTarget.style.background = '' }}
              >
                <span
                  title={r.annotation_id}
                  style={{
                    font:      '600 12px var(--mono)',
                    color:     'var(--teal)',
                    fontStyle: r.source === 'taxonomy' ? 'italic' : 'normal',
                  }}
                >
                  {taxonomyAwarePrimaryLabel(r.source ?? searchSrc, r.annotation_id, r.name)}
                </span>
                {r.source !== 'taxonomy' && (
                  <span style={{ font: '13px var(--sans)', color: 'var(--text-dim)', flex: 1 }}>
                    {r.name ?? '—'}
                  </span>
                )}
                <span style={{ font: '11px var(--mono)', color: already ? 'var(--text-dim)' : 'var(--teal)' }}>
                  {already ? 'added' : '+'}
                </span>
              </div>
            )
          })}
          </div>
        </>
      )}

      {/* ── Active terms list ── */}
      {terms.length > 0 && (
        <div className="scaffold-summary-card">
          {terms.some(t => t.suggested) && (
            <div style={{
              display:      'flex',
              alignItems:   'center',
              gap:          8,
              padding:      '8px 14px',
              borderBottom: '1px solid var(--border)',
              background:   'var(--surface3)',
            }}>
              <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                {/*
                  W (2.6, docs/AUDIT-2026-09-22.md): a user who has added
                  manual terms keeps suggested terms from a PRIOR source
                  (the refresh effect above skips re-fetching once any
                  manual term exists), so the live searchSrc dropdown can
                  disagree with what source these suggested terms actually
                  came from. Read it off the terms themselves instead.
                */}
                Showing top {terms.filter(t => t.suggested).length}{' '}
                {terms.find(t => t.suggested)?.source ?? searchSrc} annotations by mean EGC
              </span>
              <HelpTooltip text="Auto-filled with the top 10 EGC annotations for the selected source. Replaced automatically if you change the source, unless you've added your own terms." />
              <button
                className="btn sm ghost"
                style={{ marginLeft: 'auto' }}
                onClick={clearSuggestions}
              >
                Clear suggestions
              </button>
            </div>
          )}
          {availableTermRanks.length > 1 && (
            <div className="al-source-filter al-rank-filter">
              <span className="al-rank-filter-label">Rank</span>
              <button
                className={`al-source-pill ${termRankFilter.size === 0 ? 'al-source-pill-active' : ''}`}
                onClick={clearTermRankFilter}
              >
                All
              </button>
              <HelpTooltip text="Narrows this list (and the chart/table below) to the selected taxonomic rank(s) — non-taxonomy terms are unaffected." />
              {/* W7: no domain passed -- see the matching comment above availableRanks. */}
              {availableTermRanks.map(depth => (
                <button
                  key={depth}
                  className={`al-source-pill ${termRankFilter.has(depth) ? 'al-source-pill-active' : ''}`}
                  onClick={() => toggleTermRank(depth)}
                >
                  {taxonomyRankLabel(depth)}
                </button>
              ))}
            </div>
          )}
          {visibleTerms.map(term => (
            <div key={`${term.annotationId}::${term.source}`} className="scaffold-summary-card-row">
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: term.color, flexShrink: 0 }} />
              <span
                title={term.annotationId}
                style={{
                  font:      '600 12px var(--mono)',
                  color:     'var(--teal)',
                  fontStyle: term.source === 'taxonomy' ? 'italic' : 'normal',
                  minWidth:  80,
                  overflowWrap: 'anywhere',
                }}
              >
                {primaryLabelWithCogCategory(term.source, term.annotationId, null)}
              </span>
              <span className={`tag ${SOURCE_TAG_CLS[term.source] ?? ''}`}>
                {term.source}
              </span>
              {term.suggested && (
                <span style={{
                  font:           '600 9px var(--mono)',
                  color:          'var(--text-dim)',
                  border:         '1px solid var(--border)',
                  borderRadius:   3,
                  padding:        '1px 5px',
                  textTransform:  'uppercase',
                  letterSpacing:  '.06em',
                }}>
                  suggested
                </span>
              )}
              {term.status === 'loading' && (
                <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>loading…</span>
              )}
              {term.status === 'error' && (
                <span style={{ font: '11px var(--mono)', color: 'var(--coral)' }}>failed to load</span>
              )}
              {term.status === 'ok' && (() => {
                const sStats = minMeanMax(term.summary.map(r => ({ value: r.scaffold_count, date: r.date })))
                const gStats = minMeanMax(term.summary.map(r => ({ value: r.gene_count, date: r.date })))
                return (
                  <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                    {term.summary.length} samples ·{' '}
                    scaffolds {sStats?.min ?? '—'}–{sStats?.max ?? '—'}{' '}
                    (avg {sStats?.mean ?? '—'}) ·{' '}
                    genes {gStats?.min ?? '—'}–{gStats?.max ?? '—'}{' '}
                    (avg {gStats?.mean ?? '—'})
                  </span>
                )
              })()}
              <button
                className="al-card-close"
                style={{ marginLeft: 'auto' }}
                onClick={() => removeTerm(term.annotationId, term.source)}
              >
                ×
              </button>
            </div>
          ))}
        </div>
      )}

      {/* ── Chart ── */}
      {terms.some(t => t.status === 'ok') && (
        <div className="chart-card">
          <div className="chart-card-header">
            <div>
              <div className="chart-card-title">
                {chartMetric === 'scaffold_count' ? 'Scaffold count' : 'Gene count'} over time
              </div>
              {chartSeries.length === 1 && chartSeries[0].id === 'aggregated' && (
                <div style={{
                  font:     '11px var(--mono)',
                  color:    'var(--text-dim)',
                  marginTop: 2,
                }}>
                  Sum of {chartMetric === 'scaffold_count' ? 'scaffold counts' : 'gene counts'}{' '}
                  across all {aggregatedTerms.length} annotations listed
                  below, per sample — not a single annotation's value.{' '}
                  {visibleTerms.length > 1 && 'Use "Split by term" to see each one separately.'}
                </div>
              )}
            </div>
            <div style={{ display: 'flex', gap: 6, alignItems: 'center', flexWrap: 'wrap' }}>
              <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)' }}>Show:</span>
              <button
                className={`toggle-pill sm ${chartMetric === 'scaffold_count' ? 'on' : ''}`}
                onClick={() => setChartMetric('scaffold_count')}
              >
                Scaffolds
              </button>
              <button
                className={`toggle-pill sm ${chartMetric === 'gene_count' ? 'on' : ''}`}
                onClick={() => setChartMetric('gene_count')}
              >
                Genes
              </button>
              <span style={{ color: 'var(--border-l)', fontSize: 14, margin: '0 2px' }}>|</span>
              <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)' }}>Type:</span>
              <button
                className={`toggle-pill sm ${chartType === 'line' ? 'on' : ''}`}
                onClick={() => setChartType('line')}
              >
                Line
              </button>
              <button
                className={`toggle-pill sm ${chartType === 'bar' ? 'on' : ''}`}
                onClick={() => setChartType('bar')}
              >
                Bar
              </button>
              {terms.length > 1 && (
                <>
                  <span style={{ color: 'var(--border-l)', fontSize: 14, margin: '0 2px' }}>|</span>
                  <button
                    className={`toggle-pill sm ${splitByTerm ? 'on' : ''}`}
                    onClick={() => setSplitByTerm(s => !s)}
                    title="One line per term instead of aggregated"
                  >
                    Split by term
                  </button>
                  <HelpTooltip text="Aggregated sums all tracked terms into one line per sample. Split by term shows one line per term instead." />
                </>
              )}
              <button className="btn sm" onClick={handleExportChartCsv}>↓ CSV</button>
            </div>
          </div>

          <div className="chart-legend" style={{ marginBottom: 10 }}>
            {chartSeries.map(s => (
              <div className="legend-item" key={s.id}>
                <div className="legend-dot" style={{ background: s.color }} />
                <span>{s.label}</span>
              </div>
            ))}
          </div>

          {!splitByTerm && redundancy.dropped.length > 0 && (
            <div className="state-box" style={{ padding: '8px 12px', marginBottom: 10 }}>
              <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                {redundancy.dropped.length} term{redundancy.dropped.length === 1 ? '' : 's'} left out
                of "All terms" -- already counted inside another tracked term, so including both
                would double-count it:{' '}
                {redundancy.dropped.map((d, i) => (
                  <span key={`${d.candidate.source}::${d.candidate.annotationId}`}>
                    {i > 0 && ', '}
                    <strong>{d.candidate.annotationId}</strong> (inside {d.containedBy.annotationId})
                  </span>
                ))}
                . Switch to "Split by term" to see every term's own line individually.
              </span>
            </div>
          )}

          <Plot
            data={chartSeries.map(s =>
              buildScaffoldTrace(s.label, s.color, s.data, chartMetric, chartType),
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            ) as any[]}
            layout={{
              height: 260,
              margin: { t: 10, r: 16, b: 30, l: 70 },
              paper_bgcolor: 'transparent',
              plot_bgcolor:  'transparent',
              showlegend: false,
              hovermode: 'x unified',
              hoverlabel: PLOTLY_HOVERLABEL,
              barmode: 'group',
              xaxis: {
                type: 'date',
                tickfont:  { size: 10, family: 'monospace' },
                tickangle: -35,
                showgrid:  false,
                linecolor: '#d9d9d9',
              },
              yaxis: {
                title: {
                  text: chartMetric === 'scaffold_count'
                    ? 'Scaffold count (per sample)'
                    : 'Gene count (per sample)',
                  font: { size: 10, family: 'monospace' },
                },
                tickfont:  { size: 10, family: 'monospace' },
                gridcolor: '#d9d9d9',
                zeroline:  false,
              },
            // eslint-disable-next-line @typescript-eslint/no-explicit-any
            } as any}
            style={{ width: '100%' }}
            useResizeHandler
            config={{ displayModeBar: false, displaylogo: false }}
          />
        </div>
      )}

      {/* ── Per-term detail tables ── */}
      {visibleTerms.filter(t => t.status === 'ok').map(term => (
        <div key={`${term.annotationId}::${term.source}`} className="parent-group">
          <button
            className={`mappings-toggle ${term.expanded ? 'open' : ''}`}
            onClick={() => setTerms(prev => prev.map(t =>
              t.annotationId === term.annotationId && t.source === term.source
                ? { ...t, expanded: !t.expanded }
                : t,
            ))}
            style={{
              padding: '12px 16px',
              background: 'var(--surface2)',
              borderRadius: term.expanded ? '8px 8px 0 0' : 8,
            }}
          >
            <div style={{ width: 8, height: 8, borderRadius: '50%', background: term.color, flexShrink: 0 }} />
            <span className="toggle-icon">▶</span>
            <span
              className="toggle-label"
              title={term.annotationId}
              style={{
                fontWeight: 600,
                color:      'var(--text-h)',
                fontStyle:  term.source === 'taxonomy' ? 'italic' : 'normal',
              }}
            >
              {primaryLabelWithCogCategory(term.source, term.annotationId, null)}
            </span>
            <span className={`tag ${SOURCE_TAG_CLS[term.source] ?? ''}`}>{term.source}</span>
            <span className="toggle-count">
              {(() => {
                const sStats = minMeanMax(term.summary.map(r => ({ value: r.scaffold_count, date: r.date })))
                return `${term.summary.length} samples · scaffolds ${sStats?.min ?? '—'}–${sStats?.max ?? '—'} (avg ${sStats?.mean ?? '—'})`
              })()}
            </span>
          </button>

          {term.expanded && (
            <div className="expand-anim" style={{ padding: '14px 18px', borderTop: '1px solid var(--border)' }}>
              <p style={{
                font:         '12px var(--sans)',
                color:        'var(--text-dim)',
                margin:       '0 0 12px',
                maxWidth:     720,
              }}>
                Each row is one sample (one sequencing timepoint).{' '}
                <strong>Scaffolds</strong> is the number of distinct genome
                scaffolds where this annotation was found in that sample.{' '}
                <strong>Genes</strong> is the total number of gene hits for
                this annotation across all those scaffolds — a scaffold can
                contribute more than one gene. Click a row to see the
                individual scaffolds and their gene counts.
              </p>
              <div style={{ display: 'flex', justifyContent: 'flex-end', gap: 8, marginBottom: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => setTerms(prev => prev.map(t =>
                    t.annotationId === term.annotationId && t.source === term.source
                      ? { ...t, chartVisible: !t.chartVisible }
                      : t,
                  ))}
                >
                  {term.chartVisible ? '▲ Hide chart' : '📈 View chart'}
                </button>
                <button
                  className="btn sm"
                  onClick={() => downloadCsv(
                    filterSummaryForChart(term.summary, dateFrom, dateTo)
                      .map(r => ({
                        annotation_id:  term.annotationId,
                        source:         term.source,
                        sample:         r.sample,
                        date:           fmtDate(r.date),
                        time:           fmtTime(r.date),
                        scaffold_count: r.scaffold_count,
                        gene_count:     r.gene_count,
                      })),
                    `${term.annotationId}_scaffolds.csv`,
                  )}
                >
                  ↓ CSV
                </button>
              </div>

              {term.chartVisible && (() => {
                const rows = filterSummaryForChart(term.summary, dateFrom, dateTo)
                return rows.length === 0 ? (
                  <div className="state-box" style={{ padding: 16, marginBottom: 12 }}>
                    <span>No data in the selected date range.</span>
                  </div>
                ) : (
                  <div className="chart-card" style={{ marginBottom: 12 }}>
                    <Plot
                      data={[
                        buildScaffoldTrace(term.annotationId, term.color, rows, chartMetric, chartType),
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      ] as any[]}
                      layout={{
                        height: 200,
                        margin: { t: 10, r: 16, b: 30, l: 60 },
                        paper_bgcolor: 'transparent',
                        plot_bgcolor:  'transparent',
                        showlegend: false,
                        hovermode: 'x unified',
                        hoverlabel: PLOTLY_HOVERLABEL,
                        xaxis: {
                          type: 'date',
                          tickfont:  { size: 10, family: 'monospace' },
                          tickangle: -35,
                          showgrid:  false,
                          linecolor: '#d9d9d9',
                        },
                        yaxis: {
                          title: {
                            text: chartMetric === 'scaffold_count' ? 'Scaffolds' : 'Genes',
                            font: { size: 10, family: 'monospace' },
                          },
                          tickfont:  { size: 10, family: 'monospace' },
                          gridcolor: '#d9d9d9',
                          zeroline:  false,
                        },
                      // eslint-disable-next-line @typescript-eslint/no-explicit-any
                      } as any}
                      style={{ width: '100%' }}
                      useResizeHandler
                      config={{ displayModeBar: false, displaylogo: false }}
                    />
                  </div>
                )
              })()}

              <table className="mappings-table scaffold-summary-table">
                <thead>
                  <tr>
                    <th>Date</th>
                    <th>Time</th>
                    <th>Scaffolds</th>
                    <th>Genes</th>
                    <th style={{ width: 32 }} />
                  </tr>
                </thead>
                <tbody>
                  {filterSummaryForChart(term.summary, dateFrom, dateTo)
                    .map((row, i) => {
                      const isExpanded    = term.expandedSample === row.sample
                      const visibleDetail = term.detailShowAll
                        ? term.detailRows
                        : term.detailRows.slice(0, DETAIL_PAGE)

                      return (
                        <React.Fragment key={i}>
                          <tr
                            className={`scaffold-summary-row ${isExpanded ? 'expanded' : ''}`}
                            onClick={() => loadTermDetail(term.annotationId, term.source, row.sample)}
                          >
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                              {fmtDate(row.date) || '—'}
                            </td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                              {fmtTime(row.date) || '—'}
                            </td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{row.scaffold_count}</td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>{row.gene_count}</td>
                            <td style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 10 }}>
                              {isExpanded ? '▲' : '▼'}
                            </td>
                          </tr>

                          {isExpanded && (
                            <tr className="scaffold-detail-row">
                              <td colSpan={5} style={{ padding: 0 }}>
                                <div className="scaffold-detail-inner expand-anim">
                                  {term.detailStatus === 'loading' && (
                                    <div style={{ padding: '12px 16px', font: '12px var(--mono)', color: 'var(--text-dim)' }}>
                                      Loading scaffolds…
                                    </div>
                                  )}
                                  {term.detailStatus === 'error' && (
                                    <div style={{ padding: '12px 16px', font: '12px var(--mono)', color: 'var(--coral)' }}>
                                      Failed to load scaffolds.
                                    </div>
                                  )}
                                  {term.detailStatus === 'ok' && term.detailRows.length === 0 && (
                                    <div style={{ padding: '12px 16px', font: '12px var(--mono)', color: 'var(--text-dim)' }}>
                                      No individual scaffolds found.
                                    </div>
                                  )}
                                  {term.detailStatus === 'ok' && term.detailRows.length > 0 && (
                                    <>
                                      <div className="scaffold-detail-label">
                                        {term.detailTotal} scaffold
                                        {term.detailTotal !== 1 ? 's' : ''} in this sample
                                      </div>
                                      <table className="scaffold-detail-table">
                                        <thead>
                                          <tr>
                                            <th>Scaffold</th>
                                            <th>Gene count</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {visibleDetail.map((d, di) => (
                                            <tr key={di}>
                                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11, wordBreak: 'break-all' }}>
                                                {d.scaffold}
                                              </td>
                                              <td style={{ fontFamily: 'var(--mono)', fontSize: 11, textAlign: 'right' }}>
                                                {d.count}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      {term.detailTotal > DETAIL_PAGE && !term.detailShowAll && (
                                        <button
                                          className="scaffold-show-more"
                                          onClick={e => {
                                            e.stopPropagation()
                                            showAllTermDetail(term.annotationId, term.source, row.sample)
                                          }}
                                        >
                                          Show all {term.detailTotal} scaffolds ↓
                                        </button>
                                      )}
                                      {term.detailShowAll && term.detailLoadingMore && (
                                        <div style={{ padding: '8px 16px', font: '12px var(--mono)', color: 'var(--text-dim)' }}>
                                          Loading remaining scaffolds…
                                        </div>
                                      )}
                                    </>
                                  )}
                                </div>
                              </td>
                            </tr>
                          )}
                        </React.Fragment>
                      )
                    })}
                </tbody>
              </table>
            </div>
          )}
        </div>
      ))}

      {/* ── Empty state ── */}
      {terms.length === 0 && (
        <div className="state-box" style={{ padding: 32 }}>
          <div className="state-icon">🧬</div>
          <span>
            Loading top {searchSrc} annotations… or search for a specific
            annotation term above.
          </span>
        </div>
      )}
    </div>
  )
}