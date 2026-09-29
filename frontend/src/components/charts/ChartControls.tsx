// ── ChartControls ─────────────────────────────────────────────────────────────
// Normalize, smooth, and overlay controls bar rendered below the chart card header.
// Used by EgcChart, MultiEgcChart, and GroupedEgcChart.
//
// Metric and Standardize are independent controls — any metric can be
// combined with standardize on or off:
//   metric      — 'egc' (raw) or 'norm_egc' (Relative Abundance = egc / total sample depth)
//   standardize — off, or Z-score (subtract mean, divide by std dev; best for
//                 cross-scale trend comparison), applied to whichever metric is active
//
// Smooth:
//   LOWESS locally weighted regression with adjustable bandwidth
//   (LOWESS_BANDWIDTH_MIN–LOWESS_BANDWIDTH_MAX below).
//   The slider is debounced LOWESS_DEBOUNCE_MS to prevent O(n²) recompute on
//   every drag pixel.
//
// Day/Night + Tide + Day bands (all off by default, independent toggles):
//   Day/Night — shades night-hour regions using real sunrise/sunset for the
//   Rosario, Orcas Island station. Shading direction is theme-aware via CSS
//   vars (see App.css), so no JS theme detection is needed here.
//   Tide — overlays predicted water level as a translucent area on a
//   secondary right-hand axis (meters).
//   Day bands — alternating-calendar-day shading, purely a visual rhythm aid
//   (not tied to real sunrise/sunset). Off by default like the others.

import React, { useState, useEffect, useRef } from 'react'
import type { ChartMetric } from '../../types'
import { HelpTooltip } from '../ui/HelpTooltip'

// Exported so tests assert against the real bounds instead of a
// hand-maintained copy that can silently drift from them.
//
// W27 (docs/AUDIT-2026-09-22.md): this range used to be 0.01-0.05 -- for a
// typical 128-sample series that's a span of only 2-7 neighbours, and a
// 2-neighbour window is mathematically guaranteed to reproduce the raw
// value exactly regardless of weighting (a line through 2 points, evaluated
// at one of those points, always passes through it) -- confirmed live: 0 of
// 128 points changed at the two lowest settings. See signal.ts's
// applyLowess for the matching weight-formula fix (necessary but not
// sufficient on its own at span 2).
export const LOWESS_BANDWIDTH_MIN  = 0.1
export const LOWESS_BANDWIDTH_MAX  = 0.8
export const LOWESS_BANDWIDTH_STEP = 0.05
export const LOWESS_DEBOUNCE_MS    = 150

