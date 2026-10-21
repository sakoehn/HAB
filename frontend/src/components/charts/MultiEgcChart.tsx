// @ts-expect-error plotly.js-dist-min ships no .d.ts; types from @types/plotly.js
import PlotlyBase from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'
import { useState, useRef, useMemo, useEffect, useCallback } from 'react'

import type { AnnotationItem, ChartMetric } from '../../types'
import { extractEgc, extractNormEgc } from '../../utils/stats'
import { applyZScore, applyLowess, canApplyZScore, canApplyLowess } from '../../utils/signal'
import {
  isoDate, fmtDate, parseDateTime, computeDayBands, toPlotlyDate,
  formatRelativeAbundancePercent,
} from '../../utils/format'
import { computeNightBands, alignTideToChartPoints, nativeTideTrace } from '../../utils/solar'
import { useSolarTideData } from '../../utils/useSolarTideData'
import { useAllSamples } from '../../utils/useAllSamples'
import { downloadCsv } from '../../utils/api'
import { PLOTLY_HOVERLABEL } from '../../utils/chartTheme'
import { primaryLabelWithCogCategory, groupSeriesColor } from '../../constants'
import { homonymHints, withHomonymHint } from '../../utils/taxonomy'
import { StatsPanel }   from '../ui/StatsPanel'
import { HelpTooltip } from '../ui/HelpTooltip'
import { ChartControls } from './ChartControls'
import { ScaffoldBtn }   from '../scaffolds/ScaffoldBtn'
import { HierarchyBtn }  from '../hierarchy/HierarchyBtn'
import { buildMultiEgcCsvRows } from './chartCsv'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = createPlotlyComponent(PlotlyBase as any)

function resolveCssVar(value: string, fallback: string): string {
  if (typeof document === 'undefined' || !value.startsWith('var(')) return value
  const name = value.slice(4, -1).trim()
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}


type SeriesEntry = {
  // `id` is the ONLY field used to key rows
  // internally (dtMap/chartData columns, CSV lookups, React list keys) --
  // it must be genuinely unique per series. `annotationId` is display-only
  // (shown in the legend, hover text, trace name) and is NOT guaranteed
  // unique: for a grouped series it's the user-typed label (e.g. "iron
  // (2)"), and two different groups can easily share that same label while
  // summing completely different, unrelated members -- keyed by label, two
  // same-labeled groups would overwrite each other's data at every shared
  // datetime.
  id:           string
  annotationId: string
  name:         string | null
  data:         AnnotationItem[]
  color:        string
  source:       string
  isGrouped?:   boolean
  scaffoldsDisabled?: boolean
}

