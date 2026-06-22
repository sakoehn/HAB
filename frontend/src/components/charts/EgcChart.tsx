// ── EgcChart ──────────────────────────────────────────────────────────────────
// Time series chart for a single annotation across all 128 samples.
// Manages its own display state: date filter, normalize mode, smoothing,
// stats panel, timepoint selector, brush zoom, and the day/night + tide
// overlays.
//
// Props:
//   data           — AnnotationItem[] from the series cache
//   annotationId   — displayed in the card header and export filenames
//   annotationName — human-readable name shown beside the ID
//   color          — line and dot color (from SOURCE_SHADES via nextColorForSource)
//   source         — 'kegg' | 'cog' | 'enzyme' | 'taxonomy'
//   dataDateRange  — { min, max } ISO date strings from /api/status,
//                    used to constrain the date picker inputs
//
// Day/Night + Tide overlays (both off by default):
//   Day/Night shades real night hours (sunrise/sunset for Rosario, Orcas
//   Island) — distinct from the existing alternating-calendar-day bands
//   (computeDayBands), which stay as a separate visual-rhythm aid.
//   Tide renders predicted water level as a translucent area on a
//   secondary right axis (meters), aligned to this chart's own x-values.

import React, { useState, useEffect, useRef, useMemo } from 'react'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceArea, Brush,
} from 'recharts'

import type { AnnotationItem, NormalizeMode } from '../../types'
import { extractEgc, extractNormEgc } from '../../utils/stats'
import { applyZScore, applyLowess } from '../../utils/signal'
import {
  parseDateTime, fmtDate, isoDate,
  computeDayBands, makeTickFormatter, buildAxisTicks,
} from '../../utils/format'
import { computeNightBands, alignTideToChartPoints } from '../../utils/solar'
import { useSolarTideData } from '../../utils/useSolarTideData'
import { downloadChartPng, downloadChartSvg } from '../../utils/chart'
import { downloadCsv } from '../../utils/api'
import { StatsPanel }    from '../ui/StatsPanel'
import { DateRangePicker } from '../ui/DateRangePicker'
import { ChartControls }  from './ChartControls'

