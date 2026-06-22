// ── GroupedEgcChart ───────────────────────────────────────────────────────────
// Sums EGC across multiple annotations and renders the result as a single line.
// Used when the user selects several rows and clicks "∑ Group" in AnalyzePage,
// and also inside AnnotationsByParentPanel to show a parent category total.
//
// L1 normalisation note:
//   GroupedEgcChart cannot use pre-computed norm_egc because the summed series
//   has no single norm_egc value — it falls back to dividing by the group total,
//   which is relative within the group, not a true depth-normalised abundance.
//   A ⚠ label is shown in the UI when L1 is active.
//
// Day/Night + Tide overlays (both off by default):
//   Day/Night shades real night hours (sunrise/sunset for Rosario, Orcas
//   Island). Tide renders predicted water level as a translucent area on
//   a secondary right axis (meters).
//
// XAxis is type="number" (time-proportional, driven by each point's `ts`
// Unix-ms field) rather than categorical — pixel spacing reflects real
// elapsed time, so a missing sample's gap stretches instead of being
// squeezed to the same width as every other gap. See EgcChart's XAxis
// comment for the full rationale.

import React, { useState, useRef, useMemo } from 'react'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceArea, Brush,
} from 'recharts'

import type { AnnotationItem, NormalizeMode } from '../../types'
import { extractEgc } from '../../utils/stats'
import { applyL1Normalize, applyZScore, applyLowess } from '../../utils/signal'
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

