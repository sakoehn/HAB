// ── GroupScaffoldModal.tsx ────────────────────────────────────────────────────
// Scaffold summary modal for a grouped annotation card (N annotation terms).
//
// Fetches /api/annotations/scaffolds/summary for each member in parallel
// (Promise.all) — O(members) round-trips, each O(samples). Merges results
// into a flat table keyed by (date, annotationId) with columns:
//   Date | Time | Term ID | Term Name | Scaffolds | Genes
//
// Drill-down: clicking a row expands individual scaffold names + gene counts
// for that (sample, term) pair, fetched from /api/annotations/scaffolds.
//
// Stat strip: summed totals across all members.
// CSV export: full merged table.
// "→ Explore": navigates to ScaffoldExplorePanel with all member terms
//   pre-loaded (uses existing onGoExplore wiring, called once per member).
//
// Complexity:
//   Fetch:  O(members) parallel — no serial waiting
//   Merge:  O(members × samples) — one pass, two accumulators per row
//   Sort:   O(N log N) on merged row count — N = members × samples
//   Detail: O(1) cache hit after first fetch per (member, sample) pair
//   Scale:  linear in members and samples — fast at any realistic dataset size
//
// Place at: src/components/scaffolds/GroupScaffoldModal.tsx

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

import type { ApiStatus, ScaffoldSummaryRow, ScaffoldDetailRow, SortDir } from '../../types'
import type { Data as PlotlyData, Layout as PlotlyLayout } from 'plotly.js'
import { SOURCE_TAG_CLS, taxonomyAwarePrimaryLabel } from '../../constants'
import { filterRedundantAnnotations, type DroppedRedundancy } from '../../utils/annotationHierarchy'
import { apiFetch, downloadCsv } from '../../utils/api'
import { fmtDate, fmtTime, parseDateTime, toPlotlyDate } from '../../utils/format'
import { PLOTLY_HOVERLABEL } from '../../utils/chartTheme'
import { SkeletonStatTiles, SkeletonChart, SkeletonTable } from '../ui/Skeleton'

// ── Types ──────────────────────────────────────────────────────────────────

type Member = {
  annotationId: string
  source:       string
  name:         string | null
}

// Merged row: one entry per (date, member) combination
type MergedRow = {
  date:          string   // ISO datetime string
  annotationId:  string
  name:          string | null
  source:        string
  sample:        string
  scaffold_count: number
  gene_count:     number
}

// Chart row: one entry per date, summed across all members
type ChartRow = {
  date:           string
  scaffold_count: number
  gene_count:     number
}

type SortCol = 'date' | 'annotation_id' | 'scaffold_count' | 'gene_count'

// ── Component ──────────────────────────────────────────────────────────────

