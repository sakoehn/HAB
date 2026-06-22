// ── MultiEgcChart ─────────────────────────────────────────────────────────────
// Overlay chart that renders multiple annotation series on a shared axis.
// Used by the Compare page and the Compare drawer in the Analyze page.
//
// Each series may be flagged isGrouped to apply visual hierarchy:
//   grouped  → thick line (3.5) + full opacity   (stands out)
//   single   → thin line  (1.5) + 45% opacity    (recedes)
// When no series is grouped all lines render equally at strokeWidth 2.
//
// A scale-mismatch warning is shown when series means differ by > 10×
// in raw EGC mode — prompting the user to switch to Z-score.
//
// Day/Night + Tide overlays (both off by default):
//   Day/Night shades real night hours (sunrise/sunset for Rosario, Orcas
//   Island). NOTE: dayBands (alternating-calendar-day visual rhythm) was
//   previously computed here but never rendered — this revision actually
//   renders it, matching EgcChart/GroupedEgcChart's behavior.
//   Tide renders predicted water level as a translucent area on a
//   secondary right axis (meters).

import React, { useState, useRef, useMemo } from 'react'
import {
  ComposedChart, Line, Area, XAxis, YAxis, CartesianGrid,
  Tooltip, ResponsiveContainer, ReferenceArea, Brush,
} from 'recharts'

