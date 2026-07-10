// @ts-expect-error plotly.js-dist-min ships no .d.ts; types from @types/plotly.js
import PlotlyBase from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'
import React, { useState, useRef, useMemo } from 'react'

import type { AnnotationItem, ChartMetric } from '../../types'
import { extractEgc, extractNormEgc } from '../../utils/stats'
import { applyZScore, applyLowess } from '../../utils/signal'
import {
  isoDate, fmtDate, parseDateTime, computeDayBands, toPlotlyDate,
} from '../../utils/format'
import { computeNightBands, alignTideToChartPoints } from '../../utils/solar'
import { useSolarTideData } from '../../utils/useSolarTideData'
import { downloadCsv } from '../../utils/api'
import { PLOTLY_HOVERLABEL } from '../../utils/chartTheme'
import { StatsPanel }   from '../ui/StatsPanel'
import { HelpTooltip } from '../ui/HelpTooltip'
import { ChartControls } from './ChartControls'
import { ScaffoldBtn }   from '../scaffolds/ScaffoldBtn'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = createPlotlyComponent(PlotlyBase as any)

function resolveCssVar(value: string, fallback: string): string {
  if (typeof document === 'undefined' || !value.startsWith('var(')) return value
  const name = value.slice(4, -1).trim()
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

// Wong CB-safe colors for additional grouped series (after the first, which gets --chart-group)
const CB_EXTRA_GROUPS = ['#E69F00', '#56B4E9', '#D55E00', '#CC79A7', '#0072B2', '#009E73']

type SeriesEntry = {
  annotationId: string
  name:         string | null
  data:         AnnotationItem[]
  color:        string
  source:       string
  isGrouped?:   boolean
}

export function MultiEgcChart({
  series,
  dateFrom,
  dateTo,
  dataDateRange: _dataDateRange,
  onGoScaffoldExplore,
  title,
}: {
  series:               SeriesEntry[]
  dateFrom:             string
  dateTo:               string
  dataDateRange?:       { min: string; max: string } | null
  onGoScaffoldExplore?: (annotationId: string, source: string) => void
  title?:               string
}) {
  const [metric, setMetric]                   = useState<ChartMetric>('egc')
  const [standardize, setStandardize]         = useState(false)
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.05)
  const [showStats, setShowStats]             = useState(false)
  const [showNightShading, setShowNightShading] = useState(false)
  const [showTide, setShowTide]                 = useState(false)
  const [showDayBands, setShowDayBands]         = useState(false)
  const plotDivRef = useRef<HTMLDivElement | null>(null)

  // Resolve at render time so the value follows theme switches.
  const groupColor = resolveCssVar('var(--chart-group)', '#222222')

  const { sunTimes, tides, tidesLoading, tidesError } =
    useSolarTideData(showNightShading || showTide)

  // Wide-format row: one row per datetime, each series has its own column.
  type ChartRow = { date: string; _dt: string; _ts: number } & Record<string, number | null | string>

  const baseRows = useMemo<ChartRow[]>(() => {
    const dtMap: Record<string, ChartRow> = {}
    for (const s of series) {
      for (const d of s.data) {
        const iso = isoDate(d.timepoint?.datetime ?? '')
        if (dateFrom && iso < dateFrom) continue
        if (dateTo   && iso > dateTo)   continue
        const dt = d.timepoint?.datetime ?? ''
        if (!dtMap[dt]) dtMap[dt] = { date: fmtDate(dt), _dt: dt, _ts: parseDateTime(dt) }
        dtMap[dt][s.annotationId]            = extractEgc(d.value)
        dtMap[dt][s.annotationId + '__norm'] = extractNormEgc(d.value)
      }
    }
    return Object.values(dtMap).sort((a, b) => a._ts - b._ts)
  }, [series, dateFrom, dateTo])

  const chartDataRaw = useMemo<ChartRow[]>(() => {
    if (metric === 'egc' && !standardize && !smoothed) return baseRows
    let rows = baseRows
    for (const s of series) {
      let processed: { egc: number | null; datetime?: string }[]
      if (metric === 'norm_egc') {
        processed = rows.map(row => ({
          egc:      (row[s.annotationId + '__norm'] as number | null) ?? null,
          datetime: row._dt,
        }))
      } else {
        processed = rows.map(row => ({
          egc:      (row[s.annotationId] as number | null) ?? null,
          datetime: row._dt,
        }))
      }
      if (standardize) processed = applyZScore(processed)
      if (smoothed) processed = applyLowess(processed, smoothBandwidth)
      rows = rows.map((row, i) => ({ ...row, [s.annotationId]: processed[i].egc }))
    }
    return rows
  }, [baseRows, metric, standardize, smoothed, smoothBandwidth, series])

  const chartData = useMemo<ChartRow[]>(() => {
    if (!showTide || !tides || tides.length === 0) {
      return chartDataRaw.map(r => ({ ...r, tide_wl: null }))
    }
    const aligned = alignTideToChartPoints(chartDataRaw.map(r => r._dt), tides)
    return chartDataRaw.map(r => ({ ...r, tide_wl: aligned.get(r._dt) ?? null }))
  }, [chartDataRaw, showTide, tides])

  const dayBandsList = useMemo(
    () => showDayBands ? computeDayBands(chartData.map(r => ({ datetime: r._dt as string }))) : [],
    [showDayBands, chartData],
  )

  const nightBands = useMemo(
    () => showNightShading && sunTimes
      ? computeNightBands(chartData.map(r => ({ datetime: r._dt as string })), sunTimes)
      : [],
    [showNightShading, sunTimes, chartData],
  )

  const allVals = useMemo(() => {
    const out: number[] = []
    for (const s of series) {
      for (const row of chartData) {
        const v = row[s.annotationId]
        if (typeof v === 'number') out.push(v)
      }
    }
    return out
  }, [chartData, series])

  const scaleMismatch = useMemo(() => {
    // Suppressed once either metric or standardize moves off its raw default —
    // Relative Abundance and Z-score both resolve cross-series scale mismatch.
    if (metric !== 'egc' || standardize) return false
    const means = series
      .map(s => {
        const vals = s.data
          .map(d => extractEgc(d.value))
          .filter((v): v is number => v !== null)
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
      })
      .filter(m => m > 0)
    if (means.length < 2) return false
    return Math.max(...means) / Math.min(...means) > 10
  }, [series, metric, standardize])

  const yLabel = metric === 'norm_egc'
    ? (standardize ? 'Relative Abundance (Z-score, σ from mean)' : 'Relative Abundance')
    : (standardize ? 'Z-score (σ from mean)' : 'EGC')

  // ── Shapes: night/day bands positioned by real timestamps ─────────────────
  const shapes = useMemo(() => {
    const out: object[] = []
    for (const band of dayBandsList) {
      if (!band.shade) continue
      out.push({
        type: 'rect', xref: 'x', yref: 'paper',
        x0: toPlotlyDate(band.x1Ts),
        x1: toPlotlyDate(band.x2Ts),
        y0: 0, y1: 1,
        fillcolor: 'rgba(0,0,0,0.035)',
        line: { width: 0 },
        layer: 'below',
      })
    }
    for (const band of nightBands) {
      out.push({
        type: 'rect', xref: 'x', yref: 'paper',
        x0: toPlotlyDate(band.x1Ts),
        x1: toPlotlyDate(band.x2Ts),
        y0: 0, y1: 1,
        fillcolor: 'rgba(0,0,0,0.14)',
        line: { width: 0 },
        layer: 'below',
      })
    }
    return out
  }, [dayBandsList, nightBands])

  // ── Traces ────────────────────────────────────────────────────────────────
  const plotData = useMemo(() => {
    const fmtVal = (v: number | null) => {
      if (v === null) return '--'
      if (standardize)          return v.toFixed(3) + 'σ'
      if (metric === 'norm_egc') return (v * 100).toFixed(3) + '%'
      return v.toExponential(3)
    }

    const hasGroup = series.some(s => s.isGrouped)
    const groupedSeries = series.filter(s => s.isGrouped)
    const xs = chartData.map(r => toPlotlyDate(r._ts))

    const traces: object[] = series.map(s => {
      const sw      = hasGroup ? (s.isGrouped ? 3.5 : 1.5) : 2
      const opacity = hasGroup ? (s.isGrouped ? 1   : 0.45) : 1
      const ys      = chartData.map(r => (r[s.annotationId] as number | null) ?? null)

      // Grouped series: first gets the theme's near-black/neutral, extras cycle CB palette.
      let traceColor = s.color
      if (s.isGrouped) {
        const gIdx = groupedSeries.findIndex(g => g.annotationId === s.annotationId)
        traceColor = gIdx === 0 ? groupColor : CB_EXTRA_GROUPS[(gIdx - 1) % CB_EXTRA_GROUPS.length]
      }

      return {
        type: 'scatter', mode: 'lines+markers',
        x: xs,
        y: ys,
        line:    { color: traceColor, width: sw },
        marker:  { color: traceColor, size: s.isGrouped ? 5 : 3, opacity },
        opacity,
        name: s.annotationId,
        yaxis: 'y',
        connectgaps: true,
        customdata: chartData.map((r, i) => [fmtVal(ys[i]), r._dt]),
        hovertemplate:
          '<b>%{customdata[1]}</b><br>' +
          s.annotationId + ': %{customdata[0]}' +
          '<extra></extra>',
      }
    })

    if (showTide) {
      traces.push({
        type: 'scatter', mode: 'lines',
        x: xs,
        y: chartData.map(r => (r.tide_wl as number | null) ?? null),
        fill: 'tozeroy', fillcolor: 'rgba(0,160,160,0.12)',
        line: { color: 'rgba(0,160,160,0.55)', width: 1.5 },
        name: 'Tide (m)', yaxis: 'y2',
        connectgaps: false,
        hovertemplate: 'Tide: %{y:.2f} m<extra></extra>',
      })
    }

    return traces
  }, [chartData, series, showTide, metric, standardize, groupColor])

  // ── Layout ────────────────────────────────────────────────────────────────
  const layout = useMemo(() => {
    const base: Record<string, unknown> = {
      height: 340,
      margin: { t: 10, r: showTide ? 70 : 20, b: 30, l: 80 },
      paper_bgcolor: 'transparent',
      plot_bgcolor:  'transparent',
      showlegend: false,
      hovermode: 'x unified',
      hoverlabel: PLOTLY_HOVERLABEL,
      shapes,
      xaxis: {
        type: 'date',
        tickfont:    { size: 11, family: 'monospace' },
        tickangle:   -40,
        showgrid:    false,
        linecolor:   '#d9d9d9',
        rangeslider: { visible: true, thickness: 0.06, bgcolor: 'rgba(0,0,0,0.02)' },
      },
      yaxis: {
        title:    { text: yLabel, font: { size: 10, family: 'monospace' } },
        tickfont: { size: 11, family: 'monospace' },
        gridcolor: '#d9d9d9',
        zeroline:  false,
      },
    }
    if (showTide) {
      base.yaxis2 = {
        title:      { text: 'Tide (m)', font: { size: 10, family: 'monospace', color: 'rgb(0,160,160)' } },
        overlaying: 'y', side: 'right',
        tickfont:   { size: 10, family: 'monospace', color: 'rgb(0,160,160)' },
        zeroline: false, showgrid: false,
      }
    }
    return base
  }, [showTide, shapes, yLabel])

  // ── Export handlers ───────────────────────────────────────────────────────
  const handleExportPng = async () => {
    if (!plotDivRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = await (PlotlyBase as any).toImage(plotDivRef.current, {
      format: 'png', scale: 2, width: plotDivRef.current.offsetWidth,
    })
    const a = document.createElement('a')
    a.href = url; a.download = 'compare_egc.png'; a.click()
  }

  const handleExportSvg = async () => {
    if (!plotDivRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = await (PlotlyBase as any).toImage(plotDivRef.current, { format: 'svg' })
    const a = document.createElement('a')
    a.href = url; a.download = 'compare_egc.svg'; a.click()
  }

  const handleExportCsv = () => {
    const rows: Record<string, unknown>[] = []
    for (const row of chartData) {
      for (const s of series) {
        const val = row[s.annotationId]
        if (val !== null && val !== undefined) {
          rows.push({
            annotation_id:  s.annotationId,
            source:         s.source ?? '',
            date:           row._dt ?? row.date,
            egc_normalized: val,
            metric,
            standardized:   standardize,
            ...(showTide ? { tide_predicted_wl_m: row.tide_wl ?? null } : {}),
          })
        }
      }
    }
    downloadCsv(rows, `compare_egc_${metric}${standardize ? '_zscore' : ''}.csv`)
  }

  if (chartData.length === 0) {
    return (
      <div className="state-box">
        <div className="state-icon">〰</div>
        <span>No EGC data in range.</span>
      </div>
    )
  }

  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <div className="chart-card-title">
          {title ?? `${yLabel} — ${series.length} Annotations`}
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button
            className={`toggle-pill sm ${showStats ? 'on' : ''}`}
            onClick={() => setShowStats(s => !s)}
          >
            Σ Stats
          </button>
          <button className="btn sm" onClick={handleExportPng}>↓ PNG</button>
          <button className="btn sm" onClick={handleExportSvg}>↓ SVG</button>
          <button className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
          <div className="chart-legend">
            {series.map(s => (
              <div className="legend-item" key={s.annotationId}>
                <div className="legend-dot" style={{ background: s.color }} />
                <span title={s.name ?? s.annotationId}>{s.annotationId}</span>
                <ScaffoldBtn
                  annotationId={s.annotationId}
                  source={s.source}
                  onGoExplore={onGoScaffoldExplore}
                />
              </div>
            ))}
          </div>
        </div>
      </div>

      {showStats && <StatsPanel vals={allVals} yLabel={yLabel} />}

      {scaleMismatch && (
        <div className="scale-mismatch-warning" style={{
          padding:      '6px 12px',
          marginBottom: 8,
          borderRadius: 5,
          background:   'rgba(245,188,48,.12)',
          border:       '1px solid rgba(245,188,48,.3)',
          font:         '12px var(--mono)',
          color:        'var(--amber)',
        }}>
          ⚠ Series have very different EGC scales.
          Use <strong>Z-score</strong> normalize for trend comparison.
          <HelpTooltip text="Series have very different value ranges — try Z-score normalize so they're comparable on one chart." />
        </div>
      )}

      <ChartControls
        metric={metric}
        onMetric={setMetric}
        standardize={standardize}
        onStandardize={setStandardize}
        smoothed={smoothed}
        onSmooth={setSmoothed}
        smoothBandwidth={smoothBandwidth}
        onSmoothBandwidth={setSmoothBandwidth}
        showNightShading={showNightShading}
        onShowNightShading={setShowNightShading}
        showTide={showTide}
        onShowTide={setShowTide}
        showDayBands={showDayBands}
        onShowDayBands={setShowDayBands}
      />

      {showTide && tidesError && (
        <div style={{
          padding: '6px 12px', marginBottom: 8, borderRadius: 5,
          background: 'rgba(240,112,96,.1)', border: '1px solid rgba(240,112,96,.3)',
          font: '12px var(--mono)', color: 'var(--coral)',
        }}>
          ⚠ Tide data unavailable — showing series only.
        </div>
      )}

      {(showNightShading || showTide || showDayBands) && (
        <div className="chart-overlay-legend">
          {showNightShading && (
            <div className="ol-item">
              <div className="ol-swatch night" />
              <span>Night (sunset–sunrise, Rosario)</span>
            </div>
          )}
          {showTide && !tidesLoading && !tidesError && (
            <div className="ol-item">
              <div className="ol-swatch tide" />
              <span>Predicted tide, meters (right axis)</span>
            </div>
          )}
          {showDayBands && (
            <div className="ol-item">
              <div className="ol-swatch night" />
              <span>Alternating calendar days</span>
            </div>
          )}
        </div>
      )}

      <Plot
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        data={plotData as any}
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        layout={layout as any}
        style={{ width: '100%' }}
        useResizeHandler
        onInitialized={(_, graphDiv) => { plotDivRef.current = graphDiv as HTMLDivElement }}
        onUpdate={(_, graphDiv) => { plotDivRef.current = graphDiv as HTMLDivElement }}
        config={{ displayModeBar: false, displaylogo: false }}
      />
    </div>
  )
}

