// @ts-expect-error plotly.js-dist-min ships no .d.ts; types from @types/plotly.js
import PlotlyBase from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'
import { useState, useRef, useMemo } from 'react'

import type { AnnotationItem, ChartMetric } from '../../types'
import { extractEgc, extractNormEgc } from '../../utils/stats'
import { applyZScore, applyLowess } from '../../utils/signal'
import {
  isoDate, fmtDate, parseDateTime, computeDayBands, toPlotlyDate,
  formatRelativeAbundancePercent,
} from '../../utils/format'
import { computeNightBands, alignTideToChartPoints } from '../../utils/solar'
import { useSolarTideData } from '../../utils/useSolarTideData'
import { downloadCsv } from '../../utils/api'
import { PLOTLY_HOVERLABEL } from '../../utils/chartTheme'
import { taxonomyAwarePrimaryLabel } from '../../constants'
import { StatsPanel }   from '../ui/StatsPanel'
import { HelpTooltip } from '../ui/HelpTooltip'
import { ChartControls } from './ChartControls'
import { ScaffoldBtn }   from '../scaffolds/ScaffoldBtn'
import { HierarchyBtn }  from '../hierarchy/HierarchyBtn'

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
  // W26 (docs/AUDIT-2026-09-22.md): `id` is the ONLY field used to key rows
  // internally (dtMap/chartData columns, CSV lookups, React list keys) --
  // it must be genuinely unique per series. `annotationId` is display-only
  // (shown in the legend, hover text, trace name) and is NOT guaranteed
  // unique: for a grouped series it's the user-typed label (e.g. "iron
  // (2)"), and two different groups can easily share that same label while
  // summing completely different, unrelated members. Before this field
  // existed, `annotationId` was used for both roles, so two same-labeled
  // groups silently overwrote each other's data at every shared datetime
  // (confirmed live: grouping 2 kegg hits vs. 2 cog hits both labelled
  // "iron (2)" made the CSV export read the cog group's sum, 170000, for
  // BOTH rows).
  id:           string
  annotationId: string
  name:         string | null
  data:         AnnotationItem[]
  color:        string
  source:       string
  isGrouped?:   boolean
  scaffoldsDisabled?: boolean
}

// buildMultiEgcCsvRows
// Exported so tests can exercise the real CSV row shape directly (W18).
// The value column is named from the active metric (was hardcoded
// "egc_normalized" even in raw egc mode), with metric/standardized/smoothed
// recorded on every row.
export function buildMultiEgcCsvRows(
  chartData:   Record<string, unknown>[],
  series:      { id: string; annotationId: string; source?: string }[],
  metric:      ChartMetric,
  standardize: boolean,
  smoothed:    boolean,
  showTide:    boolean,
): Record<string, unknown>[] {
  const rows: Record<string, unknown>[] = []
  for (const row of chartData) {
    for (const s of series) {
      const val = row[s.id]
      if (val !== null && val !== undefined) {
        rows.push({
          annotation_id: s.annotationId,
          source:        s.source ?? '',
          date:          row._dt ?? row.date,
          [metric]:      val,
          metric,
          standardized:  standardize,
          smoothed,
          ...(showTide ? { tide_predicted_wl_m: row.tide_wl ?? null } : {}),
        })
      }
    }
  }
  return rows
}

