// ── ScaffoldExplorePanel ──────────────────────────────────────────────────────
// "Scaffold Information" section in the Explore page.
// Allows researchers to track scaffold and gene counts over time for one or
// more annotation terms simultaneously.
//
// Features:
//   - Search by annotation ID or name within a chosen source (all 4 types)
//   - Multiple terms tracked in parallel (each gets a color)
//   - Aggregated or split-by-term line/bar chart
//   - Per-term expandable detail table (date, time, scaffolds, genes)
//   - Date range filter applied to both chart and detail tables
//   - initialTerms: optional pre-loaded terms from ScaffoldBtn "→ Explore" nav

import React, { useState, useEffect, useMemo } from 'react'
import {
  ComposedChart, Line, Bar, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer,
} from 'recharts'

import type { ApiStatus, ScaffoldExploreTerm, ScaffoldSummaryRow, ScaffoldDetailRow, TopAnnotation } from '../../types'
import { SOURCE_TAG_CLS } from '../../constants'
import { apiFetch, downloadCsv } from '../../utils/api'
import { fmtDate, fmtTime, parseDateTime } from '../../utils/format'
import { minMeanMax } from '../../utils/stats'
import { DateRangePicker } from '../ui/DateRangePicker'

const TERM_COLORS = [
  'var(--chart-1)', 'var(--chart-2)', 'var(--chart-3)', 'var(--chart-4)',
  'var(--amber)', '#a78bfa', '#34d399', '#f472b6',
]

const ALL_SOURCES = ['kegg', 'cog', 'enzyme', 'taxonomy'] as const