export function EgcChart({
  data,
  annotationId,
  annotationName,
  color = 'var(--chart-1)',
  source = 'cog',
  dataDateRange,
}: {
  data:           AnnotationItem[]
  annotationId:   string
  annotationName: string | null
  color?:         string
  source?:        string
  dataDateRange?: { min: string; max: string } | null
}) {
  const [dateFrom, setDateFrom]               = useState('')
  const [dateTo, setDateTo]                   = useState('')
  const [normalizeMode, setNormalizeMode]     = useState<NormalizeMode>('none')
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.4)
  const [showStats, setShowStats]             = useState(false)
  const [tpPanelOpen, setTpPanelOpen]         = useState(false)
  const [selectedDates, setSelectedDates]     = useState<Set<string> | null>(null)
  const [brushRange, setBrushRange]           = useState<{ startIndex: number; endIndex: number } | null>(null)
  const [showNightShading, setShowNightShading] = useState(false)
  const [showTide, setShowTide]                 = useState(false)
  const [showDayBands, setShowDayBands]         = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)

  const { sunTimes, tides, tidesLoading, tidesError } =
    useSolarTideData(showNightShading || showTide)

  // ── Build sorted full point list ─────────────────────────────────────────
  // `ts` (Unix ms) drives the x-axis, which is type="number" rather than
  // categorical — see the XAxis below. This makes point-to-point pixel
  // spacing reflect REAL elapsed time, not just position in the array.
  // That matters because real sampling has gaps (a missing 4-hour slot
  // becomes an 8-hour gap), and a categorical axis would silently squeeze
  // that gap to the same width as every other gap, distorting anything
  // anchored to real clock times — including the night-shading bands.
  const allPoints = useMemo(() => (
    [...data]
      .filter(d => d.timepoint?.datetime)
      .sort((a, b) =>
        parseDateTime(a.timepoint!.datetime) - parseDateTime(b.timepoint!.datetime)
      )
      .map(d => ({
        date:     fmtDate(d.timepoint?.datetime ?? ''),
        iso:      isoDate(d.timepoint?.datetime ?? ''),
        datetime: d.timepoint?.datetime ?? '',
        ts:       parseDateTime(d.timepoint?.datetime ?? ''),
        egc:      extractEgc(d.value),
        norm_egc: extractNormEgc(d.value),
        sample:   d.sample,
      }))
      .filter(d => d.egc !== null)
  ), [data])

  // ── All unique calendar dates for the timepoint selector ─────────────────
  const allDates = useMemo(() => {
    const seen  = new Set<string>()
    const dates: string[] = []
    for (const pt of allPoints) {
      const day = pt.datetime.split(' ')[0] ?? ''
      if (!seen.has(day)) { seen.add(day); dates.push(day) }
    }
    return dates
  }, [allPoints])

  // Initialise selectedDates to all once we know allDates
  useEffect(() => {
    if (allDates.length > 0 && selectedDates === null) {
      setSelectedDates(new Set(allDates))
    }
  }, [allDates])

  const allSelected = selectedDates === null || selectedDates.size === allDates.length

  // ── Date range + timepoint filter ────────────────────────────────────────
  const filteredPoints = useMemo(() =>
    allPoints.filter(d => {
      if (dateFrom && d.iso < dateFrom) return false
      if (dateTo   && d.iso > dateTo)   return false
      if (!allSelected && selectedDates) {
        const day = d.datetime.split(' ')[0] ?? ''
        if (!selectedDates.has(day)) return false
      }
      return true
    }),
  [allPoints, dateFrom, dateTo, selectedDates, allSelected])

  // ── Normalisation + smoothing ─────────────────────────────────────────────
  const processedPoints = useMemo(() => {
    let pts = (normalizeMode === 'l1'
      ? filteredPoints.map(d => ({
          ...d,
          egc: (d as typeof d & { norm_egc: number | null }).norm_egc ?? null,
        }))
      : filteredPoints
    ) as { egc: number | null; datetime: string; ts: number; date: string; iso: string; sample: string }[]
    if (normalizeMode === 'zscore') pts = applyZScore(pts) as typeof pts
    if (smoothed) pts = applyLowess(pts, smoothBandwidth) as typeof pts
    return pts
  }, [filteredPoints, normalizeMode, smoothed, smoothBandwidth])

  // ── Tide values aligned to this chart's own x-values ──────────────────────
  // Joined onto processedPoints (not a separate dataset) so the Area series
  // shares the same x-axis values as the EGC Line — required for both to
  // render correctly on one ComposedChart. Alignment itself is still done
  // by datetime string (see alignTideToChartPoints); the numeric `ts` field
  // each point already carries is what the chart's axis actually reads.
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

  // ── Brush-filtered visible points (for tick formatter) ───────────────────
  const visiblePoints = useMemo(() => {
    if (!brushRange) return pointsWithTide
    return pointsWithTide.slice(brushRange.startIndex, brushRange.endIndex + 1)
  }, [pointsWithTide, brushRange])

  const dayBands = useMemo(
    () => showDayBands ? computeDayBands(processedPoints) : [],
    [showDayBands, processedPoints],
  )

  const nightBands = useMemo(
    () => showNightShading && sunTimes ? computeNightBands(processedPoints, sunTimes) : [],
    [showNightShading, sunTimes, processedPoints],
  )

  const uniqueDayCount = useMemo(() => {
    const days = new Set(visiblePoints.map(p => p.datetime.split(' ')[0]))
    return days.size
  }, [visiblePoints])

  const tickFormatter = useMemo(
    () => makeTickFormatter(processedPoints, uniqueDayCount),
    [processedPoints, uniqueDayCount],
  )

  // Explicit tick positions — Recharts' default tick generation on a
  // type="number" axis picks only ~4-5 "nice" evenly-spaced values
  // regardless of how many days the data spans, which reads as too
  // sparse for a chart meant to be scanned day-by-day.
  const axisTicks = useMemo(
    () => buildAxisTicks(processedPoints, uniqueDayCount),
    [processedPoints, uniqueDayCount],
  )

  const egcVals = useMemo(
    () => processedPoints.map(d => d.egc).filter((v): v is number => v !== null),
    [processedPoints],
  )

  const tideVals = useMemo(
    () => pointsWithTide.map(d => d.tide_wl).filter((v): v is number => v !== null),
    [pointsWithTide],
  )
  const tideDomain = useMemo<[number, number] | undefined>(() => {
    if (tideVals.length === 0) return undefined
    const pad = (Math.max(...tideVals) - Math.min(...tideVals)) * 0.1 || 0.1
    return [Math.min(...tideVals) - pad, Math.max(...tideVals) + pad]
  }, [tideVals])

  const yLabel = normalizeMode === 'l1'
    ? 'norm_egc (EGC / sample depth)'
    : normalizeMode === 'zscore'
    ? 'EGC (Z-score, σ from mean)'
    : 'EGC'

  const yFormatter = normalizeMode === 'l1'
    ? (v: number) => (v * 100).toFixed(2) + '%'
    : normalizeMode === 'zscore'
    ? (v: number) => v.toFixed(2) + 'σ'
    : (v: number) => v.toExponential(1)

  const exportTitle = `${annotationId}${annotationName ? ` — ${annotationName}` : ''}`

  const handleExportCsv = () => downloadCsv(
    pointsWithTide.map(d => ({
      annotation_id: annotationId,
      sample:        d.sample,
      date:          d.datetime,
      egc:           d.egc,
      ...(showTide ? { tide_predicted_wl_m: d.tide_wl } : {}),
    })),
    `${annotationId}_egc_timeseries.csv`,
  )
  const handleExportPng = () =>
    downloadChartPng(chartRef, `${annotationId}_egc_timeseries.png`, exportTitle)
  const handleExportSvg = () =>
    downloadChartSvg(chartRef, `${annotationId}_egc_timeseries.svg`, exportTitle)

  if (allPoints.length === 0) {
    return (
      <div className="state-box" style={{ padding: '24px' }}>
        <div className="state-icon">〰</div>
        <span>No EGC values found across samples for this annotation.</span>
      </div>
    )
  }

  // ── Tooltip ───────────────────────────────────────────────────────────────
  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?:  boolean
    payload?: { payload: typeof pointsWithTide[0] }[]
  }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    const fmtVal = (v: number | null) => {
      if (v === null) return '--'
      if (normalizeMode === 'l1')     return (v * 100).toFixed(4) + '%'
      if (normalizeMode === 'zscore') return v.toFixed(3) + 'σ'
      return v.toExponential(3)
    }
    return (
      <div className="chart-tooltip">
        <div className="tt-date">{d.datetime}</div>
        <div className="tt-row">
          <div className="tt-dot" style={{ background: color }} />
          <span className="tt-label">{yLabel}</span>
          <span className="tt-val">{fmtVal(d.egc)}</span>
        </div>
        {showTide && d.tide_wl !== null && (
          <div className="tt-row">
            <div className="tt-dot" style={{ background: 'var(--teal)' }} />
            <span className="tt-label">Tide</span>
            <span className="tt-val">{d.tide_wl.toFixed(2)} m</span>
          </div>
        )}
        <div style={{ marginTop: 6, fontSize: 12, color: 'var(--text-dim)' }}>
          {d.sample}
        </div>
      </div>
    )
  }

  const tpBadge = !allSelected && selectedDates
    ? ` (${selectedDates.size} of ${allDates.length})`
    : ''

  return (
    <div className="chart-card">
      {/* ── Header ── */}
      <div className="chart-card-header">
        <div>
          <div className="chart-card-title">
            {annotationId}{annotationName ? ` — ${annotationName}` : ''}
          </div>
          <div style={{
            fontSize: 12, fontFamily: 'var(--mono)',
            color: 'var(--text-dim)', marginTop: 2,
          }}>
            {yLabel} · {processedPoints.length} of {allPoints.length} samples
          </div>
        </div>
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }}>
          <button
            className={`toggle-pill sm ${tpPanelOpen ? 'on' : ''}`}
            onClick={() => setTpPanelOpen(o => !o)}
            title="Select which timepoints to display"
            style={!allSelected ? { outline: '1.5px solid var(--teal)' } : undefined}
          >
            ⚙ Timepoints{tpBadge}
          </button>
          <button
            className={`toggle-pill sm ${showStats ? 'on' : ''}`}
            onClick={() => setShowStats(s => !s)}
          >
            Σ Stats
          </button>
          <button className="btn sm" onClick={handleExportPng}>↓ PNG</button>
          <button className="btn sm" onClick={handleExportSvg}>↓ SVG</button>
          <button className="btn sm" onClick={handleExportCsv}>↓ CSV</button>
        </div>
      </div>

      {/* ── Stats panel ── */}
      {showStats && <StatsPanel vals={egcVals} yLabel={yLabel} />}

      {/* ── Timepoint selector panel ── */}
      {tpPanelOpen && allDates.length > 0 && (
        <div className="expand-anim" style={{
          padding: '10px 14px 12px',
          background: 'var(--surface2)',
          borderRadius: 6,
          marginBottom: 10,
          border: '1px solid var(--border)',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', gap: 8,
            marginBottom: 8, flexWrap: 'wrap',
          }}>
            <span style={{
              font: '600 10px var(--mono)', color: 'var(--text-dim)',
              textTransform: 'uppercase', letterSpacing: '.1em',
            }}>
              Filter by date
            </span>
            <button
              className="btn ghost sm"
              onClick={() => setSelectedDates(new Set(allDates))}
              style={{ fontSize: 10, padding: '1px 7px' }}
            >
              All
            </button>
            <button
              className="btn ghost sm"
              onClick={() => setSelectedDates(new Set())}
              style={{ fontSize: 10, padding: '1px 7px' }}
            >
              None
            </button>
          </div>
          <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
            {allDates.map(day => {
              const active = selectedDates?.has(day) ?? true
              const parts  = day.split('/')
              const label  = parts.length >= 2 ? `${parts[0]}/${parts[1]}` : day
              return (
                <button
                  key={day}
                  className={`toggle-pill sm ${active ? 'on' : ''}`}
                  onClick={() => {
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
        </div>
      )}

      {/* ── Date range picker ── */}
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

      {/* ── Chart controls ── */}
      <ChartControls
        normalizeMode={normalizeMode}
        onNormalizeMode={setNormalizeMode}
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
        <div ref={chartRef}>
          <ResponsiveContainer width="100%" height={320}>
            <ComposedChart
              data={pointsWithTide}
              margin={{ top: 6, right: showTide ? 48 : 16, left: 0, bottom: 8 }}
            >
              {dayBands.map((band, i) =>
                band.shade ? (
                  <ReferenceArea
                    key={`day-${i}`}
                    yAxisId="egc"
                    x1={band.x1Ts}
                    x2={band.x2Ts}
                    fill="rgba(0,0,0,0.04)"
                    fillOpacity={1}
                    strokeOpacity={0}
                    ifOverflow="visible"
                  />
                ) : null,
              )}

              <CartesianGrid
                strokeDasharray=""
                stroke="#d9d9d9"
                vertical={false}
              />

              {/* type="number" + domain={['dataMin','dataMax']} makes this
                  a TIME-PROPORTIONAL axis: pixel spacing between points
                  reflects real elapsed time, not just array position. This
                  matters for real sampling gaps (a missing 4-hour slot
                  becomes a visibly wider 8-hour gap instead of being
                  silently squeezed to the same width as every other gap),
                  and it's what makes the night-shading bands' widths
                  actually represent real elapsed night hours. */}
              <XAxis
                dataKey="ts"
                type="number"
                domain={['dataMin', 'dataMax']}
                ticks={axisTicks}
                tick={{ fill: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                angle={-40}
                textAnchor="end"
                height={56}
                tickFormatter={tickFormatter}
              />
              <YAxis
                yAxisId="egc"
                tick={{ fill: 'var(--text-dim)', fontSize: 11, fontFamily: 'var(--mono)' }}
                tickLine={false}
                axisLine={{ stroke: 'var(--border)' }}
                width={72}
                tickFormatter={yFormatter}
                label={{
                  value:    yLabel,
                  angle:    -90,
                  position: 'insideLeft',
                  fill:     'var(--text-dim)',
                  fontSize: 10,
                  fontFamily: 'var(--mono)',
                  dy:       40,
                }}
              />
              {showTide && (
                <YAxis
                  yAxisId="tide"
                  orientation="right"
                  domain={tideDomain}
                  tick={{ fill: 'var(--teal)', fontSize: 10, fontFamily: 'var(--mono)' }}
                  tickLine={false}
                  axisLine={{ stroke: 'var(--border)' }}
                  width={48}
                  tickFormatter={(v: number) => v.toFixed(1)}
                  label={{
                    value:    'Tide (m)',
                    angle:    90,
                    position: 'insideRight',
                    fill:     'var(--teal)',
                    fontSize: 10,
                    fontFamily: 'var(--mono)',
                  }}
                />
              )}
              <Tooltip content={<CustomTooltip />} />

              {/* Night shading — placed after axes so Recharts has
                  resolved the numeric x-scale for x1/x2 lookups; a
                  ReferenceArea rendered before XAxis/series silently
                  produces nothing. */}
              {showNightShading && nightBands.map((b, i) => (
                <ReferenceArea
                  key={`night-${i}`}
                  yAxisId="egc"
                  x1={b.x1Ts}
                  x2={b.x2Ts}
                  fill="var(--shade-night-fill)"
                  style={{ fillOpacity: 'var(--shade-night-opacity)' }}
                  strokeOpacity={0}
                  ifOverflow="visible"
                />
              ))}

              {showTide && (
                <Area
                  yAxisId="tide"
                  type="monotone"
                  dataKey="tide_wl"
                  stroke="var(--tide-stroke)"
                  strokeWidth={1.5}
                  strokeOpacity={0.6}
                  fill="var(--tide-fill)"
                  fillOpacity={0.16}
                  connectNulls={true}
                  dot={false}
                  activeDot={false}
                  isAnimationActive={false}
                />
              )}

              <Line
                yAxisId="egc"
                type="monotone"
                dataKey="egc"
                stroke={color}
                strokeWidth={2}
                dot={{ r: 4, fill: color, strokeWidth: 0 }}
                activeDot={{ r: 6, fill: color, stroke: 'var(--bg)', strokeWidth: 2 }}
                connectNulls={false}
              />
              {/* Brush still works on array startIndex/endIndex (not axis
                  values), so switching the axis to numeric doesn't change
                  its zoom mechanics — only its dataKey (for the mini chart
                  preview) and tickFormatter need to match. */}
              <Brush
                dataKey="ts"
                height={24}
                stroke="var(--border)"
                fill="var(--surface2)"
                travellerWidth={6}
                tickFormatter={tickFormatter}
                onChange={range => {
                  if (
                    range &&
                    typeof range.startIndex === 'number' &&
                    typeof range.endIndex   === 'number'
                  ) {
                    setBrushRange({
                      startIndex: range.startIndex,
                      endIndex:   range.endIndex,
                    })
                  }
                }}
              />
            </ComposedChart>
          </ResponsiveContainer>
        </div>
      )}
    </div>
  )
}