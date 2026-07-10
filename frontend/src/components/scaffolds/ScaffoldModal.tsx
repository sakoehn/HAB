// ── ScaffoldModal ─────────────────────────────────────────────────────────────
// Full-screen modal showing per-sample scaffold summary for one annotation.
//
// Data sources:
//   /api/annotations/scaffolds/summary  → per-sample counts (summary table)
//   /api/annotations/scaffolds          → individual scaffold names + counts
//
// Features:
//   - Stat strip: sample count, peak scaffolds, peak genes, avg genes/sample
//   - Toggle line chart (scaffold count or gene count over time)
//   - Sortable summary table with drill-down to individual scaffold names
//   - CSV export of summary rows
//   - "→ Explore" button to open ScaffoldExplorePanel with this annotation
//   - Escape key closes the modal

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

import type {
  ApiStatus, ScaffoldSummaryRow, ScaffoldDetailRow, ScaffoldSortCol, SortDir,
} from '../../types'
import { SOURCE_TAG_CLS } from '../../constants'
import { apiFetch, downloadCsv } from '../../utils/api'
import { fmtDate, fmtTime, parseDateTime } from '../../utils/format'
import { minMeanMax } from '../../utils/stats'
import { PLOTLY_HOVERLABEL } from '../../utils/chartTheme'

