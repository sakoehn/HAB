// @ts-expect-error plotly.js-dist-min ships no .d.ts; types from @types/plotly.js
import PlotlyBase from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'
import { useState, useRef, useMemo } from 'react'

import type { AnnotationItem, ChartMetric } from '../../types'
import { extractEgc, extractNormEgc } from '../../utils/stats'
import { applyZScore, applyLowess } from '../../utils/signal'
import {
  parseDateTime, fmtDate, isoDate, computeDayBands, toPlotlyDate,
} from '../../utils/format'
import { computeNightBands, alignTideToChartPoints } from '../../utils/solar'
import { useSolarTideData } from '../../utils/useSolarTideData'
import { downloadCsv } from '../../utils/api'
import { PLOTLY_HOVERLABEL } from '../../utils/chartTheme'
import { StatsPanel }    from '../ui/StatsPanel'
import { DateRangePicker } from '../ui/DateRangePicker'
import { ChartControls }  from './ChartControls'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = createPlotlyComponent(PlotlyBase as any)

function resolveCssVar(value: string, fallback: string): string {
  if (typeof document === 'undefined' || !value.startsWith('var(')) return value
  const name = value.slice(4, -1).trim()
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

type SeriesEntry = {
  annotationId: string
  name:         string | null
  data:         AnnotationItem[]
  color:        string
}

// buildGroupedEgcCsvRows
// Exported so tests can exercise the real CSV row shape directly (W18).
// The value column is named from the active metric, with metric/
// standardized/smoothed recorded on every row -- was hardcoded "egc" with
// no record of which transform (metric swap, z-score, LOWESS smoothing)
// was applied.
export function buildGroupedEgcCsvRows(
  points:      { datetime: string; egc: number | null; tide_wl?: number | null }[],
  groupLabel:  string,
  metric:      ChartMetric,
  standardize: boolean,
  smoothed:    boolean,
  showTide:    boolean,
): Record<string, unknown>[] {
  return points.map(d => ({
    group:        groupLabel,
    date:         d.datetime,
    [metric]:     d.egc,
    metric,
    standardized: standardize,
    smoothed,
    ...(showTide ? { tide_predicted_wl_m: d.tide_wl } : {}),
  }))
}

export function GroupedEgcChart({
  allSeries,
  groupLabel,
  dataDateRange,
}: {
  allSeries:      SeriesEntry[]
  groupLabel:     string
  dataDateRange?: { min: string; max: string } | null
}) {
  const [metric, setMetric]                   = useState<ChartMetric>('norm_egc')
  const [standardize, setStandardize]         = useState(false)
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.05)
  const [dateFrom, setDateFrom]               = useState('')
  const [dateTo, setDateTo]                   = useState('')
  const [showNightShading, setShowNightShading] = useState(false)
  const [showTide, setShowTide]                 = useState(false)
  const [showDayBands, setShowDayBands]         = useState(false)
  const plotDivRef = useRef<HTMLDivElement | null>(null)

  const { sunTimes, tides, tidesLoading, tidesError } =
    useSolarTideData(showNightShading || showTide)

  const summedPoints = useMemo(() => {
    // When metric is norm_egc, sum norm_egc (egc / total_sample_depth) per
    // datetime for true depth-normalised group abundance. Otherwise sum raw egc.
    const useNormEgc = metric === 'norm_egc'
    const dtMap: Record<string, { egc: number; datetime: string; iso: string }> = {}
    for (const s of allSeries) {
      for (const d of s.data) {
        if (!d.timepoint?.datetime) continue
        const iso = isoDate(d.timepoint.datetime)
        if (dateFrom && iso < dateFrom) continue
        if (dateTo   && iso > dateTo)   continue
        const val = useNormEgc ? extractNormEgc(d.value) : extractEgc(d.value)
        if (val === null) continue
        const dt = d.timepoint.datetime
        if (!dtMap[dt]) dtMap[dt] = { egc: 0, datetime: dt, iso }
        dtMap[dt].egc += val
      }
    }
    return Object.values(dtMap)
      .sort((a, b) => parseDateTime(a.datetime) - parseDateTime(b.datetime))
      .map(({ egc, datetime }) => ({
        date:     fmtDate(datetime),
        egc,
        datetime,
        ts:       parseDateTime(datetime),
      }))
  }, [allSeries, dateFrom, dateTo, metric])

  const processedPointsRaw = useMemo(() => {
    // The metric swap is handled upstream in summedPoints so it is absent here.
    let pts = summedPoints as { egc: number | null; datetime: string; ts: number; date: string }[]
    if (standardize) pts = applyZScore(pts) as typeof pts
    if (smoothed) pts = applyLowess(pts, smoothBandwidth) as typeof pts
    return pts
  }, [summedPoints, standardize, smoothed, smoothBandwidth])

  const processedPoints = useMemo(() => {
    if (!showTide || !tides || tides.length === 0) {
      return processedPointsRaw.map(p => ({ ...p, tide_wl: null as number | null }))
    }
    const aligned = alignTideToChartPoints(processedPointsRaw.map(p => p.datetime), tides)
    return processedPointsRaw.map(p => ({
      ...p,
      tide_wl: aligned.get(p.datetime) ?? null,
    }))
  }, [processedPointsRaw, showTide, tides])

  const egcVals = useMemo(
    () => processedPoints.map(d => d.egc).filter((v): v is number => v !== null),
    [processedPoints],
  )

  const dayBandsList = useMemo(
    () => showDayBands
      ? computeDayBands(processedPoints.map(p => ({ datetime: p.datetime })))
      : [],
    [showDayBands, processedPoints],
  )

  const nightBands = useMemo(
    () => showNightShading && sunTimes
      ? computeNightBands(processedPoints.map(p => ({ datetime: p.datetime })), sunTimes)
      : [],
    [showNightShading, sunTimes, processedPoints],
  )

  const yLabel = metric === 'norm_egc'
    ? (standardize ? 'Summed Relative Abundance (Z-score)' : 'Summed Relative Abundance')
    : (standardize ? 'Summed EGC (Z-score)' : 'Summed EGC')

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
  const lineColor = resolveCssVar('var(--chart-group)', '#222222')

  const plotData = useMemo(() => {
    const fmtVal = (v: number | null) => {
      if (v === null) return '--'
      if (standardize)          return v.toFixed(3) + 'σ'
      if (metric === 'norm_egc') return (v * 100).toFixed(3) + '%'
      return v.toExponential(3)
    }
    const xs = processedPoints.map(p => toPlotlyDate(p.ts))
    const traces: object[] = [{
      type: 'scatter', mode: 'lines+markers',
      x: xs,
      y: processedPoints.map(p => p.egc),
      line:   { color: lineColor, width: 3.7 },
      marker: { color: lineColor, size: 5 },
      name: groupLabel,
      yaxis: 'y',
      connectgaps: false,
      customdata: processedPoints.map(p => [fmtVal(p.egc), p.datetime]),
      hovertemplate:
        '<b>%{customdata[1]}</b><br>' +
        yLabel + ': %{customdata[0]}' +
        '<extra></extra>',
    }]
    if (showTide) {
      traces.push({
        type: 'scatter', mode: 'lines',
        x: xs,
        y: processedPoints.map(p => p.tide_wl),
        fill: 'tozeroy', fillcolor: 'rgba(0,160,160,0.12)',
        line: { color: 'rgba(0,160,160,0.55)', width: 1.5 },
        name: 'Tide (m)', yaxis: 'y2',
        connectgaps: false,
        hovertemplate: 'Tide: %{y:.2f} m<extra></extra>',
      })
    }
    return traces
  }, [processedPoints, lineColor, groupLabel, yLabel, showTide, metric, standardize])

  // ── Layout ────────────────────────────────────────────────────────────────
  const layout = useMemo(() => {
    const gridColor = resolveCssVar('var(--border-l)', '#d9d9d9')
    const base: Record<string, unknown> = {
      height: 280,
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
    a.href = url; a.download = `${groupLabel}_grouped_egc.png`; a.click()
  }

  const handleExportSvg = async () => {
    if (!plotDivRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = await (PlotlyBase as any).toImage(plotDivRef.current, { format: 'svg' })
    const a = document.createElement('a')
    a.href = url; a.download = `${groupLabel}_grouped_egc.svg`; a.click()
  }

  const handleExportCsv = () => downloadCsv(
    buildGroupedEgcCsvRows(processedPoints, groupLabel, metric, standardize, smoothed, showTide),
    `${groupLabel}_grouped_egc.csv`,
  )

  return (
    <div className="chart-card" style={{ marginTop: 16 }}>
      <div className="chart-card-header">
        <div>
          <div className="chart-card-title">
            Grouped: &quot;{groupLabel}&quot; — {allSeries.length} annotations summed
          </div>
          <div style={{
            fontSize: 12, fontFamily: 'var(--mono)',
            color: 'var(--text-dim)', marginTop: 2,
          }}>
            {yLabel} · {processedPoints.length} timepoints
          </div>
        </div>
        <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
          <button className="btn sm" onClick={handleExportPng}>↓ PNG</button>
          <button className="btn sm" onClick={handleExportSvg}>↓ SVG</button>
          <button className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
        </div>
      </div>

      <StatsPanel vals={egcVals} yLabel={yLabel} />

      <div style={{ marginBottom: 10 }}>
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
          ⚠ Tide data unavailable — showing EGC only.
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

      {processedPoints.length === 0 ? (
        <div className="state-box"><span>No data available.</span></div>
      ) : (
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
      )}
    </div>
  )
}