import type { AnnotationItem, NormalizeMode } from '../../types'
import { extractEgc, extractNormEgc } from '../../utils/stats'
import { applyZScore, applyLowess } from '../../utils/signal'
import {
  isoDate, fmtDate, parseDateTime,
  computeDayBands, makeTickFormatter, buildAxisTicks,
} from '../../utils/format'
import { computeNightBands, alignTideToChartPoints } from '../../utils/solar'
import { useSolarTideData } from '../../utils/useSolarTideData'
import { downloadChartPng, downloadChartSvg } from '../../utils/chart'
import { downloadCsv } from '../../utils/api'
import { StatsPanel }   from '../ui/StatsPanel'
import { ChartControls } from './ChartControls'
import { ScaffoldBtn }   from '../scaffolds/ScaffoldBtn'

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
  dataDateRange,
  onGoScaffoldExplore,
}: {
  series:               SeriesEntry[]
  dateFrom:             string
  dateTo:               string
  dataDateRange?:       { min: string; max: string } | null
  onGoScaffoldExplore?: (annotationId: string, source: string) => void
}) {
  const [normalizeMode, setNormalizeMode]     = useState<NormalizeMode>('none')
  const [smoothed, setSmoothed]               = useState(false)
  const [smoothBandwidth, setSmoothBandwidth] = useState(0.4)
  const [showStats, setShowStats]             = useState(false)
  const [brushRange, setBrushRange]           = useState<{ startIndex: number; endIndex: number } | null>(null)
  const [showNightShading, setShowNightShading] = useState(false)
  const [showTide, setShowTide]                 = useState(false)
  const [showDayBands, setShowDayBands]         = useState(false)
  const chartRef = useRef<HTMLDivElement>(null)

  const { sunTimes, tides, tidesLoading, tidesError } =
    useSolarTideData(showNightShading || showTide)

  // `_ts` (Unix ms) drives the x-axis, which is type="number" rather than
  // categorical — see the XAxis below. Real elapsed time between samples
  // then maps to real pixel distance, instead of every gap (even an
  // 8-hour gap from a missing 4-hour slot) rendering at equal width.
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
        dtMap[dt][s.annotationId]             = extractEgc(d.value)
        dtMap[dt][s.annotationId + '__norm']  = extractNormEgc(d.value)
      }
    }
    return Object.values(dtMap).sort(
      (a, b) => a._ts - b._ts,
    )
  }, [series, dateFrom, dateTo])

  const chartDataRaw = useMemo<ChartRow[]>(() => {
    if (normalizeMode === 'none' && !smoothed) return baseRows
    let rows = baseRows
    for (const s of series) {
      let processed: { egc: number | null; datetime?: string }[]
      if (normalizeMode === 'l1') {
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
      if (normalizeMode === 'zscore') processed = applyZScore(processed)
      if (smoothed) processed = applyLowess(processed, smoothBandwidth)
      rows = rows.map((row, i) => ({ ...row, [s.annotationId]: processed[i].egc }))
    }
    return rows
  }, [baseRows, normalizeMode, smoothed, smoothBandwidth, series])

  // ── Tide values aligned to this chart's own x-values ──────────────────────
  const chartData = useMemo<ChartRow[]>(() => {
    if (!showTide || !tides || tides.length === 0) {
      return chartDataRaw.map(r => ({ ...r, tide_wl: null }))
    }
    const aligned = alignTideToChartPoints(chartDataRaw.map(r => r._dt), tides)
    return chartDataRaw.map(r => ({ ...r, tide_wl: aligned.get(r._dt) ?? null }))
  }, [chartDataRaw, showTide, tides])

  const dayBands = useMemo(
    () => showDayBands ? computeDayBands(chartData.map(r => ({ datetime: r._dt as string }))) : [],
    [showDayBands, chartData],
  )

  const nightBands = useMemo(
    () => showNightShading && sunTimes
      ? computeNightBands(chartData.map(r => ({ datetime: r._dt as string })), sunTimes)
      : [],
    [showNightShading, sunTimes, chartData],
  )

  const visibleRows = useMemo(() => {
    if (!brushRange) return chartData
    return chartData.slice(brushRange.startIndex, brushRange.endIndex + 1)
  }, [chartData, brushRange])

  const uniqueDayCount = useMemo(() => {
    const days = new Set(visibleRows.map(r => (r._dt as string).split(' ')[0]))
    return days.size
  }, [visibleRows])

  const tickFormatter = useMemo(
    () => makeTickFormatter(
      chartData.map(r => ({ datetime: r._dt as string, ts: r._ts })),
      uniqueDayCount,
    ),
    [chartData, uniqueDayCount],
  )

  // Explicit tick positions — see EgcChart's axisTicks comment for why
  // Recharts' default tick generation is too sparse on a numeric axis.
  const axisTicks = useMemo(
    () => buildAxisTicks(
      chartData.map(r => ({ datetime: r._dt as string, ts: r._ts })),
      uniqueDayCount,
    ),
    [chartData, uniqueDayCount],
  )

  const tideVals = useMemo(
    () => chartData.map(r => r.tide_wl as number | null).filter((v): v is number => v !== null),
    [chartData],
  )
  const tideDomain = useMemo<[number, number] | undefined>(() => {
    if (tideVals.length === 0) return undefined
    const pad = (Math.max(...tideVals) - Math.min(...tideVals)) * 0.1 || 0.1
    return [Math.min(...tideVals) - pad, Math.max(...tideVals) + pad]
  }, [tideVals])

  const seriesTitle = series.map(s => s.annotationId).join(' vs ')
  const handleExportPng = () =>
    downloadChartPng(chartRef, 'compare_egc.png', `Compare: ${seriesTitle}`)
  const handleExportSvg = () =>
    downloadChartSvg(chartRef, 'compare_egc.svg', `Compare: ${seriesTitle}`)
  const handleExportCsv = () => {
    const rows: Record<string, unknown>[] = []
    for (const row of chartData) {
      for (const s of series) {
        const val = row[s.annotationId]
        if (val !== null && val !== undefined) {
          rows.push({
            annotation_id:   s.annotationId,
            source:          s.source ?? '',
            date:            row._dt ?? row.date,
            egc_normalized:  val,
            normalize_mode:  normalizeMode,
            ...(showTide ? { tide_predicted_wl_m: row.tide_wl ?? null } : {}),
          })
        }
      }
    }
    downloadCsv(rows, `compare_egc_${normalizeMode}.csv`)
  }

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
    if (normalizeMode !== 'none') return false
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
  }, [series, normalizeMode])

  if (chartData.length === 0) {
    return (
      <div className="state-box">
        <div className="state-icon">〰</div>
        <span>No EGC data in range.</span>
      </div>
    )
  }

  const yLabel = normalizeMode === 'l1'
    ? 'norm_egc (EGC / sample depth)'
    : normalizeMode === 'zscore'
    ? 'Z-score (σ from mean)'
    : 'EGC'

  const yFormatter = normalizeMode === 'l1'
    ? (v: number) => (v * 100).toFixed(1) + '%'
    : normalizeMode === 'zscore'
    ? (v: number) => v.toFixed(1) + 'σ'
    : (v: number) => v.toExponential(1)

  const CustomTooltip = ({
    active,
    payload,
  }: {
    active?:  boolean
    payload?: { color: string; dataKey: string; value: number; payload: ChartRow }[]
  }) => {
    if (!active || !payload?.length) return null
    const fmtVal = (v: number) => {
      if (normalizeMode === 'l1')     return (v * 100).toFixed(3) + '%'
      if (normalizeMode === 'zscore') return v.toFixed(3) + 'σ'
      return v.toExponential(3)
    }
    const tideRow = payload.find(p => p.dataKey === 'tide_wl')
    // _ts (the axis dataKey) is a raw timestamp, not display text — read
    // the original datetime string from the row data instead.
    const dateLabel = payload[0]?.payload?._dt ?? ''
    return (
      <div className="chart-tooltip">
        <div className="tt-date">{dateLabel}</div>
        {payload.filter(p => p.dataKey !== 'tide_wl').map((p, i) => (
          <div className="tt-row" key={i}>
            <div className="tt-dot" style={{ background: p.color }} />
            <span
              className="tt-label"
              style={{
                maxWidth:     140,
                overflow:     'hidden',
                textOverflow: 'ellipsis',
                whiteSpace:   'nowrap',
              }}
            >
              {p.dataKey}
            </span>
            <span className="tt-val">
              {typeof p.value === 'number' ? fmtVal(p.value) : '--'}
            </span>
          </div>
        ))}
        {showTide && tideRow && typeof tideRow.value === 'number' && (
          <div className="tt-row">
            <div className="tt-dot" style={{ background: 'var(--teal)' }} />
            <span className="tt-label">Tide</span>
            <span className="tt-val">{tideRow.value.toFixed(2)} m</span>
          </div>
        )}
      </div>
    )
  }

  return (
    <div className="chart-card">
      <div className="chart-card-header">
        <div className="chart-card-title">
          {yLabel} — {series.length} Annotations
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
        <div style={{
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
        </div>
      )}

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

      <div ref={chartRef}>
        <ResponsiveContainer width="100%" height={340}>
          <ComposedChart
            data={chartData}
            margin={{ top: 6, right: showTide ? 48 : 16, left: 0, bottom: 8 }}
          >
            {dayBands.map((band, i) =>
              band.shade ? (
                <ReferenceArea
                  key={`day-${i}`}
                  yAxisId="main"
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
              dataKey="_ts"
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
              yAxisId="main"
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

            {/* Night shading — after axes/series so Recharts has resolved
                the numeric x-scale (see EgcChart for the render-order
                bug this avoids). */}
            {showNightShading && nightBands.map((b, i) => (
              <ReferenceArea
                key={`night-${i}`}
                yAxisId="main"
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

            {(() => {
              const hasGroup = series.some(s => s.isGrouped)
              return series.map(s => {
                const sw      = hasGroup ? (s.isGrouped ? 3.5 : 1.5) : 2
                const opacity = hasGroup ? (s.isGrouped ? 1   : 0.45) : 1
                return (
                  <Line
                    key={s.annotationId}
                    yAxisId="main"
                    type="monotone"
                    dataKey={s.annotationId}
                    stroke={s.color}
                    strokeWidth={sw}
                    strokeOpacity={opacity}
                    dot={{
                      r:           s.isGrouped ? 4 : 2,
                      fill:        s.color,
                      strokeWidth: 0,
                      fillOpacity: opacity,
                    }}
                    activeDot={{ r: s.isGrouped ? 6 : 4, fill: s.color }}
                    connectNulls={true}
                  />
                )
              })
            })()}
            <Brush
              dataKey="_ts"
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
    </div>
  )
}