export function ScaffoldModal({
  annotationId,
  source,
  onClose,
  onGoExplore,
}: {
  annotationId: string
  source:       string
  onClose:      () => void
  onGoExplore?: (annotationId: string, source: string) => void
}) {
  const [summary, setSummary]             = useState<ScaffoldSummaryRow[]>([])
  const [status, setStatus]               = useState<ApiStatus>('loading')
  const [sortCol, setSortCol]             = useState<ScaffoldSortCol>('date')
  const [sortDir, setSortDir]             = useState<SortDir>('asc')
  const [expandedSample, setExpanded]     = useState<string | null>(null)
  const [detailRows, setDetailRows]       = useState<ScaffoldDetailRow[]>([])
  const [detailStatus, setDetailStatus]   = useState<ApiStatus>('idle')
  const [detailShowAll, setDetailShowAll] = useState(false)
  const [showChart, setShowChart]         = useState(true)
  const [chartMetric, setChartMetric]     = useState<'scaffold_count' | 'gene_count'>('scaffold_count')
  const [retryTick, setRetryTick]         = useState(0)

  useEffect(() => {
    setStatus('loading')
    apiFetch<{ data: ScaffoldSummaryRow[]; total: number }>(
      `/api/annotations/scaffolds/summary?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`,
    )
      .then(r => { setSummary(r.data ?? []); setStatus('ok') })
      .catch(() => setStatus('error'))
  }, [annotationId, source, retryTick])

  async function loadDetail(sample: string) {
    if (expandedSample === sample) { setExpanded(null); return }
    setExpanded(sample)
    setDetailRows([])
    setDetailShowAll(false)
    setDetailStatus('loading')
    try {
      const r = await apiFetch<{ data: ScaffoldDetailRow[] }>(
        `/api/annotations/scaffolds?source=${source}&annotation_id=${encodeURIComponent(annotationId)}`,
      )
      setDetailRows((r.data ?? []).filter(d => d.sample === sample))
      setDetailStatus('ok')
    } catch {
      setDetailStatus('error')
    }
  }

  // Close on Escape
  useEffect(() => {
    const h = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    document.addEventListener('keydown', h)
    return () => document.removeEventListener('keydown', h)
  }, [onClose])

  function toggleSort(col: ScaffoldSortCol) {
    if (sortCol === col) setSortDir(d => d === 'asc' ? 'desc' : 'asc')
    else { setSortCol(col); setSortDir('asc') }
  }

  const sorted = useMemo(() => [...summary].sort((a, b) => {
    if (sortCol === 'date') {
      const at = parseDateTime(a.date)
      const bt = parseDateTime(b.date)
      return sortDir === 'asc' ? at - bt : bt - at
    }
    const av = a[sortCol]
    const bv = b[sortCol]
    if (typeof av === 'number' && typeof bv === 'number') {
      return sortDir === 'asc' ? av - bv : bv - av
    }
    return sortDir === 'asc'
      ? String(av).localeCompare(String(bv))
      : String(bv).localeCompare(String(av))
  }), [summary, sortCol, sortDir])

  const chartData = useMemo(
    () => [...summary].sort((a, b) => parseDateTime(a.date) - parseDateTime(b.date)),
    [summary],
  )

  const scaffoldStats = useMemo(
    () => minMeanMax(summary.map(r => ({ value: r.scaffold_count, date: r.date }))),
    [summary],
  )
  const geneStats = useMemo(
    () => minMeanMax(summary.map(r => ({ value: r.gene_count, date: r.date }))),
    [summary],
  )

  const handleExportCsv = () => downloadCsv(
    sorted.map(r => ({
      annotation_id:  annotationId,
      source,
      sample:         r.sample,
      date:           fmtDate(r.date),
      time:           fmtTime(r.date),
      scaffold_count: r.scaffold_count,
      gene_count:     r.gene_count,
    })),
    `${annotationId}_scaffolds_summary.csv`,
  )

  // ── Sortable header helper ─────────────────────────────────────────────
  const SortTh = ({
    col,
    label,
  }: {
    col:   ScaffoldSortCol
    label: string
  }) => (
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
      <div className="scaffold-modal" data-testid="scaffold-modal" role="dialog">

        {/* ── Modal header ── */}
        <div className="scaffold-modal-header" data-testid="modal-header">
          <div style={{
            display:    'flex',
            alignItems: 'center',
            gap:        10,
            minWidth:   0,
            flex:       1,
          }}>
            <span
              data-testid="annotation-id"
              style={{ font: '600 14px var(--mono)', color: 'var(--teal)' }}
            >
              {annotationId}
            </span>
            <span data-testid="source-tag" className={`tag ${SOURCE_TAG_CLS[source] ?? ''}`}>{source}</span>
            <span style={{ font: '12px var(--mono)', color: 'var(--text-dim)' }}>
              · Scaffold Summary
            </span>
          </div>
          <div style={{
            display:    'flex',
            gap:        8,
            flexShrink: 0,
            alignItems: 'center',
          }}>
            {status === 'ok' && summary.length > 0 && (
              <button data-testid="csv-btn" className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
            )}
            {onGoExplore && status === 'ok' && summary.length > 0 && (
              <button
                data-testid="explore-btn"
                className="btn sm primary"
                onClick={() => { onGoExplore(annotationId, source); onClose() }}
                title="Open Scaffold Information tab in Explore with this term pre-loaded"
              >
                → Explore
              </button>
            )}
            <button data-testid="close-btn" className="btn sm ghost" onClick={onClose}>✕ Close</button>
          </div>
        </div>

        {/* ── Modal body ── */}
        <div className="scaffold-modal-body">
          {status === 'loading' && (
            <div className="state-box" data-testid="loading-state" style={{ padding: 32 }}>
              <span>Loading scaffold summary…</span>
            </div>
          )}
          {status === 'error' && (
            <div className="state-box error" data-testid="error-state" style={{ padding: 32 }}>
              <div className="state-icon">⚠</div>
              <span>
                Failed to load scaffolds for {annotationId} — the request may
                have timed out.
              </span>
              <button data-testid="retry-btn" className="btn sm" onClick={() => setRetryTick(t => t + 1)}>
                Retry
              </button>
            </div>
          )}
          {status === 'ok' && summary.length === 0 && (
            <div className="state-box" data-testid="empty-state" style={{ padding: 32 }}>
              <div className="state-icon">∅</div>
              <span>No scaffolds found for {annotationId}.</span>
            </div>
          )}

          {status === 'ok' && summary.length > 0 && (
            <>
              {/* ── Stat strip ── */}
              <div className="scaffold-stat-grid" data-testid="stat-strip">
                <div className="scaffold-stat-row">
                  <span className="scaffold-stat-row-label">Scaffolds</span>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val" data-testid="stat-samples">{summary.length}</span>
                    <span className="scaffold-stat-label">samples</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{scaffoldStats?.min ?? '—'}</span>
                    <span
                      className="scaffold-stat-label"
                      title={scaffoldStats
                        ? `${scaffoldStats.min} on ${fmtDate(scaffoldStats.minDate)} ${fmtTime(scaffoldStats.minDate)}`
                        : undefined}
                    >
                      min
                    </span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{scaffoldStats?.mean ?? '—'}</span>
                    <span className="scaffold-stat-label">mean</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val" data-testid="stat-peak-scaffolds">{scaffoldStats?.max ?? '—'}</span>
                    <span
                      className="scaffold-stat-label"
                      title={scaffoldStats
                        ? `${scaffoldStats.max} on ${fmtDate(scaffoldStats.maxDate)} ${fmtTime(scaffoldStats.maxDate)}`
                        : undefined}
                    >
                      max
                    </span>
                  </div>
                </div>
                <div className="scaffold-stat-row">
                  <span className="scaffold-stat-row-label">Genes</span>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{summary.length}</span>
                    <span className="scaffold-stat-label">samples</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{geneStats?.min ?? '—'}</span>
                    <span
                      className="scaffold-stat-label"
                      title={geneStats
                        ? `${geneStats.min} on ${fmtDate(geneStats.minDate)} ${fmtTime(geneStats.minDate)}`
                        : undefined}
                    >
                      min
                    </span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val">{geneStats?.mean ?? '—'}</span>
                    <span className="scaffold-stat-label">mean</span>
                  </div>
                  <div className="scaffold-stat">
                    <span className="scaffold-stat-val" data-testid="stat-peak-genes">{geneStats?.max ?? '—'}</span>
                    <span
                      className="scaffold-stat-label"
                      title={geneStats
                        ? `${geneStats.max} on ${fmtDate(geneStats.maxDate)} ${fmtTime(geneStats.maxDate)}`
                        : undefined}
                    >
                      max
                    </span>
                  </div>
                </div>
              </div>

              {/* ── Chart zone ── */}
              <div className="scaffold-chart-zone" data-testid="chart-zone">
                <div className="scaffold-chart-header">
                  {/* Left group: show/hide toggle */}
                  <div style={{ display: 'flex', gap: 6, alignItems: 'center' }}>
                    <button
                      data-testid="chart-toggle"
                      className={`toggle-pill sm ${showChart ? 'on' : ''}`}
                      onClick={() => setShowChart(s => !s)}
                    >
                      {showChart ? '▲ Hide chart' : '▼ Show chart'}
                    </button>
                  </div>

                  {/* Right group: metric selector | chart type label */}
                  {showChart && (
                    <div data-testid="chart-content" style={{
                      display:    'flex',
                      gap:        6,
                      alignItems: 'center',
                    }}>
                      {/* Metric — what data is shown */}
                      <span style={{
                        font:  '400 10px var(--mono)',
                        color: 'var(--text-dim)',
                      }}>
                        Show:
                      </span>
                      <button
                        data-testid="metric-scaffolds"
                        className={`toggle-pill sm ${chartMetric === 'scaffold_count' ? 'on' : ''}`}
                        onClick={() => setChartMetric('scaffold_count')}
                        title="Plot scaffold count over time"
                      >
                        Scaffolds
                      </button>
                      <button
                        data-testid="metric-genes"
                        className={`toggle-pill sm ${chartMetric === 'gene_count' ? 'on' : ''}`}
                        onClick={() => setChartMetric('gene_count')}
                        title="Plot gene count over time"
                      >
                        Genes
                      </button>

                      {/* Divider */}
                      <span style={{
                        color:   'var(--border-l)',
                        fontSize: 14,
                        margin:  '0 2px',
                      }}>
                        |
                      </span>

                      {/* Chart type — always line for now, kept as label for clarity */}
                      <span
                        data-testid="chart-metric-label"
                        style={{
                          font:  '400 10px var(--mono)',
                          color: 'var(--text-dim)',
                        }}
                      >
                        {chartMetric === 'scaffold_count' ? 'Scaffold count over time' : 'Gene count over time'}
                      </span>
                    </div>
                  )}
                </div>

                {showChart && (
                  <Plot
                    // eslint-disable-next-line @typescript-eslint/no-explicit-any
                    data={[{
                      type: 'scatter', mode: 'lines+markers',
                      x: chartData.map(r => new Date(parseDateTime(r.date)).toISOString()),
                      y: chartData.map(r =>
                        chartMetric === 'scaffold_count' ? r.scaffold_count : r.gene_count
                      ),
                      line:   { color: resolveCssVar('var(--chart-1)', '#4f8ef7'), width: 2 },
                      marker: { color: resolveCssVar('var(--chart-1)', '#4f8ef7'), size: 4 },
                      connectgaps: false,
                      customdata: chartData.map(r => `${fmtDate(r.date)} ${fmtTime(r.date)}`),
                      hovertemplate:
                        '<b>%{customdata}</b><br>' +
                        (chartMetric === 'scaffold_count' ? 'Scaffolds' : 'Genes') +
                        ': %{y}<extra></extra>',
                    } as any]}
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
                            ? 'Scaffold count (per sample)'
                            : 'Gene count (per sample)',
                          font: { size: 10, family: 'monospace' },
                        },
                        tickfont:  { size: 10, family: 'monospace' },
                        gridcolor: '#d9d9d9',
                        zeroline:  false,
                      },
                    } as any}
                    style={{ width: '100%' }}
                    useResizeHandler
                    config={{ displayModeBar: false, displaylogo: false }}
                  />
                )}
              </div>

              {/* ── Summary table with drill-down ── */}
              <div style={{ overflowX: 'auto' }}>
                <table className="mappings-table scaffold-summary-table" data-testid="summary-table">
                  <thead>
                    <tr>
                      <SortTh col="date"           label="Date"      />
                      <th>Time</th>
                      <SortTh col="scaffold_count" label="Scaffolds" />
                      <SortTh col="gene_count"     label="Genes"     />
                      <th style={{ width: 32 }} />
                    </tr>
                  </thead>
                  <tbody>
                    {sorted.map(row => {
                      const isExpanded    = expandedSample === row.sample
                      const visibleDetail = detailShowAll
                        ? detailRows
                        : detailRows.slice(0, DETAIL_PAGE)

                      return (
                        <React.Fragment key={row.sample}>
                          <tr
                            data-testid={`row-${row.sample}`}
                            className={`scaffold-summary-row ${isExpanded ? 'expanded' : ''}`}
                            onClick={() => loadDetail(row.sample)}
                          >
                            <td
                              data-testid={`date-${row.sample}`}
                              style={{
                                fontFamily: 'var(--mono)',
                                fontSize:   12,
                                whiteSpace: 'nowrap',
                              }}>
                              {fmtDate(row.date) || '—'}
                            </td>
                            <td style={{
                              fontFamily: 'var(--mono)',
                              fontSize:   12,
                              whiteSpace: 'nowrap',
                            }}>
                              {fmtTime(row.date) || '—'}
                            </td>
                            <td data-testid={`scaffolds-${row.sample}`} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                              {row.scaffold_count}
                            </td>
                            <td data-testid={`genes-${row.sample}`} style={{ fontFamily: 'var(--mono)', fontSize: 12 }}>
                              {row.gene_count}
                            </td>
                            <td style={{
                              textAlign: 'center',
                              color:     'var(--text-dim)',
                              fontSize:  10,
                            }}>
                              {isExpanded ? '▲' : '▼'}
                            </td>
                          </tr>

                          {/* ── Drill-down: individual scaffold names ── */}
                          {isExpanded && (
                            <tr className="scaffold-detail-row" data-testid={`detail-${row.sample}`}>
                              <td colSpan={5} style={{ padding: 0 }}>
                                <div className="scaffold-detail-inner expand-anim">
                                  {detailStatus === 'loading' && (
                                    <div style={{
                                      padding:    '12px 16px',
                                      font:       '12px var(--mono)',
                                      color:      'var(--text-dim)',
                                    }}>
                                      Loading scaffolds…
                                    </div>
                                  )}
                                  {detailStatus === 'ok' && detailRows.length === 0 && (
                                    <div style={{
                                      padding: '12px 16px',
                                      font:    '12px var(--mono)',
                                      color:   'var(--text-dim)',
                                    }}>
                                      No individual scaffolds found.
                                    </div>
                                  )}
                                  {detailStatus === 'ok' && detailRows.length > 0 && (
                                    <>
                                      <div className="scaffold-detail-label">
                                        {detailRows.length} scaffold
                                        {detailRows.length !== 1 ? 's' : ''} in this sample
                                      </div>
                                      <table className="scaffold-detail-table">
                                        <thead>
                                          <tr>
                                            <th>Scaffold</th>
                                            <th>Gene count</th>
                                          </tr>
                                        </thead>
                                        <tbody>
                                          {visibleDetail.map((d, i) => (
                                            <tr key={i}>
                                              <td style={{
                                                fontFamily: 'var(--mono)',
                                                fontSize:   11,
                                                wordBreak:  'break-all',
                                              }}>
                                                {d.scaffold}
                                              </td>
                                              <td style={{
                                                fontFamily: 'var(--mono)',
                                                fontSize:   11,
                                                textAlign:  'right',
                                              }}>
                                                {d.count}
                                              </td>
                                            </tr>
                                          ))}
                                        </tbody>
                                      </table>
                                      {detailRows.length > DETAIL_PAGE && !detailShowAll && (
                                        <button
                                          className="scaffold-show-more"
                                          onClick={e => {
                                            e.stopPropagation()
                                            setDetailShowAll(true)
                                          }}
                                        >
                                          Show all {detailRows.length} scaffolds ↓
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
            </>
          )}
        </div>
      </div>
    </div>
  )
}
