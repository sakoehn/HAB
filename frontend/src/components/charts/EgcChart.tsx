// @ts-expect-error plotly.js-dist-min ships no .d.ts; types from @types/plotly.js
import PlotlyBase from 'plotly.js-dist-min'
import createPlotlyComponent from 'react-plotly.js/factory'
import { useState, useEffect, useRef, useMemo, forwardRef, useImperativeHandle } from 'react'

import type { AnnotationItem, ChartMetric } from '../../types'
import { extractEgc, extractNormEgc } from '../../utils/stats'
import { applyZScore, applyLowess, canApplyZScore, canApplyLowess } from '../../utils/signal'
import {
  parseDateTime, fmtDate, isoDate, computeDayBands, toPlotlyDate,
  formatRelativeAbundancePercent,
} from '../../utils/format'
import { computeNightBands, alignTideToChartPoints, nativeTideTrace, resolveSunTimes } from '../../utils/solar'
import { useSolarTideData } from '../../utils/useSolarTideData'
import { useAllSamples } from '../../utils/useAllSamples'
import { downloadCsv } from '../../utils/api'
import { PLOTLY_HOVERLABEL, getEgcYLabel, getEgcHoverYLabel } from '../../utils/chartTheme'
import { taxonomyRankLabel, SOURCE_COLORS } from '../../constants'
import { taxonomyDomainFromId } from '../../utils/taxonomy'
import { StatsPanel }     from '../ui/StatsPanel'
import { DateRangePicker } from '../ui/DateRangePicker'
import { ChartControls }  from './ChartControls'
import { ScaffoldBtn }    from '../scaffolds/ScaffoldBtn'
import { HierarchyBtn }   from '../hierarchy/HierarchyBtn'
import { buildEgcTimeseriesCsvRows } from './chartCsv'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const Plot = createPlotlyComponent(PlotlyBase as any)

function resolveCssVar(value: string, fallback: string): string {
  if (typeof document === 'undefined' || !value.startsWith('var(')) return value
  const name = value.slice(4, -1).trim()
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim() || fallback
}

// Zero-pads the hour so pill labels read unambiguously as 24h time
// (raw JGI timestamps are unpadded, e.g. "1:00", "13:00" — display-only,
// the underlying unpadded string is still what's used for Set membership).
function padTime(time: string): string {
  const [h, m] = time.split(':')
  return `${(h ?? '').padStart(2, '0')}:${m ?? ''}`
}

export type EgcChartHandle = {
  exportPng: () => void
  exportSvg: () => void
  exportCsv: () => void
}

// buildEgcTimeseriesCsvRows
// Exported so tests can exercise the real CSV row shape directly.
// The value column is named from the active metric ("egc" or "norm_egc"),
// with `metric`/`standardized`/`smoothed` recorded on every row -- d.egc
// is whichever transform is currently displayed (metric swap, z-score,
// LOWESS smoothing all already applied upstream), not necessarily raw EGC.