type SeriesEntry = {
  annotationId: string
  name:         string | null
  data:         AnnotationItem[]
  color:        string
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
  const [normalizeMode, setNormalizeMode]     = useState<NormalizeMode>('none')
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.4)
  const [dateFrom, setDateFrom]               = useState('')
  const [dateTo, setDateTo]                   = useState('')
  const [brushRange, setBrushRange]           = useState<{ startIndex: number; endIndex: number } | null>(null)
  const [showNightShading, setShowNightShading] = useState(false)
  const [showTide, setShowTide]                 = useState(false)
  const [showDayBands, setShowDayBands]         = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)

  const { sunTimes, tides, tidesLoading, tidesError } =
    useSolarTideData(showNightShading || showTide)

  const summedPoints = useMemo(() => {
    const dtMap: Record<string, { egc: number; datetime: string; iso: string }> = {}
    for (const s of allSeries) {
      for (const d of s.data) {
        if (!d.timepoint?.datetime) continue
        const iso = isoDate(d.timepoint.datetime)
        if (dateFrom && iso < dateFrom) continue
        if (dateTo   && iso > dateTo)   continue
        const egc = extractEgc(d.value)
        if (egc === null) continue
        const dt = d.timepoint.datetime
        if (!dtMap[dt]) dtMap[dt] = { egc: 0, datetime: dt, iso }
        dtMap[dt].egc += egc
      }
    }
    return Object.values(dtMap)
      .sort((a, b) => parseDateTime(a.datetime) - parseDateTime(b.datetime))
      .map(({ egc, datetime }) => ({
        date: fmtDate(datetime),
        egc,
        datetime,
        // ts (Unix ms) drives the time-proportional XAxis below — see
        // EgcChart's XAxis comment for why real elapsed time matters here.
        ts: parseDateTime(datetime),
      }))
  }, [allSeries, dateFrom, dateTo])

  const processedPointsRaw = useMemo(() => {
    let pts = summedPoints as { egc: number | null; datetime: string; ts: number; date: string }[]
    if (normalizeMode === 'l1')     pts = applyL1Normalize(pts) as typeof pts
    if (normalizeMode === 'zscore') pts = applyZScore(pts) as typeof pts
    if (smoothed) pts = applyLowess(pts, smoothBandwidth) as typeof pts
    return pts
  }, [summedPoints, normalizeMode, smoothed, smoothBandwidth])

  // ── Tide values aligned to this chart's own x-values ──────────────────────
  const processedPoints = useMemo(() => {
    if (!showTide || !tides || tides.length === 0) {
      return processedPointsRaw.map(p => ({ ...p, tide_wl: null as number | null }))
    }
    const datetimes = processedPointsRaw.map(p => p.datetime)
    const aligned = alignTideToChartPoints(datetimes, tides)
    return processedPointsRaw.map(p => ({
      ...p,
      tide_wl: aligned.get(p.datetime) ?? null,
    }))
  }, [processedPointsRaw, showTide, tides])

  const egcVals = useMemo(
    () => processedPoints.map(d => d.egc).filter((v): v is number => v !== null),
    [processedPoints],
  )

  const dayBands = useMemo(
    () => showDayBands
      ? computeDayBands(
          processedPoints.map(p => ({
            datetime: (p as typeof p & { datetime: string }).datetime,
          })),
        )
      : [],
    [showDayBands, processedPoints],
  )

  const nightBands = useMemo(
    () => showNightShading && sunTimes
      ? computeNightBands(
          processedPoints.map(p => ({
            datetime: (p as typeof p & { datetime: string }).datetime,
          })),
          sunTimes,
        )
      : [],
    [showNightShading, sunTimes, processedPoints],
  )

  const visiblePoints = useMemo(() => {
    if (!brushRange) return processedPoints
    return processedPoints.slice(brushRange.startIndex, brushRange.endIndex + 1)
  }, [processedPoints, brushRange])

  const uniqueDayCount = useMemo(() => {
    const days = new Set(
      visiblePoints.map(p =>
        ((p as typeof p & { datetime: string }).datetime ?? '').split(' ')[0],
      ),
    )
    return days.size
  }, [visiblePoints])

  const tickFormatter = useMemo(
    () => makeTickFormatter(
      processedPoints.map(p => ({
        datetime: (p as typeof p & { datetime: string }).datetime,
        ts:       (p as typeof p & { ts: number }).ts,
      })),
      uniqueDayCount,
    ),
    [processedPoints, uniqueDayCount],
  )

  // Explicit tick positions — see EgcChart's axisTicks comment for why
  // Recharts' default tick generation is too sparse on a numeric axis.
  const axisTicks = useMemo(
    () => buildAxisTicks(
      processedPoints.map(p => ({
        datetime: (p as typeof p & { datetime: string }).datetime,
        ts:       (p as typeof p & { ts: number }).ts,
      })),
      uniqueDayCount,
    ),
    [processedPoints, uniqueDayCount],
  )

  const tideVals = useMemo(
    () => processedPoints.map(d => d.tide_wl).filter((v): v is number => v !== null),
    [processedPoints],
  )
  const tideDomain = useMemo<[number, number] | undefined>(() => {
    if (tideVals.length === 0) return undefined
    const pad = (Math.max(...tideVals) - Math.min(...tideVals)) * 0.1 || 0.1
    return [Math.min(...tideVals) - pad, Math.max(...tideVals) + pad]
  }, [tideVals])

  const yLabel = normalizeMode === 'l1'
    ? 'Summed EGC (relative — group total, not sample depth) ⚠'
    : normalizeMode === 'zscore'
    ? 'Summed EGC (Z-score)'
    : 'Summed EGC'

  const yFormatter = normalizeMode === 'l1'
    ? (v: number) => (v * 100).toFixed(1) + '%'
    : normalizeMode === 'zscore'
    ? (v: number) => v.toFixed(1) + 'σ'
    : (v: number) => v.toExponential(1)

  const handleExportCsv = () => downloadCsv(
    processedPoints.map(d => ({
      group:    groupLabel,
      date:     (d as typeof d & { datetime: string }).datetime,
      egc:      d.egc,
      ...(showTide ? { tide_predicted_wl_m: d.tide_wl } : {}),
    })),
    `${groupLabel}_grouped_egc.csv`,
  )
  const handleExportPng = () => downloadChartPng(
    chartRef,
    `${groupLabel}_grouped_egc.png`,
    `Grouped: "${groupLabel}" — ${allSeries.length} annotations summed`,
  )
  const handleExportSvg = () => downloadChartSvg(
    chartRef,
    `${groupLabel}_grouped_egc.svg`,
    `Grouped: "${groupLabel}" — ${allSeries.length} annotations summed`,
  )

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?:  boolean
    payload?: { payload: typeof processedPoints[0] }[]
  }) => {
    if (!active || !payload?.length) return null
    const d = payload[0].payload
    const fmtVal = (v: number | null) => {
      if (v === null) return '--'
      if (normalizeMode === 'l1')     return (v * 100).toFixed(3) + '%'
      if (normalizeMode === 'zscore') return v.toFixed(3) + 'σ'
      return v.toExponential(3)
    }
    return (
      <div className="chart-tooltip">
        <div className="tt-date">
          {(d as typeof d & { datetime: string }).datetime}
        </div>
        <div className="tt-row">
          <div className="tt-dot" style={{ background: 'var(--chart-1)' }} />
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
      </div>
    )
  }

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
        <div ref={chartRef}>
          <ResponsiveContainer width="100%" height={280}>
            <ComposedChart
              data={processedPoints}
              margin={{ top: 6, right: showTide ? 48 : 16, left: 0, bottom: 52 }}
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
              <CartesianGrid strokeDasharray="" stroke="#d9d9d9" vertical={false} />
              {/* type="number" + domain={['dataMin','dataMax']}: a
                  time-proportional axis, so pixel spacing reflects real
                  elapsed time rather than just row position — see
                  EgcChart's XAxis comment for why this matters. */}
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
                  dy:       50,
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

              {/* Night shading — after axes/series so Recharts has
                  resolved the numeric x-scale (see EgcChart for the
                  render-order bug this avoids). */}
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
                stroke="var(--chart-1)"
                strokeWidth={3.7}
                dot={{ r: 4, fill: 'var(--chart-1)', strokeWidth: 0 }}
                activeDot={{ r: 6 }}
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