export function MultiEgcChart({
  series,
  dateFrom,
  dateTo,
  onGoScaffoldExplore,
  title,
  defaultStandardize = false,
}: {
  series:               SeriesEntry[]
  dateFrom:             string
  dateTo:               string
  dataDateRange?:       { min: string; max: string } | null
  onGoScaffoldExplore?: (annotationId: string, source: string) => void
  title?:               string
  // Initial Z-score state only; the user can still toggle it. Compare turns it
  // on because its whole purpose is cross-series trend comparison.
  defaultStandardize?:  boolean
}) {
  const [metric, setMetric]                   = useState<ChartMetric>('norm_egc')
  const [standardize, setStandardize]         = useState(defaultStandardize)
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.3) // W27: within the real [0.1, 0.8] slider range
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
        dtMap[dt][s.id]            = extractEgc(d.value)
        dtMap[dt][s.id + '__norm'] = extractNormEgc(d.value)
      }
    }
    return Object.values(dtMap).sort((a, b) => a._ts - b._ts)
  }, [series, dateFrom, dateTo])

  // W27 (docs/AUDIT-2026-09-22.md): unsmoothed is the metric/standardize
  // pipeline WITHOUT LOWESS -- stats (perSeriesVals below) read this, so
  // toggling Smooth never changes the reported numbers, only the drawn
  // curve. `chartDataRaw` adds smoothing per series on top of this.
  const unsmoothedRows = useMemo<ChartRow[]>(() => {
    if (metric === 'egc' && !standardize) return baseRows
    let rows = baseRows
    for (const s of series) {
      let processed: { egc: number | null; datetime?: string; ts: number }[]
      if (metric === 'norm_egc') {
        processed = rows.map(row => ({
          egc:      (row[s.id + '__norm'] as number | null) ?? null,
          datetime: row._dt,
          ts:       row._ts,
        }))
      } else {
        processed = rows.map(row => ({
          egc:      (row[s.id] as number | null) ?? null,
          datetime: row._dt,
          ts:       row._ts,
        }))
      }
      if (standardize) processed = applyZScore(processed) as typeof processed
      rows = rows.map((row, i) => ({ ...row, [s.id]: processed[i].egc }))
    }
    return rows
  }, [baseRows, metric, standardize, series])

  const chartDataRaw = useMemo<ChartRow[]>(() => {
    if (!smoothed) return unsmoothedRows
    let rows = unsmoothedRows
    for (const s of series) {
      const processed = rows.map(row => ({
        egc:      (row[s.id] as number | null) ?? null,
        datetime: row._dt,
        ts:       row._ts,
      }))
      const smoothedProcessed = applyLowess(processed, smoothBandwidth)
      rows = rows.map((row, i) => ({ ...row, [s.id]: smoothedProcessed[i].egc }))
    }
    return rows
  }, [unsmoothedRows, smoothed, smoothBandwidth, series])

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

  // W25 (docs/AUDIT-2026-09-22.md): one value array PER series, not pooled
  // into one flat array -- a pooled mean/CV describes neither series when
  // they're on genuinely different scales (e.g. mixing a 4.8e-4 series with
  // a 7.8e-6 series gave one meaningless "mean" of 2.4e-4). Label matches
  // the legend's own taxonomyAwarePrimaryLabel exactly, so a series reads
  // the same way in both places.
  //
  // W27: reads unsmoothedRows, NOT chartData -- stats must never change
  // just because Smooth is toggled, only the drawn curve should.
  const perSeriesVals = useMemo(() => {
    return series.map(s => {
      const vals: number[] = []
      for (const row of unsmoothedRows) {
        const v = row[s.id]
        if (typeof v === 'number') vals.push(v)
      }
      return { label: taxonomyAwarePrimaryLabel(s.source, s.annotationId, s.name), vals }
    })
  }, [unsmoothedRows, series])

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
        fillcolor: 'rgba(0,0,0,0.07)',
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
      if (metric === 'norm_egc') return formatRelativeAbundancePercent(v)
      return v.toExponential(3)
    }

    const hasGroup = series.some(s => s.isGrouped)
    const groupedSeries = series.filter(s => s.isGrouped)
    const xs = chartData.map(r => toPlotlyDate(r._ts))

    const traces: object[] = series.map(s => {
      const sw      = hasGroup ? (s.isGrouped ? 3.5 : 1.5) : 2
      const opacity = hasGroup ? (s.isGrouped ? 1   : 0.45) : 1
      const ys      = chartData.map(r => (r[s.id] as number | null) ?? null)

      // Grouped series: first gets the theme's near-black/neutral, extras cycle CB palette.
      let traceColor = s.color
      if (s.isGrouped) {
        const gIdx = groupedSeries.findIndex(g => g.id === s.id)
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
          // W27: discloses when the hovered value is a fitted LOWESS
          // curve, not the real sample value -- previously indistinguishable.
          s.annotationId + (smoothed ? ' (smoothed)' : '') + ': %{customdata[0]}' +
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
  }, [chartData, series, showTide, metric, standardize, groupColor, smoothed])

  // ── Layout ────────────────────────────────────────────────────────────────
  const layout = useMemo(() => {
    const gridColor = resolveCssVar('var(--border-l)', '#d9d9d9')
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
        linecolor:   gridColor,
        rangeslider: { visible: true, thickness: 0.06, bgcolor: 'rgba(0,0,0,0.02)' },
      },
      yaxis: {
        title:    { text: yLabel, font: { size: 10, family: 'monospace' } },
        tickfont: { size: 11, family: 'monospace' },
        gridcolor: gridColor,
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

  const handleExportCsv = () => downloadCsv(
    buildMultiEgcCsvRows(chartData, series, metric, standardize, smoothed, showTide),
    `compare_egc_${metric}${standardize ? '_zscore' : ''}.csv`,
  )

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
              <div className="legend-item" key={s.id}>
                <div className="legend-dot" style={{ background: s.color }} />
                <span
                  title={s.annotationId}
                  style={s.source === 'taxonomy' ? { fontStyle: 'italic' } : undefined}
                >
                  {taxonomyAwarePrimaryLabel(s.source, s.annotationId, s.name)}
                </span>
                {!s.scaffoldsDisabled && (
                  <>
                    <ScaffoldBtn
                      annotationId={s.annotationId}
                      source={s.source}
                      name={s.name}
                      onGoExplore={onGoScaffoldExplore}
                    />
                    <HierarchyBtn
                      annotationId={s.annotationId}
                      source={s.source}
                      name={s.name}
                    />
                  </>
                )}
              </div>
            ))}
          </div>
        </div>
      </div>

      {showStats && <StatsPanel series={perSeriesVals} yLabel={yLabel} standardize={standardize} />}

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