export function ScaffoldExplorePanel({
  initialTerms,
  dataDateRange,
}: {
  initialTerms?:  { annotationId: string; source: string }[]
  dataDateRange?: { min: string; max: string } | null
}) {
  const [terms, setTerms]               = useState<ScaffoldExploreTerm[]>([])
  const [searchQ, setSearchQ]           = useState('')
  const [searchSrc, setSearchSrc]       = useState('kegg')
  const [searchRes, setSearchRes]       = useState<TopAnnotation[]>([])
  const [searchStatus, setSearchStatus] = useState<ApiStatus>('idle')
  const [dateFrom, setDateFrom]         = useState('')
  const [dateTo, setDateTo]             = useState('')
  const [chartMetric, setChartMetric]   = useState<'scaffold_count' | 'gene_count'>('scaffold_count')
  const [chartType, setChartType]       = useState<'line' | 'bar'>('line')
  const [splitByTerm, setSplitByTerm]   = useState(false)

  // Load any pre-selected terms passed in from navigation
  useEffect(() => {
    if (initialTerms?.length) {
      initialTerms.forEach(t => addTerm(t.annotationId, t.source))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

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
        expandedSample: null, detailRows: [], detailStatus: 'idle', detailShowAll: false,
        suggested,
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
        ? { ...t, expandedSample: sample, detailRows: [], detailShowAll: false, detailStatus: 'loading' }
        : t,
    ))

    try {
      const r = await apiFetch<{ data: ScaffoldDetailRow[] }>(
        `/api/annotations/scaffolds?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`,
      )
      const rows = (r.data ?? []).filter(d => d.sample === sample)
      setTerms(prev => prev.map(t =>
        t.annotationId === annotationId && t.source === source
          ? { ...t, detailRows: rows, detailStatus: 'ok' }
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

  const DETAIL_PAGE = 10
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
  }

  // ── Chart data ─────────────────────────────────────────────────────────

  const chartSeries = useMemo(() => {
    const readyTerms = terms.filter(t => t.status === 'ok' && t.summary.length > 0)
    if (!readyTerms.length) return []

    if (splitByTerm) {
      return readyTerms.map(term => ({
        id:    term.annotationId,
        label: term.annotationId,
        color: term.color,
        data:  term.summary
          .filter(r => {
            if (dateFrom && r.date < dateFrom) return false
            if (dateTo   && r.date > dateTo)   return false
            return true
          })
          .sort((a, b) => parseDateTime(a.date) - parseDateTime(b.date)),
      }))
    }

    // Aggregated — sum all terms per date
    const dateMap: Record<string, { scaffold_count: number; gene_count: number; date: string }> = {}
    for (const term of readyTerms) {
      for (const row of term.summary) {
        if (dateFrom && row.date < dateFrom) continue
        if (dateTo   && row.date > dateTo)   continue
        if (!dateMap[row.date]) {
          dateMap[row.date] = { scaffold_count: 0, gene_count: 0, date: row.date }
        }
        dateMap[row.date].scaffold_count += row.scaffold_count
        dateMap[row.date].gene_count     += row.gene_count
      }
    }
    return [{
      id:    'aggregated',
      label: `All terms (${readyTerms.length})`,
      color: 'var(--chart-1)',
      data:  Object.values(dateMap).sort((a, b) => parseDateTime(a.date) - parseDateTime(b.date)),
    }]
  }, [terms, dateFrom, dateTo, splitByTerm])

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
      <div><h2>Scaffold Information</h2></div>

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
        <div style={{
          border: '1px solid var(--border)', borderRadius: 7,
          background: 'var(--surface)', overflow: 'hidden',
          maxHeight: 260, overflowY: 'auto',
        }}>
          <div style={{
            padding: '6px 12px', font: '10px var(--mono)', color: 'var(--text-dim)',
            background: 'var(--surface3)', borderBottom: '1px solid var(--border)',
          }}>
            {searchRes.length} results — click to add
          </div>
          {searchRes.map(r => {
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
                <span style={{ font: '600 12px var(--mono)', color: 'var(--teal)' }}>
                  {r.annotation_id}
                </span>
                <span style={{ font: '13px var(--sans)', color: 'var(--text-dim)', flex: 1 }}>
                  {r.name ?? '—'}
                </span>
                <span style={{ font: '11px var(--mono)', color: already ? 'var(--text-dim)' : 'var(--teal)' }}>
                  {already ? 'added' : '+'}
                </span>
              </div>
            )
          })}
        </div>
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
                Showing top {terms.filter(t => t.suggested).length} {searchSrc} annotations by mean EGC
              </span>
              <button
                className="btn sm ghost"
                style={{ marginLeft: 'auto' }}
                onClick={clearSuggestions}
              >
                Clear suggestions
              </button>
            </div>
          )}
          {terms.map(term => (
            <div key={`${term.annotationId}::${term.source}`} className="scaffold-summary-card-row">
              <div style={{ width: 10, height: 10, borderRadius: '50%', background: term.color, flexShrink: 0 }} />
              <span style={{ font: '600 12px var(--mono)', color: 'var(--teal)', minWidth: 80 }}>
                {term.annotationId}
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
                  across all {terms.filter(t => t.status === 'ok').length} annotations listed
                  below, per sample — not a single annotation's value.{' '}
                  {terms.length > 1 && 'Use "Split by term" to see each one separately.'}
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

          <div style={{ display: 'flex', alignItems: 'center' }}>
            <div style={{
              flexShrink:     0,
              width:          20,
              height:         260,
              display:        'flex',
              alignItems:     'center',
              justifyContent: 'center',
            }}>
              <div style={{
                transform:  'rotate(-90deg)',
                whiteSpace: 'nowrap',
                font:       '10px var(--mono)',
                color:      'var(--text-dim)',
              }}>
                {chartMetric === 'scaffold_count'
                  ? 'Scaffold count (per sample)'
                  : 'Gene count (per sample)'}
              </div>
            </div>
            <div style={{ flex: 1, minWidth: 0 }}>
              <ResponsiveContainer width="100%" height={260}>
                <ComposedChart data={chartRows} margin={{ top: 6, right: 16, left: 0, bottom: 8 }}>
              <CartesianGrid strokeDasharray="" stroke="#d9d9d9" vertical={false} />
              <XAxis
                dataKey="date"
                tick={{ fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                angle={-35}
                textAnchor="end"
                height={44}
                tickFormatter={(v: string) => fmtDate(v)}
                interval={Math.max(1, Math.floor(chartRows.length / 8))}
              />
              <YAxis
                tick={{ fill: 'var(--text-dim)', fontSize: 10, fontFamily: 'var(--mono)' }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                width={52}
              />
              <Tooltip
                content={({ active, payload, label }) => {
                  if (!active || !payload?.length) return null
                  return (
                    <div className="chart-tooltip">
                      <div className="tt-date">{fmtDate(label as string)} {fmtTime(label as string)}</div>
                      {payload.map((p, i) => (
                        <div className="tt-row" key={i}>
                          <div className="tt-dot" style={{ background: p.color as string }} />
                          <span className="tt-label">{p.dataKey as string}</span>
                          <span className="tt-val">{p.value as number}</span>
                        </div>
                      ))}
                    </div>
                  )
                }}
              />
              {chartSeries.map(s =>
                chartType === 'line' ? (
                  <Line
                    key={s.id} type="monotone" dataKey={s.id}
                    stroke={s.color} strokeWidth={2}
                    dot={{ r: 3, fill: s.color, strokeWidth: 0 }}
                    activeDot={{ r: 5 }} connectNulls={false}
                  />
                ) : (
                  <Bar key={s.id} dataKey={s.id} fill={s.color} radius={[2, 2, 0, 0]} maxBarSize={24} />
                ),
              )}
                </ComposedChart>
              </ResponsiveContainer>
            </div>
          </div>
        </div>
      )}

      {/* ── Per-term detail tables ── */}
      {terms.filter(t => t.status === 'ok').map(term => (
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
            <span className="toggle-label" style={{ fontWeight: 600, color: 'var(--text-h)' }}>
              {term.annotationId}
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
              <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 8 }}>
                <button
                  className="btn sm"
                  onClick={() => downloadCsv(
                    term.summary
                      .filter(r => {
                        if (dateFrom && r.date < dateFrom) return false
                        if (dateTo   && r.date > dateTo)   return false
                        return true
                      })
                      .sort((a, b) => a.date.localeCompare(b.date))
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
                  {[...term.summary]
                    .filter(r => {
                      if (dateFrom && r.date < dateFrom) return false
                      if (dateTo   && r.date > dateTo)   return false
                      return true
                    })
                    .sort((a, b) => a.date.localeCompare(b.date))
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
                                        {term.detailRows.length} scaffold
                                        {term.detailRows.length !== 1 ? 's' : ''} in this sample
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
                                      {term.detailRows.length > DETAIL_PAGE && !term.detailShowAll && (
                                        <button
                                          className="scaffold-show-more"
                                          onClick={e => {
                                            e.stopPropagation()
                                            setTerms(prev => prev.map(t =>
                                              t.annotationId === term.annotationId && t.source === term.source
                                                ? { ...t, detailShowAll: true }
                                                : t,
                                            ))
                                          }}
                                        >
                                          Show all {term.detailRows.length} scaffolds ↓
                                        </button>
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