export const EgcChart = forwardRef<EgcChartHandle, {
  data:           AnnotationItem[]
  annotationId:   string
  annotationName: string | null
  color?:         string
  source?:        string
  depth?:         number | null
  dataDateRange?: { min: string; max: string } | null
  onGoExplore?:   (annotationId: string, source: string) => void
  // The metric toggle (EGC vs. Relative
  // Abundance) is otherwise private state inside this chart -- a caller
  // showing its own derived summary (e.g. AnalyzePage's card-header mean)
  // has no way to know which one is currently displayed without this, and
  // could show a different unit than the chart right below it.
  onMetricChange?: (metric: ChartMetric) => void
  // The samples currently drawn, after the date range and Timepoints
  // filters, in time order -- so a caller's own summary can cover the same
  // points as the chart.
  onVisibleSamplesChange?: (samples: string[]) => void
}>(function EgcChart({
  data,
  annotationId,
  annotationName,
  color = 'var(--chart-1)',
  source,
  depth = null,
  dataDateRange,
  onGoExplore,
  onMetricChange,
  onVisibleSamplesChange,
}, ref) {
  const [dateFrom, setDateFrom]               = useState('')
  const [dateTo, setDateTo]                   = useState('')
  const [showLineage, setShowLineage]         = useState(false)
  const [metric, setMetric]                   = useState<ChartMetric>('norm_egc')
  const [standardize, setStandardize]         = useState(false)
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.3) // within the real [0.1, 0.8] slider range
  const [showStats, setShowStats]             = useState(false)
  const [tpPanelOpen, setTpPanelOpen]         = useState(false)
  const [selectedDates, setSelectedDates]     = useState<Set<string> | null>(null)
  const [selectedTimes, setSelectedTimes]     = useState<Set<string> | null>(null)
  // allDates/allTimes come from allPoints, which can grow after first
  // render once useAllSamples finishes loading (the true full timeline
  // arrives async, after the initial detected-only fallback). Without
  // tracking whether the user has actually touched these filters, seeding
  // selectedDates once would freeze it at whatever smaller set existed on
  // first render, silently excluding every date that only shows up once
  // the real timeline loads (a 3-sample series with 1 real gap would show
  // "2 of 3 samples" instead of "3 of 3 (detected in 2)").
  const [userTouchedDateFilter, setUserTouchedDateFilter] = useState(false)
  const [userTouchedTimeFilter, setUserTouchedTimeFilter] = useState(false)
  const [showNightShading, setShowNightShading] = useState(false)
  const [showTide, setShowTide]                 = useState(false)
  const [showDayBands, setShowDayBands]         = useState(false)
  const plotDivRef = useRef<HTMLDivElement | null>(null)

  const { sunTimes, tides, tidesLoading, tidesError } =
    useSolarTideData(showNightShading || showTide || showDayBands)
  const { allSamples, allSamplesError } = useAllSamples()

  useEffect(() => {
    onMetricChange?.(metric)
  }, [metric]) // eslint-disable-line react-hooks/exhaustive-deps

  // `data` only has rows for samples where
  // this annotation was actually detected -- annotation_series has no row
  // at all for an undetected sample, so there's nothing here to tell "not
  // detected" apart from "sample doesn't exist". Left as-is, the line
  // would run straight from one detection to the next across any stretch
  // of non-detections, silently implying steady presence.
  //
  // Merges in the full real sample timeline (useAllSamples) so every
  // actual sample gets a point -- egc/norm_egc null where undetected,
  // real values where detected. A UNION with data's own detected
  // samples, not a straight swap: guarantees every real detection still
  // gets a point no matter what useAllSamples returns (still loading,
  // empty, or an incomplete/malformed response) -- a response missing
  // `data` resolves useAllSamples to `[]`, and `[] ?? fallback` evaluates
  // to `[]` (?? only triggers on null/undefined), which would otherwise
  // wipe out every real point already in hand. The null points are what
  // connectgaps:false below breaks the line at.
  const allPoints = useMemo(() => {
    const bySample = new Map(
      data
        .filter(d => d.timepoint?.datetime)
        .map(d => [d.sample, d] as const)
    )
    const timeline = new Map(
      [...bySample.entries()].map(([sample, d]) => [sample, d.timepoint!.datetime])
    )
    for (const entry of allSamples ?? []) {
      if (!timeline.has(entry.sample)) timeline.set(entry.sample, entry.datetime)
    }

    return [...timeline.entries()]
      .map(([sample, datetime]) => ({ sample, datetime }))
      .sort((a, b) => parseDateTime(a.datetime) - parseDateTime(b.datetime))
      .map(entry => {
        const d = bySample.get(entry.sample)
        return {
          date:     fmtDate(entry.datetime),
          iso:      isoDate(entry.datetime),
          datetime: entry.datetime,
          ts:       parseDateTime(entry.datetime),
          egc:      d ? extractEgc(d.value) : null,
          norm_egc: d ? extractNormEgc(d.value) : null,
          sample:   entry.sample,
        }
      })
  }, [data, allSamples])

  const [allDates, allTimes] = useMemo(() => {
    const seen  = new Set<string>()
    const dates: string[] = []
    const times: string[] = []
    for (const pt of allPoints) {
      const day = pt.datetime.split(' ')[0] ?? ''
      if (!seen.has(day)) { seen.add(day); dates.push(day) }
      const time = pt.datetime.split(' ')[1] ?? ''
      if (!seen.has(time)) {seen.add(time); times.push(time)}
    }
    times.sort((a,b) => parseInt(a) - parseInt(b))
    return [dates, times]
  }, [allPoints])

  // Date pills drop the year (M/D) by default -- fine for single-season data,
  // but ambiguous once the dataset spans a year boundary, so show the full
  // M/D/YY only when that's actually true.
  const spansMultipleYears = useMemo(
    () => new Set(allDates.map(d => d.split('/')[2])).size > 1,
    [allDates],
  )

  useEffect(() => {
    if (allDates.length > 0 && !userTouchedDateFilter) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- New data: select all of its dates/times unless the user has picked some.
      setSelectedDates(new Set(allDates))
    }
    if (allTimes.length > 0 && !userTouchedTimeFilter) {
      setSelectedTimes(new Set(allTimes))
    }
  }, [allDates, allTimes]) // eslint-disable-line react-hooks/exhaustive-deps

  const allSelected = selectedDates === null || selectedDates.size === allDates.length
  const allTimesSelected = selectedTimes == null || selectedTimes.size === allTimes.length 

  const filteredPoints = useMemo(() =>
    allPoints.filter(d => {
      if (dateFrom && d.iso < dateFrom) return false
      if (dateTo   && d.iso > dateTo)   return false
      if (!allSelected && selectedDates) {
        const day = d.datetime.split(' ')[0] ?? ''
        if (!selectedDates.has(day)) return false
      }
      if (!allTimesSelected && selectedTimes) {
        const time = d.datetime.split(' ')[1] ?? ''
        if (!selectedTimes.has(time)) return false
      }
      return true
    }),
  [allPoints, dateFrom, dateTo, selectedDates, allSelected, selectedTimes, allTimesSelected])

  const visibleSamplesKey = filteredPoints.map(p => p.sample).join(' ')
  useEffect(() => {
    onVisibleSamplesChange?.(filteredPoints.map(p => p.sample))
  }, [visibleSamplesKey]) // eslint-disable-line react-hooks/exhaustive-deps

  // unsmoothed is the metric/standardize
  // pipeline WITHOUT LOWESS -- this is what statistics/detection-count
  // reads, so toggling Smooth never changes the reported numbers, only the
  // displayed curve. `processedPoints` (below) adds smoothing on top of
  // this for the chart line and tooltips only.
  const unsmoothedPoints = useMemo(() => {
    let pts = (metric === 'norm_egc'
      ? filteredPoints.map(d => ({
          ...d,
          egc: (d as typeof d & { norm_egc: number | null }).norm_egc ?? null,
        }))
      : filteredPoints
    ) as { egc: number | null; datetime: string; ts: number; date: string; iso: string; sample: string }[]
    if (standardize) pts = applyZScore(pts) as typeof pts
    return pts
  }, [filteredPoints, metric, standardize])

  // applyZScore is a silent no-op with
  // fewer than 2 real points -- this is whether it ACTUALLY standardized,
  // not just whether the toggle is on, so the axis/tooltip can stop
  // claiming "σ from mean" units for a value that's still raw EGC.
  const standardizeApplied = standardize && canApplyZScore(unsmoothedPoints.map(p => p.egc))

  // applyLowess is a silent no-op with
  // fewer than 3 real points -- this is whether it ACTUALLY smoothed,
  // not just whether the toggle is on, so the tooltip/CSV can stop
  // claiming "(smoothed)" for a curve that's still the raw sample value.
  const smoothedApplied = smoothed && canApplyLowess(unsmoothedPoints.map(p => p.egc))

  const processedPoints = useMemo(() => {
    return smoothed
      ? applyLowess(unsmoothedPoints, smoothBandwidth) as typeof unsmoothedPoints
      : unsmoothedPoints
  }, [unsmoothedPoints, smoothed, smoothBandwidth])

  const pointsWithTide = useMemo(() => {
    if (!showTide || !tides || tides.length === 0) {
      return processedPoints.map(p => ({ ...p, tide_wl: null as number | null }))
    }
    const aligned = alignTideToChartPoints(
      processedPoints.map(p => p.datetime),
      tides,
    )
    return processedPoints.map(p => ({ ...p, tide_wl: aligned.get(p.datetime) ?? null }))
  }, [processedPoints, showTide, tides])

  // The VISUAL tide trace plots at its own
  // native (6-min) resolution, not snapped onto EGC sample timestamps like
  // pointsWithTide.tide_wl above (that alignment still feeds the CSV export's
  // per-sample-row column, a different, legitimate need). See
  // nativeTideTrace's own doc comment in utils/solar.ts for why this doesn't
  // need to share an x-axis with the EGC trace.
  //
  // Bounded by filteredPoints' first/last entries, not just dateFrom/dateTo,
  // so the Timepoints pill filter (selectedDates/selectedTimes) narrows this
  // overlay too. filteredPoints is already sorted chronologically
  // (inherited from allPoints), so its first/last entries are the real
  // visible range under EVERY active filter at once -- keeping this overlay
  // in sync with whatever the EGC line itself is actually showing.
  const nativeTide = useMemo(
    () => (showTide && tides)
      ? nativeTideTrace(
          tides, filteredPoints[0]?.iso, filteredPoints[filteredPoints.length - 1]?.iso,
          { fromTs: filteredPoints[0]?.ts, toTs: filteredPoints[filteredPoints.length - 1]?.ts },
        )
      : { x: [], y: [] },
    [showTide, tides, filteredPoints],
  )

  const dayBandsList = useMemo(
    () => showDayBands ? computeDayBands(processedPoints) : [],
    [showDayBands, processedPoints],
  )

  const nightBands = useMemo(
    () => showNightShading && sunTimes ? computeNightBands(processedPoints, sunTimes) : [],
    [showNightShading, sunTimes, processedPoints],
  )

  const resolvedColor = useMemo(() => resolveCssVar(color, '#4f8ef7'), [color])

  // Stats/detection-count read the unsmoothed values -- toggling
  // Smooth must never change these numbers, only the drawn curve.
  const egcVals = useMemo(
    () => unsmoothedPoints.map(d => d.egc).filter((v): v is number => v !== null),
    [unsmoothedPoints],
  )

  const yLabel      = getEgcYLabel(metric, standardizeApplied)
  // Disclose in the tooltip itself when the shown value is a fitted LOWESS
  // curve, not the real sample value.
  const hoverYLabel = getEgcHoverYLabel(metric, standardizeApplied) + (smoothedApplied ? ' (smoothed)' : '')

  // ── Shapes: night/day bands positioned by real timestamps ─────────────────
  // x0/x1 are ISO datetime strings on Plotly's date axis, so a band from
  // sunset to sunrise spans exactly that window regardless of data cadence.
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
      if (standardizeApplied)   return v.toFixed(3) + 'σ'
      if (metric === 'norm_egc') return formatRelativeAbundancePercent(v)
      return v.toExponential(3)
    }
    const showSolar = (showNightShading || showDayBands) && !!sunTimes
    const xs = pointsWithTide.map(p => toPlotlyDate(p.ts))
    const traces: object[] = [{
      type: 'scatter', mode: 'lines+markers',
      x: xs,
      y: pointsWithTide.map(p => p.egc),
      line:   { color: resolvedColor, width: 2 },
      marker: { color: resolvedColor, size: 5 },
      name: annotationId,
      yaxis: 'y',
      connectgaps: false,
      customdata: pointsWithTide.map(p => {
        const sun = showSolar ? resolveSunTimes(p.iso, sunTimes!) : null
        return [fmtVal(p.egc), p.datetime, sun?.sunrise ?? '--', sun?.sunset ?? '--']
      }),
      hovertemplate:
        '<b>%{customdata[1]}</b><br>' +
        hoverYLabel + ': %{customdata[0]}' +
        (showSolar
          ? '<br>↑ Sunrise: %{customdata[2]}<br>↓ Sunset: %{customdata[3]}'
          : '') +
        '<extra></extra>',
    }]
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
  }, [pointsWithTide, resolvedColor, annotationId, hoverYLabel, showTide, metric, standardizeApplied, showNightShading, showDayBands, sunTimes, nativeTide])

  // ── Layout ────────────────────────────────────────────────────────────────
  const layout = useMemo(() => {
    // Resolved fresh here (not memoized separately on an empty dep array) so
    // it stays correct if this memo re-runs after a theme change, same
    // approach as resolvedColor above.
    const gridColor = resolveCssVar('var(--border-l)', '#d9d9d9')
    const base: Record<string, unknown> = {
      height: 320,
      margin: { t: 10, r: showTide ? 70 : 20, b: 30, l: 80 },
      paper_bgcolor: 'transparent',
      plot_bgcolor:  'transparent',
      showlegend: false,
      hovermode: 'closest',
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
      format: 'png', scale: 2,
      width: plotDivRef.current.offsetWidth,
    })
    const a = document.createElement('a')
    a.href = url
    a.download = `${annotationId}_egc_timeseries.png`
    a.click()
  }

  const handleExportSvg = async () => {
    if (!plotDivRef.current) return
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const url = await (PlotlyBase as any).toImage(plotDivRef.current, { format: 'svg' })
    const a = document.createElement('a')
    a.href = url
    a.download = `${annotationId}_egc_timeseries.svg`
    a.click()
  }

  const handleExportCsv = () => downloadCsv(
    buildEgcTimeseriesCsvRows(pointsWithTide, annotationId, metric, standardizeApplied, smoothedApplied, showTide),
    `${annotationId}_egc_timeseries.csv`,
  )

  useImperativeHandle(ref, () => ({
    exportPng: handleExportPng,
    exportSvg: handleExportSvg,
    exportCsv: handleExportCsv,
  }))

  if (allPoints.length === 0) {
    return (
      <div className="state-box" style={{ padding: '24px' }}>
        <div className="state-icon">〰</div>
        <span>No EGC values found across samples for this annotation.</span>
      </div>
    )
  }

  const tpBadgeParts: string[] = []
  if (!allSelected && selectedDates) {
    tpBadgeParts.push(`${selectedDates.size} of ${allDates.length} dates`)
  }
  if (!allTimesSelected && selectedTimes) {
    tpBadgeParts.push(`${selectedTimes.size} of ${allTimes.length} times`)
  }
  const tpBadge = tpBadgeParts.length > 0 ? ` (${tpBadgeParts.join(', ')})` : ''
  const sourceColor = SOURCE_COLORS[source ?? ''] ?? 'var(--teal)'

  return (
    <div className="chart-card">
      {/* ── Header ── */}
      <div className="chart-card-header">
        <div>
          {source === 'taxonomy' ? (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <div className="chart-card-title" style={{ fontStyle: 'italic' }}>{annotationName ?? annotationId}</div>
              <button
                className={`toggle-pill sm ${showLineage ? 'on' : ''}`}
                style={{ color: 'var(--teal)', borderColor: 'var(--teal)', borderRadius: 6 }}
                onClick={() => setShowLineage(s => !s)}
                title={showLineage ? 'Hide full lineage' : 'Show full lineage'}
              >
                {taxonomyRankLabel(depth, taxonomyDomainFromId(annotationId))} {showLineage ? '▴' : '▾'}
              </button>
            </div>
          ) : (
            <div className="chart-card-title">
              {annotationId}{annotationName ? ` — ${annotationName}` : ''}
            </div>
          )}
          {source === 'taxonomy' && showLineage && (
            <div style={{
              fontSize: 12, fontFamily: 'var(--mono)',
              color: 'var(--text-dim)', marginTop: 2,
            }}>
              {annotationId}
            </div>
          )}
          <div style={{
            fontSize: 12, fontFamily: 'var(--mono)',
            color: 'var(--text-dim)', marginTop: 2,
          }}>
            {yLabel} · {processedPoints.length} of {allPoints.length} samples
            {egcVals.length < processedPoints.length && ` (detected in ${egcVals.length})`}
          </div>
          {/* On a failed /api/samples fetch, allPoints falls back to just
              this annotation's own detected rows (no merged-in real
              timeline), so the header above would read e.g. "70 of 70
              samples" with no "(detected in N)" qualifier -- visually
              identical to a genuinely-detected-everywhere annotation.
              Warn instead. */}
          {allSamplesError && (
            <div style={{
              fontSize: 11, fontFamily: 'var(--mono)',
              color: 'var(--amber)', marginTop: 2,
            }}>
              ⚠ full sample timeline unavailable — detection gaps may not be shown
            </div>
          )}
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <ScaffoldBtn
            annotationId={annotationId}
            source={source ?? ''}
            name={annotationName}
            onGoExplore={onGoExplore}
            className="toggle-pill sm"
          />
          <HierarchyBtn
            annotationId={annotationId}
            source={source ?? ''}
            name={annotationName}
            className="toggle-pill sm"
          />
          <button
            className={`toggle-pill sm ${showStats ? 'on' : ''}`}
            onClick={() => setShowStats(s => !s)}
          >
            Σ Stats
          </button>
        </div>
      </div>

      {/* ── Stats panel ── */}
      {showStats && <StatsPanel vals={egcVals} yLabel={yLabel} standardize={standardizeApplied} />}

      {/* ── Filter dates ── */}
      <div className="chart-filter-box" style={{ borderColor: sourceColor }}>
        <span className="chart-filter-label" style={{ color: sourceColor }}>Filter dates</span>
        <div className="chart-filter-dates">
          <DateRangePicker
            from={dateFrom}
            to={dateTo}
            onFrom={setDateFrom}
            onTo={setDateTo}
            onClear={() => { setDateFrom(''); setDateTo('') }}
            minDate={dataDateRange?.min}
            maxDate={dataDateRange?.max}
          />
          <button
            className={`toggle-pill sm ${tpPanelOpen ? 'on' : ''}`}
            onClick={() => setTpPanelOpen(o => !o)}
            title="Select which timepoints to display"
            style={{
              fontSize: 11,
              ...((!allSelected || !allTimesSelected) ? { outline: '1.5px solid var(--teal)' } : {}),
            }}
          >
            ⚙ Timepoints{tpBadge}
          </button>
        </div>
      </div>

      {/* ── Timepoint selector panel ── */}
      {tpPanelOpen && allDates.length > 0 && allTimes.length > 0 && (
        <div className="expand-anim" style={{
          padding: '10px 14px 12px',
          background: 'var(--surface2)',
          borderRadius: 6,
          marginBottom: 10,
          border: '1px solid var(--border-l)',
        }}>
          <div style={{
            font: '600 10px var(--mono)', color: 'var(--text-dim)',
            textTransform: 'uppercase', letterSpacing: '.1em', marginBottom: 8,
          }}>
            Filter by:
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginBottom: 3, flexWrap: 'wrap',
          }}>
            <span style={{
              font: '600 9px var(--mono)', color: 'var(--text-dim)',
              textTransform: 'uppercase', letterSpacing: '.08em',
            }}>
              Dates
            </span>
            <button
              className="btn ghost sm"
              onClick={() => { setUserTouchedDateFilter(true); setSelectedDates(new Set(allDates)) }}
              style={{ fontSize: 10, padding: '1px 7px' }}
            >
              All
            </button>
            <button
              className="btn ghost sm"
              onClick={() => { setUserTouchedDateFilter(true); setSelectedDates(new Set()) }}
              style={{ fontSize: 10, padding: '1px 7px' }}
            >
              None
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {allDates.map(day => {
              const active = selectedDates?.has(day) ?? true
              const parts  = day.split('/')
              const label  = parts.length >= 2
                ? (spansMultipleYears ? day : `${parts[0]}/${parts[1]}`)
                : day
              return (
                <button
                  key={day}
                  className={`toggle-pill sm ${active ? 'on' : ''}`}
                  onClick={() => {
                    setUserTouchedDateFilter(true)
                    setSelectedDates(prev => {
                      const next = new Set(prev ?? allDates)
                      if (next.has(day)) next.delete(day)
                      else next.add(day)
                      return next
                    })
                  }}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11 }}
                >
                  {label}
                </button>
              )
            })}
          </div>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 6,
            marginTop: 8, marginBottom: 3, flexWrap: 'wrap',
          }}>
            <span style={{
              font: '600 9px var(--mono)', color: 'var(--text-dim)',
              textTransform: 'uppercase', letterSpacing: '.08em',
            }}>
              Times
            </span>
            <button
              className="btn ghost sm"
              onClick={() => { setUserTouchedTimeFilter(true); setSelectedTimes(new Set(allTimes)) }}
              style={{ fontSize: 10, padding: '1px 7px' }}
            >
              All
            </button>
            <button
              className="btn ghost sm"
              onClick={() => { setUserTouchedTimeFilter(true); setSelectedTimes(new Set()) }}
              style={{ fontSize: 10, padding: '1px 7px' }}
            >
              None
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {allTimes.map(time => {
              const active = selectedTimes?.has(time) ?? true
              return (
                <button
                  key={time}
                  className={`toggle-pill sm ${active ? 'on' : ''}`}
                  onClick={() => {
                    setUserTouchedTimeFilter(true)
                    setSelectedTimes(prev => {
                      const next = new Set(prev ?? allTimes)
                      if (next.has(time)) next.delete(time)
                      else next.add(time)
                      return next
                    })
                  }}
                  style={{ fontFamily: 'var(--mono)', fontSize: 11 }}
                >
                  {padTime(time)}
                </button>
              )
            })}
          </div>
        </div>
      )}

      {/* ── Chart controls ── */}
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

      {/* ── Overlay legend ── */}
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

      {/* ── Chart ── */}
      {processedPoints.length === 0 ? (
        <div className="state-box" style={{ padding: '20px' }}>
          <span>No data in selected range.</span>
        </div>
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
          config={{
            displayModeBar: false,
            displaylogo: false,
          }}
        />
      )}
    </div>
  )
})