export function GroupScaffoldModal({
  members,
  groupLabel,
  onClose,
  onGoExplore,
  onGoExploreGroup,
}: {
  members:      Member[]
  groupLabel:   string
  onClose:      () => void
  onGoExplore?: (annotationId: string, source: string) => void
  onGoExploreGroup?: (members: { annotationId: string; source: string }[]) => void
}) {
  const [rows, setRows]           = useState<MergedRow[]>([])
  const [status, setStatus]       = useState<ApiStatus>('loading')
  const [failedMembers, setFailedMembers] = useState<Member[]>([])
  // Guards retryFailed against being called again while an earlier retry
  // is still in flight -- a double-click would fire two overlapping fetch
  // rounds for the same failed members, double-counting every member in
  // both the table and the summed stat strip.
  const [retrying, setRetrying] = useState(false)
  // Same overcounting guard as ScaffoldExplorePanel -- a group can contain
  // nested (ancestor/
  // descendant) annotations (e.g. a taxonomy genus and its own parent
  // phylum, both picked as separate "members"), and summing both
  // double-counts every scaffold/gene that was already inside the
  // ancestor's own total. droppedMembers holds the ones excluded from the
  // fetch/sum below (and therefore from `rows`), for the disclosure banner.
  const [droppedMembers, setDroppedMembers] = useState<DroppedRedundancy[]>([])
  const [sortCol, setSortCol]     = useState<SortCol>('date')
  const [sortDir, setSortDir]     = useState<SortDir>('asc')
  const [showChart, setShowChart] = useState(true)
  const [chartMetric, setChartMetric] = useState<'scaffold_count' | 'gene_count'>('scaffold_count')

  // Detail drill-down state: keyed by `${annotationId}::${sample}`
  const [expandedKey, setExpandedKey]         = useState<string | null>(null)
  const [detailCache, setDetailCache]         = useState<Record<string, ScaffoldDetailRow[]>>({})
  const [detailTotalCache, setDetailTotalCache] = useState<Record<string, number>>({})
  const [detailStatus, setDetailStatus]       = useState<ApiStatus>('idle')
  const [detailShowAll, setDetailShowAll]     = useState(false)
  const [detailLoadingMore, setDetailLoadingMore] = useState(false)

  // Fetches one member and reports whether it failed, rather than
  // silently collapsing a failure into "0 data" — a failed fetch and a
  // genuinely-empty result must stay distinguishable to the caller.
  async function fetchMember(m: Member): Promise<{ member: Member; data: ScaffoldSummaryRow[]; failed: boolean }> {
    try {
      const r = await apiFetch<{ data: ScaffoldSummaryRow[] }>(
        `/api/annotations/scaffolds/summary?source=${m.source}&annotation_id=${encodeURIComponent(m.annotationId)}`,
      )
      return { member: m, data: r.data ?? [], failed: false }
    } catch {
      return { member: m, data: [], failed: true }
    }
  }

  function toMergedRows(member: Member, data: ScaffoldSummaryRow[]): MergedRow[] {
    return data.map(row => ({
      date:           row.date,
      annotationId:   member.annotationId,
      name:           member.name,
      source:         member.source,
      sample:         row.sample,
      scaffold_count: row.scaffold_count,
      gene_count:     row.gene_count,
    }))
  }

  // ── Resolve redundancy, then fetch only the non-redundant members ─────
  // O(members) parallel round-trips, O(members × samples) merge. The
  // redundancy check must resolve BEFORE fetching -- fetching every member
  // first and filtering afterward would still have summed the redundant
  // ones into `rows` in the meantime.
  useEffect(() => {
    if (!members.length) { setStatus('ok'); setRows([]); setDroppedMembers([]); return }

    setStatus('loading')
    let cancelled = false
    filterRedundantAnnotations(members.map(m => ({ annotationId: m.annotationId, source: m.source })))
      .then(({ kept, dropped }) => {
        if (cancelled) return
        setDroppedMembers(dropped)
        const keptKeys = new Set(kept.map(k => `${k.source}::${k.annotationId}`))
        const effectiveMembers = members.filter(m => keptKeys.has(`${m.source}::${m.annotationId}`))
        return Promise.all(effectiveMembers.map(fetchMember))
      })
      .then(results => {
        if (cancelled || !results) return
        const merged = results.flatMap(({ member, data }) => toMergedRows(member, data))
        setRows(merged)
        setFailedMembers(results.filter(r => r.failed).map(r => r.member))
        setStatus('ok')
      })
    return () => { cancelled = true }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [members])

  // ── Retry ───────────────────────────────────────────────────────────
  // Re-fetches only the members that failed and merges them into the
  // existing rows — successful members are not re-requested.
  async function retryFailed() {
    if (retrying) return
    const targets = failedMembers
    if (!targets.length) return
    setRetrying(true)
    try {
      const results = await Promise.all(targets.map(fetchMember))
      const newRows = results.flatMap(({ member, data }) => toMergedRows(member, data))
      // Merge by (annotationId, sample), replacing rather than appending --
      // a safety net against double-counting even if this ever somehow
      // runs twice for the same member (e.g. a future caller without the
      // retrying guard above), not just the double-click this guard
      // already prevents.
      setRows(prev => {
        const byKey = new Map(prev.map(r => [`${r.annotationId}::${r.sample}`, r]))
        for (const row of newRows) byKey.set(`${row.annotationId}::${row.sample}`, row)
        return [...byKey.values()]
      })
      setFailedMembers(results.filter(r => r.failed).map(r => r.member))
    } finally {
      setRetrying(false)
    }
  }

  // ── Close on Escape ───────────────────────────────────────────────────
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  // ── Sort ──────────────────────────────────────────────────────────────
  function toggleSort(col: SortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const sorted = useMemo(() => [...rows].sort((a, b) => {
    const dir = sortDir === 'asc' ? 1 : -1
    if (sortCol === 'date') {
      return dir * (parseDateTime(a.date) - parseDateTime(b.date))
    }
    if (sortCol === 'annotation_id') {
      return dir * a.annotationId.localeCompare(b.annotationId)
    }
    if (sortCol === 'scaffold_count') {
      return dir * (a.scaffold_count - b.scaffold_count)
    }
    if (sortCol === 'gene_count') {
      return dir * (a.gene_count - b.gene_count)
    }
    return 0
  }), [rows, sortCol, sortDir])

  // ── Chart data: summed per date across all members ────────────────────
  // O(members × samples) — same complexity as the merge above.
  const chartData = useMemo<ChartRow[]>(() => {
    const dateMap: Record<string, ChartRow> = {}
    for (const row of rows) {
      if (!dateMap[row.date]) {
        dateMap[row.date] = { date: row.date, scaffold_count: 0, gene_count: 0 }
      }
      dateMap[row.date].scaffold_count += row.scaffold_count
      dateMap[row.date].gene_count     += row.gene_count
    }
    return Object.values(dateMap).sort((a, b) => parseDateTime(a.date) - parseDateTime(b.date))
  }, [rows])

  // How many of the group's original members actually contributed to
  // the sums below -- the ones dropped as redundant were deliberately never
  // fetched, so they must not count toward "terms summed" or the
  // failed-to-load denominator (which only covers members that were
  // actually attempted).
  const effectiveMemberCount = members.length - droppedMembers.length

  // ── Summary stats across all rows ────────────────────────────────────
  const totalSamples   = useMemo(() => new Set(rows.map(r => r.sample)).size, [rows])
  const totalScaffolds = useMemo(() => rows.reduce((s, r) => s + r.scaffold_count, 0), [rows])
  const totalGenes     = useMemo(() => rows.reduce((s, r) => s + r.gene_count, 0), [rows])
  // "peak scaffolds"/"peak genes" must be
  // the peak of the SUMMED-per-date series (chartData, what the chart above
  // actually plots), not the single largest per-member row in `rows` --
  // those are two different numbers once a group has >1 member, and the
  // per-member max understates the real peak (e.g. two members each with
  // 50 scaffolds on the same date sum to 100, not 50).
  const maxScaffolds   = useMemo(() => Math.max(0, ...chartData.map(r => r.scaffold_count)), [chartData])
  const maxGenes       = useMemo(() => Math.max(0, ...chartData.map(r => r.gene_count)), [chartData])

  // ── Detail drill-down ─────────────────────────────────────────────────
  // Cached by `${annotationId}::${sample}` — O(1) cache hit after first
  // fetch. Requests only this one sample's scaffolds (bounded server-side
  // — see api/routes.py 2026-07-28) instead of downloading every sample
  // for this term and filtering client-side.
  const DETAIL_FETCH_PAGE = 500

  async function loadDetail(annotationId: string, source: string, sample: string) {
    const key = `${annotationId}::${sample}`
    if (expandedKey === key) { setExpandedKey(null); return }

    setExpandedKey(key)
    setDetailShowAll(false)

    if (detailCache[key]) return  // already cached — O(1)

    setDetailStatus('loading')
    try {
      const r = await apiFetch<{ data: ScaffoldDetailRow[]; total: number }>(
        `/api/annotations/scaffolds?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`
        + `&sample=${encodeURIComponent(sample)}&page=1&page_size=${DETAIL_FETCH_PAGE}`,
      )
      setDetailCache(prev => ({ ...prev, [key]: r.data ?? [] }))
      setDetailTotalCache(prev => ({ ...prev, [key]: r.total ?? 0 }))
      setDetailStatus('ok')
    } catch {
      setDetailStatus('error')
    }
  }

  // Reveals the full list for one (term, sample) pair. Instant if the
  // first page already covered everything (true for virtually all real
  // samples); fetches remaining pages first for the rare sample whose
  // count exceeds DETAIL_FETCH_PAGE.
  async function showAllDetail(annotationId: string, source: string, sample: string) {
    const key = `${annotationId}::${sample}`
    setDetailShowAll(true)
    const current = detailCache[key] ?? []
    const total   = detailTotalCache[key] ?? 0
    if (current.length >= total) return

    setDetailLoadingMore(true)
    try {
      let all = current
      let page = 2 // page 1 was already loaded by loadDetail before this button can appear
      while (all.length < total) {
        const r = await apiFetch<{ data: ScaffoldDetailRow[]; total: number }>(
          `/api/annotations/scaffolds?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`
          + `&sample=${encodeURIComponent(sample)}&page=${page}&page_size=${DETAIL_FETCH_PAGE}`,
        )
        if (!r.data || r.data.length === 0) break
        all = all.concat(r.data)
        page += 1
      }
      setDetailCache(prev => ({ ...prev, [key]: all }))
    } finally {
      setDetailLoadingMore(false)
    }
  }

  // ── CSV export ────────────────────────────────────────────────────────
  const handleExportCsv = () => downloadCsv(
    sorted.map(r => ({
      group:          groupLabel,
      annotation_id:  r.annotationId,
      term_name:      r.name ?? '',
      source:         r.source,
      sample:         r.sample,
      date:           fmtDate(r.date),
      time:           fmtTime(r.date),
      scaffold_count: r.scaffold_count,
      gene_count:     r.gene_count,
    })),
    `${groupLabel}_group_scaffolds.csv`,
  )

  // ── Sort header helper ────────────────────────────────────────────────
  const SortTh = ({ col, label }: { col: SortCol; label: string }) => (
    <th
      onClick={() => toggleSort(col)}
      style={{ cursor: 'pointer', userSelect: 'none', whiteSpace: 'nowrap' }}
    >
      {label}
      <span style={{ marginLeft: 4, opacity: sortCol === col ? 1 : 0.3 }}>
        {sortCol === col ? (sortDir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </th>
  )

  const DETAIL_PAGE = 10

  return (
    <div
      className="scaffold-modal-overlay"
      onClick={e => { if (e.target === e.currentTarget) onClose() }}
    >
      <div className="scaffold-modal">

        {/* ── Header ── */}
        <div className="scaffold-modal-header">
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, minWidth: 0, flex: 1 }}>
            <span style={{ font: '600 14px var(--mono)', color: 'var(--teal)' }}>
              ∑ {groupLabel}
            </span>
            <span style={{
              font:        '400 11px var(--mono)',
              color:       'var(--teal)',
              background:  'var(--teal-dim)',
              border:      '1px solid rgba(61,217,184,.22)',
              borderRadius: 3,
              padding:     '1px 6px',
            }}>
              {members.length} annotations
            </span>
            <span style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>
              · Scaffold Summary
            </span>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end', gap: 8, alignItems: 'center' }}>
            {status === 'ok' && rows.length > 0 && (
              <button className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
            )}
            {(onGoExploreGroup || onGoExplore) && status === 'ok' && rows.length > 0 && (
              <button
                className="btn sm primary"
                data-testid="group-explore-btn"
                onClick={() => {
                  if (onGoExploreGroup) {
                    onGoExploreGroup(members.map(m => ({ annotationId: m.annotationId, source: m.source })))
                  } else {
                    members.forEach(m => onGoExplore?.(m.annotationId, m.source))
                  }
                  onClose()
                }}
                title="Open Scaffold Information tab in Explore with all group members pre-loaded"
              >
                → Explore all
              </button>
            )}
            <button className="btn sm ghost" onClick={onClose}>✕ Close</button>
          </div>
        </div>

        {/* ── Body ── */}
        <div className="scaffold-modal-body">
          {status === 'loading' && (
            <div style={{ padding: '16px 20px' }}>
              <span className="sr-only">
                Loading scaffold data for {members.length} annotations…
              </span>
              <SkeletonStatTiles count={6} />
              <div style={{ marginTop: 16 }}><SkeletonChart height={180} /></div>
              <div style={{ marginTop: 8 }}><SkeletonTable columns={7} rows={6} /></div>
            </div>
          )}
          {status === 'ok' && rows.length === 0 && failedMembers.length === 0 && (
            <div className="state-box" style={{ padding: 32 }}>
              <div className="state-icon">∅</div>
              <span>No scaffold data found for any annotation in this group.</span>
            </div>
          )}

          {status === 'ok' && rows.length === 0 && failedMembers.length > 0 && (
            <div className="state-box error" style={{ padding: 32 }} data-testid="group-all-failed-state">
              <div className="state-icon">⚠</div>
              <span>
                Failed to load scaffold data for all {failedMembers.length} term
                {failedMembers.length !== 1 ? 's' : ''} in this group — the
                request may have timed out.
              </span>
              <button className="btn sm" data-testid="group-retry-btn" onClick={retryFailed} disabled={retrying}>
                {retrying ? 'Retrying…' : 'Retry'}
              </button>
            </div>
          )}

          {status === 'ok' && rows.length > 0 && (
            <>
              {failedMembers.length > 0 && (
                <div
                  className="state-box error"
                  style={{ padding: '10px 16px', flexDirection: 'row', gap: 10, textAlign: 'left' }}
                  data-testid="group-fetch-warning"
                >
                  <span style={{ flex: 1 }}>
                    {/* Denominator is effectiveMemberCount, not members.length --
                        a member dropped as redundant was never attempted, so it
                        can't be counted alongside the ones that genuinely failed. */}
                    {failedMembers.length} of {effectiveMemberCount} terms failed to
                    load ({failedMembers.map(m => m.annotationId).join(', ')})
                    — totals below exclude them.
                  </span>
                  <button className="btn sm" data-testid="group-retry-btn" onClick={retryFailed} disabled={retrying}>
                    {retrying ? 'Retrying…' : 'Retry'}
                  </button>
                </div>
              )}

              {/* Same disclosure ScaffoldExplorePanel shows for the same
                  overcounting case -- a nested (ancestor/descendant) member
                  is excluded from every sum below, not silently double-
                  counted. */}
              {droppedMembers.length > 0 && (
                <div
                  className="state-box"
                  style={{ padding: '8px 12px', marginBottom: 10 }}
                  data-testid="group-redundancy-warning"
                >
                  <span style={{ font: '11px var(--mono)', color: 'var(--text-dim)' }}>
                    {droppedMembers.length} term{droppedMembers.length === 1 ? '' : 's'} left
                    out of this group's totals -- already counted inside another
                    tracked term, so including both would double-count it:{' '}
                    {droppedMembers.map((d, i) => (
                      <span key={`${d.candidate.source}::${d.candidate.annotationId}`}>
                        {i > 0 && ', '}
                        <strong>{d.candidate.annotationId}</strong> (inside {d.containedBy.annotationId})
                      </span>
                    ))}
                    .
                  </span>
                </div>
              )}

              {/* ── Stat strip ── */}
              <div className="scaffold-stat-grid">
                <div className="scaffold-stat-row">
                  <span className="scaffold-stat-row-label">Group totals</span>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{effectiveMemberCount}</span>
                    <span className="scaffold-stat-label">terms</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{totalSamples}</span>
                    <span className="scaffold-stat-label">samples</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{totalScaffolds.toLocaleString()}</span>
                    <span className="scaffold-stat-label">Σ scaffolds</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{totalGenes.toLocaleString()}</span>
                    <span className="scaffold-stat-label">Σ genes</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{maxScaffolds}</span>
                    <span className="scaffold-stat-label">peak scaffolds</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{maxGenes}</span>
                    <span className="scaffold-stat-label">peak genes</span>
                  </div>
                </div>
              </div>

              {/* ── Member list ── */}
              <div style={{
                display:      'flex',
                flexWrap:     'wrap',
                gap:          6,
                padding:      '8px 16px',
                borderBottom: '1px solid var(--border)',
              }}>
                {members.map(m => (
                  <div
                    key={`${m.annotationId}::${m.source}`}
                    style={{ display: 'flex', alignItems: 'center', gap: 5 }}
                  >
                    <span
                      title={m.annotationId}
                      style={{
                        font:      '600 11px var(--mono)',
                        color:     'var(--teal)',
                        fontStyle: m.source === 'taxonomy' ? 'italic' : 'normal',
                      }}
                    >
                      {taxonomyAwarePrimaryLabel(m.source, m.annotationId, m.name)}
                    </span>
                    {m.name && m.source !== 'taxonomy' && (
                      <span style={{ font: '11px var(--sans)', color: 'var(--text-dim)' }}>
                        {m.name}
                      </span>
                    )}
                    <span className={`tag ${SOURCE_TAG_CLS[m.source] ?? ''}`}>
                      {m.source}
                    </span>
                  </div>
                ))}
              </div>

              {/* ── Chart: summed across all members ── */}
              <div className="scaffold-chart-zone">
                <div className="scaffold-chart-header">
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      className={`toggle-pill sm ${showChart ? 'on' : ''}`}
                      onClick={() => setShowChart(s => !s)}
                    >
                      {showChart ? '▲ Hide chart' : '▼ Show chart'}
                    </button>
                    {showChart && (
                      <span style={{ font: '10px var(--mono)', color: 'var(--text-dim)' }}>
                        {/* Must match what's actually in the sum, not the
                            pre-filter group size. */}
                        summed across all {effectiveMemberCount} terms
                      </span>
                    )}
                  </div>
                  {showChart && (
                    <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                      <span style={{ font: '400 10px var(--mono)', color: 'var(--text-dim)' }}>
                        Show:
                      </span>
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
                    </div>
                  )}
                </div>

                {showChart && (
                  <Plot
                    data={[{
                      type: 'scatter', mode: 'lines+markers',
                      x: chartData.map(r => toPlotlyDate(parseDateTime(r.date))),
                      y: chartData.map(r =>
                        chartMetric === 'scaffold_count' ? r.scaffold_count : r.gene_count
                      ),
                      line:   { color: resolveCssVar('var(--chart-1)', '#4f8ef7'), width: 2 },
                      marker: { color: resolveCssVar('var(--chart-1)', '#4f8ef7'), size: 4 },
                      connectgaps: false,
                      customdata: chartData.map(r => fmtDate(r.date)),
                      hovertemplate:
                        '<b>%{customdata}</b><br>' +
                        (chartMetric === 'scaffold_count' ? 'Scaffolds (Σ)' : 'Genes (Σ)') +
                        ': %{y}<extra></extra>',
                    } as Partial<PlotlyData>]}
                    layout={{
                      height: 180,
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
                          text: chartMetric === 'scaffold_count'
                            ? 'Scaffold count (summed)'
                            : 'Gene count (summed)',
                          font: { size: 10, family: 'monospace' },
                        },
                        tickfont:  { size: 10, family: 'monospace' },
                        gridcolor: '#d9d9d9',
                        zeroline:  false,
                      },
                    } as Partial<PlotlyLayout>}
                    style={{ width: '100%' }}
                    useResizeHandler
                    config={{ displayModeBar: false, displaylogo: false }}
                  />
                )}
              </div>

              {/* ── Merged detail table ── */}
              <div style={{ overflowX: 'auto' }}>
                <table className="mappings-table scaffold-summary-table">
                  <thead>
                    <tr>
                      <SortTh col="date"           label="Date"      />
                      <th>Time</th>
                      <SortTh col="annotation_id"  label="Term ID"   />
                      <th>Term name</th>
                      <SortTh col="scaffold_count" label="Scaffolds" />
                      <SortTh col="gene_count"     label="Genes"     />
                      <th style={{ width: 32 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map((row, idx) => {
                      const key         = `${row.annotationId}::${row.sample}`
                      const isExpanded  = expandedKey === key
                      const cached      = detailCache[key]
                      const total       = detailTotalCache[key] ?? 0
                      const visible     = detailShowAll
                        ? (cached ?? [])
                        : (cached ?? []).slice(0, DETAIL_PAGE)

                      return (
                        <React.Fragment key={`${row.annotationId}::${row.sample}::${idx}`}>
                          <tr
                            className={`scaffold-summary-row ${isExpanded ? 'expanded' : ''}`}
                            onClick={() => loadDetail(row.annotationId, row.source, row.sample)}
                          >
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                              {fmtDate(row.date) || '—'}
                            </td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12, whiteSpace: 'nowrap' }}>
                              {fmtTime(row.date) || '—'}
                            </td>
                            <td
                              title={row.annotationId}
                              style={{
                                fontFamily:    'var(--mono)',
                                fontSize:      12,
                                color:         'var(--teal)',
                                fontStyle:     row.source === 'taxonomy' ? 'italic' : 'normal',
                                maxWidth:      200,
                                overflowWrap:  'anywhere', // taxonomy IDs are long, space-free lineage strings
                              }}
                            >
                              {taxonomyAwarePrimaryLabel(row.source, row.annotationId, row.name)}
                            </td>
                            <td style={{
                              fontSize:     12,
                              color:        'var(--text-dim)',
                              maxWidth:     200,
                              overflow:     'hidden',
                              textOverflow: 'ellipsis',
                              whiteSpace:   'nowrap',
                            }}
                              title={row.name ?? undefined}
                            >
                              {row.name ?? '—'}
                            </td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                              {row.scaffold_count}
                            </td>
                            <td style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                              {row.gene_count}
                            </td>
                            <td style={{ textAlign: 'center', color: 'var(--text-dim)', fontSize: 10 }}>
                              {isExpanded ? '▲' : '▼'}
                            </td>
                          </tr>

                          {/* ── Drill-down: scaffold names for this (term, sample) ── */}
                          {isExpanded && (
                            <tr className="scaffold-detail-row">
                              <td colSpan={7} style={{ padding: 0 }}>
                                <div className="scaffold-detail-inner expand-anim">
                                  {detailStatus === 'loading' && !cached && (
                                    <div style={{ padding: '12px 16px', font: '12px var(--mono)', color: 'var(--text-dim)' }}>
                                      Loading scaffolds…
                                    </div>
                                  )}
                                  {detailStatus === 'error' && !cached && (
                                    <div style={{ padding: '12px 16px', font: '12px var(--mono)', color: 'var(--coral)' }}>
                                      Failed to load scaffolds.
                                    </div>
                                  )}
                                  {cached && cached.length === 0 && (
                                    <div style={{ padding: '12px 16px', font: '12px var(--mono)', color: 'var(--text-dim)' }}>
                                      No individual scaffolds found.
                                    </div>
                                  )}
                                  {cached && cached.length > 0 && (
                                    <>
                                      <div className="scaffold-detail-label">
                                        {total} scaffold{total !== 1 ? 's' : ''} ·{' '}
                                        <span
                                          title={row.annotationId}
                                          style={{
                                            color:     'var(--teal)',
                                            fontStyle: row.source === 'taxonomy' ? 'italic' : 'normal',
                                          }}
                                        >
                                          {taxonomyAwarePrimaryLabel(row.source, row.annotationId, row.name)}
                                        </span>
                                        {row.name && row.source !== 'taxonomy' && (
                                          <span style={{ color: 'var(--text-dim)', marginLeft: 4 }}>
                                            {row.name}
                                          </span>
                                        )}
                                        {' '}· {fmtDate(row.date)} {fmtTime(row.date)}
                                      </div>
                                      <table className="scaffold-detail-table">
                                        <thead>
                                          <tr>
                                            <th>Scaffold</th>
                                            <th style={{ textAlign: 'right' }}>Gene count</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {visible.map((d, di) => (
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
                                      {total > DETAIL_PAGE && !detailShowAll && (
                                        <button
                                          className="scaffold-show-more"
                                          onClick={e => {
                                            e.stopPropagation()
                                            showAllDetail(row.annotationId, row.source, row.sample)
                                          }}
                                        >
                                          Show all {total} scaffolds ↓
                                        </button>
                                      )}
                                      {detailShowAll && detailLoadingMore && (
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}