export function ChartControls({
  metric,
  onMetric,
  standardize,
  onStandardize,
  smoothed,
  onSmooth,
  smoothBandwidth,
  onSmoothBandwidth,
  showNightShading,
  onShowNightShading,
  showTide,
  onShowTide,
  showDayBands,
  onShowDayBands,
}: {
  metric:               ChartMetric
  onMetric:             (v: ChartMetric) => void
  standardize:          boolean
  onStandardize:        (v: boolean) => void
  smoothed:             boolean
  onSmooth:             (v: boolean) => void
  smoothBandwidth:      number
  onSmoothBandwidth:    (v: number) => void
  showNightShading?:    boolean
  onShowNightShading?:  (v: boolean) => void
  showTide?:            boolean
  onShowTide?:          (v: boolean) => void
  showDayBands?:        boolean
  onShowDayBands?:      (v: boolean) => void
}) {
  // Local slider value updates immediately for responsive feel.
  // The debounced value fires onSmoothBandwidth after 150ms of inactivity
  // to prevent O(n²) LOWESS recompute on every pixel of drag.
  const [sliderVal, setSliderVal] = useState(smoothBandwidth)
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  // Sync if parent resets bandwidth externally
  useEffect(() => {
    setSliderVal(smoothBandwidth)
  }, [smoothBandwidth])

  function handleSliderChange(e: React.ChangeEvent<HTMLInputElement>) {
    const v = Number(e.target.value)
    setSliderVal(v)
    if (debounceRef.current) clearTimeout(debounceRef.current)
    debounceRef.current = setTimeout(() => onSmoothBandwidth(v), LOWESS_DEBOUNCE_MS)
  }

  // Overlay controls are opt-in props — only rendered when the parent
  // chart supplies handlers, so charts that haven't been wired up yet
  // (or shouldn't show these, e.g. a future sparkline variant) are
  // unaffected.
  const showOverlayGroup = onShowNightShading || onShowTide || onShowDayBands

  return (
    <div className="chart-controls">
      <div className="chart-ctrl-group">
        <label className="ctrl-label">
          Metric
          <HelpTooltip text="Off = raw EGC. Relative Abundance = norm_egc, EGC ÷ total sample sequencing depth, comparable across samples. Z-score = standardized (mean-subtracted, divided by std dev) — apply to either metric to compare series on different scales." />
        </label>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className={`toggle-pill ${metric === 'egc' ? 'on' : ''}`}
            onClick={() => onMetric('egc')}
            title="Raw EGC values"
          >
            EGC
          </button>
          <button
            className={`toggle-pill ${metric === 'norm_egc' ? 'on' : ''}`}
            onClick={() => onMetric('norm_egc')}
            title="Relative Abundance: uses pre-computed norm_egc (egc ÷ total sample sequencing depth) — comparable across samples"
          >
            Relative Abundance
          </button>
        </div>
        {metric === 'norm_egc' && (
          <span className="ctrl-hint">Relative Abundance (norm_egc)</span>
        )}
      </div>

      <div className="chart-ctrl-group">
        <label className="ctrl-label">Standardize</label>
        <div style={{ display: 'flex', gap: 4 }}>
          <button
            className={`toggle-pill ${!standardize ? 'on' : ''}`}
            onClick={() => onStandardize(false)}
            title="No standardization"
          >
            Off
          </button>
          <button
            className={`toggle-pill ${standardize ? 'on' : ''}`}
            onClick={() => onStandardize(true)}
            title="Z-score: subtract mean, divide by std dev — best for comparing trends across different scales"
          >
            Z-score
          </button>
        </div>
        {standardize && (
          <span className="ctrl-hint">Std deviations from mean</span>
        )}
      </div>

      <div className="chart-ctrl-group">
        <label className="ctrl-label">
          Smooth
          <HelpTooltip text="Fits a smoothed trend line through the data. Lower bandwidth = tighter fit to the raw data; higher = smoother, more averaged." />
        </label>
        <button
          className={`toggle-pill ${smoothed ? 'on' : ''}`}
          onClick={() => onSmooth(!smoothed)}
          title="LOWESS: locally weighted regression."
        >
          {smoothed ? 'On' : 'Off'}
        </button>
        {smoothed && (
          <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
            <span className="ctrl-hint">Bandwidth:</span>
            <input
              type="range"
              className="smooth-slider"
              min={LOWESS_BANDWIDTH_MIN}
              max={LOWESS_BANDWIDTH_MAX}
              step={LOWESS_BANDWIDTH_STEP}
              value={sliderVal}
              onChange={handleSliderChange}
              title={`LOWESS bandwidth: ${sliderVal.toFixed(2)} — fraction of data used as neighbors. Lower = tighter fit, higher = smoother.`}
            />
            <span className="ctrl-hint">{sliderVal.toFixed(2)}</span>
          </div>
        )}
      </div>

      {showOverlayGroup && (
        <div className="chart-ctrl-group">
          <label className="ctrl-label">
            Overlays
            <HelpTooltip text="Day/Night uses real sunrise/sunset times for Rosario, Orcas Island. Day bands is just alternating shading to help track days — not tied to actual solar data." />
          </label>
          <div style={{ display: 'flex', gap: 4 }}>
            {onShowNightShading && (
              <button
                className={`toggle-pill ${showNightShading ? 'on' : ''}`}
                onClick={() => onShowNightShading(!showNightShading)}
                title="Shade night hours using real sunrise/sunset for the Rosario, Orcas Island station"
              >
                🌙 Day/Night
              </button>
            )}
            {onShowTide && (
              <button
                className={`toggle-pill ${showTide ? 'on' : ''}`}
                onClick={() => onShowTide(!showTide)}
                title="Overlay predicted tide water level (meters) on a secondary axis"
              >
                〜 Tide
              </button>
            )}
            {onShowDayBands && (
              <button
                className={`toggle-pill ${showDayBands ? 'on' : ''}`}
                onClick={() => onShowDayBands(!showDayBands)}
                title="Shade alternating calendar days as a visual rhythm aid (not tied to real sunrise/sunset)"
              >
                ▦ Day bands
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}