export function MultiEgcChart({
  series,
  dateFrom,
  dateTo,
  onGoScaffoldExplore,
  title,
  defaultStandardize = false,
  onMetricChange,
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
  // Reports the active metric (initially and on every toggle) so a parent
  // can label its own numbers to match -- Compare's per-entry chip mean.
  onMetricChange?:      (metric: ChartMetric) => void
}) {
  const [metric, setMetric]                   = useState<ChartMetric>('norm_egc')
  useEffect(() => { onMetricChange?.(metric) }, [metric, onMetricChange])
  const [standardize, setStandardize]         = useState(defaultStandardize)
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.3) // within the real [0.1, 0.8] slider range
  const [showStats, setShowStats]             = useState(false)
  const [showNightShading, setShowNightShading] = useState(false)
  const [showTide, setShowTide]                 = useState(false)
  const [showDayBands, setShowDayBands]         = useState(false)
  const plotDivRef = useRef<HTMLDivElement | null>(null)

  // Resolve at render time so the value follows theme switches.
  const groupColor = resolveCssVar('var(--chart-group)', '#222222')

  const { sunTimes, tides, tidesLoading, tidesError } =
    useSolarTideData(showNightShading || showTide)
  const { allSamples } = useAllSamples()

  // Wide-format row: one row per datetime, each series has its own column.
  type ChartRow = { date: string; _dt: string; _ts: number } & Record<string, number | null | string>

  // A line must break at a non-detection, not run straight across it
  // (which would imply steady presence). So every timepoint in the full
  // real sample timeline gets a row -- a UNION with each series' own
  // detected samples, not a swap, same reasoning as EgcChart's own
  // allPoints -- and every series not detected at a timepoint gets an
  // explicit null there (an absent key would give connectgaps nothing to
  // break at).
  const baseRows = useMemo<ChartRow[]>(() => {
    const dtMap: Record<string, ChartRow> = {}
    for (const entry of allSamples ?? []) {
      const iso = isoDate(entry.datetime)
      if (dateFrom && iso < dateFrom) continue
      if (dateTo   && iso > dateTo)   continue
      const dt = entry.datetime
      if (!dtMap[dt]) dtMap[dt] = { date: fmtDate(dt), _dt: dt, _ts: parseDateTime(dt) }
    }
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
    for (const row of Object.values(dtMap)) {
      for (const s of series) {
        if (!(s.id in row)) {
          row[s.id]            = null
          row[s.id + '__norm'] = null
        }
      }
    }
    return Object.values(dtMap).sort((a, b) => a._ts - b._ts)
  }, [series, dateFrom, dateTo, allSamples])

  // unsmoothed is the metric/standardize
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

  // applyZScore is a silent no-op for a series with fewer than 2 real
  // points -- per series here, since each series is standardized
  // independently and can have a different
  // real point count (e.g. comparing a well-sampled annotation against a
  // 1-sample one). canStandardizeSeries(id) is whether THAT series'
  // Z-score actually took effect, for its own tooltip formatting;
  // standardizeApplied (chart-wide, for the shared axis label) is true
  // when at least one series qualifies -- same shared-label limitation
  // the axis title already has for mixed per-series metrics elsewhere.
  const canStandardizeSeries = useCallback(
    (id: string) => canApplyZScore(unsmoothedRows.map(r => (r[id] as number | null) ?? null)),
    [unsmoothedRows],
  )
  const standardizeApplied = standardize && series.some(s => canStandardizeSeries(s.id))

  // Same per-series reasoning as
  // canStandardizeSeries above -- applyLowess is a silent no-op for a
  // series with fewer than 3 real points, independently per series.
  const canSmoothSeries = useCallback(
    (id: string) => canApplyLowess(unsmoothedRows.map(r => (r[id] as number | null) ?? null)),
    [unsmoothedRows],
  )
  const smoothedApplied = smoothed && series.some(s => canSmoothSeries(s.id))

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

  // The VISUAL tide trace plots at its own
  // native resolution -- see nativeTideTrace's doc comment in
  // utils/solar.ts. chartData.tide_wl above still feeds CSV export.
  const nativeTide = useMemo(
    () => (showTide && tides) ? nativeTideTrace(tides, dateFrom || undefined, dateTo || undefined) : { x: [], y: [] },
    [showTide, tides, dateFrom, dateTo],
  )

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

  // One value array PER series, not pooled into one flat array -- a pooled
  // mean/CV describes neither series when they're on genuinely different
  // scales (mixing a 4.8e-4 series with a 7.8e-6 series gives one
  // meaningless "mean" of 2.4e-4). Label matches
  // the legend's own taxonomyAwarePrimaryLabel exactly, so a series reads
  // the same way in both places.
  //
  // Reads unsmoothedRows, NOT chartData -- stats must never change
  // just because Smooth is toggled, only the drawn curve should.
  // Series label, with a hint when two series are same-named taxa from
  // different lineages (see homonymHints) -- used by the legend, the
  // traces, their hover text and the stats panel alike.
  const seriesLabel = useMemo(() => {
    const hints = homonymHints(series.filter(s => !s.isGrouped).map(s => s.annotationId))
    return (s: SeriesEntry) =>
      withHomonymHint(primaryLabelWithCogCategory(s.source, s.annotationId, s.name), s.annotationId, hints)
  }, [series])

  const perSeriesVals = useMemo(() => {
    return series.map(s => {
      const vals: number[] = []
      for (const row of unsmoothedRows) {
        const v = row[s.id]
        if (typeof v === 'number') vals.push(v)
      }
      return { label: seriesLabel(s), vals }
    })
  }, [unsmoothedRows, series, seriesLabel])

  const scaleMismatch = useMemo(() => {
    // Relative Abundance divides every series by the same per-sample total,
    // so a raw-EGC scale gap between series survives it unchanged (COG0055
    // vs K02568 are ~92x apart in raw EGC and ~108x apart in Relative
    // Abundance) -- only
    // Z-score actually resolves it, by re-centering each series on its own
    // mean/SD independently.
    //
    // That resolution only genuinely
    // happens when EVERY compared series was actually standardized --
    // applyZScore silently no-ops for a series with fewer than 2 real
    // points, so if even one series in the comparison is still raw EGC,
    // the mismatch this warning exists to catch hasn't actually been
    // resolved for it. Requires `every`, not `some` (unlike the shared
    // axis label above, which only needs one series to justify the "Z-score"
    // wording at all) -- suppression here is a claim that the WHOLE
    // comparison is now safe, so it needs the stricter check.
    if (standardize && series.every(s => canStandardizeSeries(s.id))) return false
    // Respects dateFrom/dateTo like baseRows above, so the warning reflects
    // only data visible on screen -- but stays on raw EGC specifically (not
    // unsmoothedRows, which holds norm_egc once metric='norm_egc'). This
    // check is deliberately metric-independent per the note above:
    // Relative Abundance doesn't resolve a raw-EGC scale gap, so comparing
    // norm_egc values here would hide a real mismatch.
    const means = series
      .map(s => {
        const vals = s.data
          .filter(d => {
            const iso = isoDate(d.timepoint?.datetime ?? '')
            if (dateFrom && iso < dateFrom) return false
            if (dateTo   && iso > dateTo)   return false
            return true
          })
          .map(d => extractEgc(d.value))
          .filter((v): v is number => v !== null)
        return vals.length ? vals.reduce((a, b) => a + b, 0) / vals.length : 0
      })
      .filter(m => m > 0)
    if (means.length < 2) return false
    return Math.max(...means) / Math.min(...means) > 10
  }, [series, standardize, dateFrom, dateTo, canStandardizeSeries])

  const yLabel = metric === 'norm_egc'
    ? (standardizeApplied ? 'Relative Abundance (Z-score, σ from mean)' : 'Relative Abundance')
    : (standardizeApplied ? 'Z-score (σ from mean)' : 'EGC')

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

  // Resolved ONCE here and used for BOTH the Plotly trace AND the legend
  // swatch below, so the two can never disagree:
  //   (a) a non-grouped series' color is a raw CSS `var(--chart-1)` string
  //       (SOURCE_COLORS/CHART_COLORS) -- DOM/CSS resolves that, but
  //       Plotly's SVG renderer can't parse `var()` at all and silently
  //       falls back to black, so it's resolved to a real color here.
  //   (b) a grouped series' PLOTTED line is deliberately recolored to the
  //       theme's near-black/CB-safe palette (for visual hierarchy against
  //       ungrouped lines), so the legend swatch must show that color too,
  //       not the series' own original one.
  const resolvedColors = useMemo(() => {
    const groupedSeries = series.filter(s => s.isGrouped)
    const map = new Map<string, string>()
    for (const s of series) {
      if (s.isGrouped) {
        const gIdx = groupedSeries.findIndex(g => g.id === s.id)
        map.set(s.id, gIdx === 0 ? groupColor : groupSeriesColor(gIdx))
      } else {
        map.set(s.id, resolveCssVar(s.color, '#4f8ef7'))
      }
    }
    return map
  }, [series, groupColor])

  // ── Traces ────────────────────────────────────────────────────────────────
  const plotData = useMemo(() => {
    // Per-series, not the chart-wide
    // standardizeApplied above -- each series' own Z-score can silently
    // no-op independently (e.g. a 1-sample series next to a well-sampled
    // one), so its own tooltip must stop claiming "σ" units when its own
    // values are still raw EGC.
    const fmtVal = (v: number | null, seriesStandardizeApplied: boolean) => {
      if (v === null) return '--'
      if (seriesStandardizeApplied) return v.toFixed(3) + 'σ'
      if (metric === 'norm_egc')    return formatRelativeAbundancePercent(v)
      return v.toExponential(3)
    }

    const hasGroup = series.some(s => s.isGrouped)
    const xs = chartData.map(r => toPlotlyDate(r._ts))

    const traces: object[] = series.map(s => {
      const sw      = hasGroup ? (s.isGrouped ? 3.5 : 1.5) : 2
      const opacity = hasGroup ? (s.isGrouped ? 1   : 0.45) : 1
      const ys      = chartData.map(r => (r[s.id] as number | null) ?? null)
      const seriesStandardizeApplied = standardize && canStandardizeSeries(s.id)
      const seriesSmoothedApplied = smoothed && canSmoothSeries(s.id)
      const traceColor = resolvedColors.get(s.id)!

      return {
        type: 'scatter', mode: 'lines+markers',
        x: xs,
        y: ys,
        line:    { color: traceColor, width: sw },
        marker:  { color: traceColor, size: s.isGrouped ? 5 : 3, opacity },
        opacity,
        name: seriesLabel(s),
        yaxis: 'y',
        // Must not connect across a real
        // non-detection -- see baseRows' union-with-the-full-timeline
        // comment above, which is what gives this an explicit null to
        // break at instead of nothing to act on.
        connectgaps: false,
        customdata: chartData.map((r, i) => [fmtVal(ys[i], seriesStandardizeApplied), r._dt]),
        hovertemplate:
          '<b>%{customdata[1]}</b><br>' +
          // Discloses when the hovered value is a fitted LOWESS curve, not
          // the real sample value.
          seriesLabel(s) + (seriesSmoothedApplied ? ' (smoothed)' : '') + ': %{customdata[0]}' +
          '<extra></extra>',
      }
    })

    if (showTide) {
      traces.push({
        type: 'scatter', mode: 'lines',
        x: nativeTide.x,
        y: nativeTide.y,
        fill: 'tozeroy', fillcolor: 'rgba(0,160,160,0.12)',
        line: { color: 'rgba(0,160,160,0.55)', width: 1.5 },
        name: 'Tide (m)', yaxis: 'y2',
        connectgaps: false,
        hovertemplate: 'Tide: %{y:.2f} m<extra></extra>',
      })
    }

    return traces
  }, [chartData, series, showTide, metric, standardize, resolvedColors, smoothed, nativeTide, canStandardizeSeries, canSmoothSeries, seriesLabel])

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
    buildMultiEgcCsvRows(chartData, series, metric, standardizeApplied, smoothedApplied, showTide),
    `compare_egc_${metric}${standardizeApplied ? '_zscore' : ''}.csv`,
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
                <div className="legend-dot" style={{ background: resolvedColors.get(s.id) }} />
                <span
                  title={s.annotationId}
                  style={s.source === 'taxonomy' ? { fontStyle: 'italic' } : undefined}
                >
                  {seriesLabel(s)}
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

      {showStats && <StatsPanel series={perSeriesVals} yLabel={yLabel} standardize={standardizeApplied} />}

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

