// ── Signal Processing Utilities ───────────────────────────────────────────────
// Time-series transformation functions applied to EGC data before charting.
// All functions are pure — they return new arrays and never mutate input.
// No React imports — fully testable in Node.

// ── applyZScore ────────────────────────────────────────────────────────────
// Z-score standardisation per series.
// Subtracts the series mean and divides by population std dev (÷ n) --
// deliberately population, not the Bessel-corrected sample std dev used by
// computeStats(). This rescales the complete, fully-observed series in
// front of the user (no inference beyond it), matching the convention most
// "Z-score normalize" tooling uses (e.g. sklearn's StandardScaler, ddof=0)
// -- as opposed to computeStats()'s Std Dev "s", which reports a
// generalizable estimate and correctly uses n-1 for that different purpose.
//
// Result: all series centred at 0, scaled by their own variance.
// Best for comparing trend shapes across annotations with very different
// EGC magnitudes.
//
// Returns 0 for all points when std dev = 0 (flat series — no variation).

export function applyZScore(
  data: { egc: number | null }[],
): { egc: number | null }[] {
  const vals = data
    .map(d => d.egc)
    .filter((v): v is number => v !== null)

  if (vals.length < 2) return data

  const mean = vals.reduce((a, b) => a + b, 0) / vals.length
  const std  = Math.sqrt(
    vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length,
  )

  if (std === 0) {
    return data.map(d => ({ ...d, egc: d.egc !== null ? 0 : null }))
  }

  return data.map(d => ({
    ...d,
    egc: d.egc !== null ? (d.egc - mean) / std : null,
  }))
}

// ── canApplyZScore ─────────────────────────────────────────────────────────
// applyZScore silently returns its input UNCHANGED (real, raw values) when
// fewer than 2 real points exist, so a caller showing the axis
// title/tooltip as if standardization happened would mislabel a raw value
// (e.g. nifH, K02588, 1 sample: its raw 1.13e-7 EGC value shown as
// "0.000σ"). Callers should check this
// (using the SAME array applyZScore was/would be given -- point count is
// unaffected by whether standardization actually ran) and fall back to the
// un-standardized label/tooltip format when it returns false, instead of
// trusting the raw `standardize` toggle state alone.

export function canApplyZScore(vals: (number | null)[]): boolean {
  return vals.filter((v): v is number => v !== null).length >= 2
}

// ── applyLowess ────────────────────────────────────────────────────────────
// Locally Weighted Scatterplot Smoothing (LOWESS).
//
// At each point, fits a weighted linear model using the nearest `span`
// neighbours by real elapsed time (`ts`, epoch milliseconds) -- NOT array
// index. This matters because a date/time filter can leave a gap in the
// array (e.g. a 12h step next to a normal 4h step); indexing by position
// would smooth that gap as if it were a uniform step. Closer points in time
// receive higher weight via the tricube kernel:
//   w = (1 − |u|³)³   where u = distance / max_distance_in_window
//
// The local regression is centred on each query point (regressor is
// `p.ts - pt.ts`, not the raw epoch value) so the fitted value at the query
// point is simply the intercept -- this also avoids catastrophic
// cancellation from squaring/differencing raw epoch-millisecond magnitudes.
//
// bandwidth: fraction of data used as neighbours per fit (0.1 – 0.8).
//   Lower → tighter fit to local fluctuations.
//   Higher → smoother global trend.
//
// The range starts at 0.1: at 0.01-0.05 a typical 128-sample series gets a
// span of only 2-7 points, too few to smooth anything.
//
// Points with egc = null are excluded from the fit but retained in the
// output array so the chart's x-axis alignment is preserved.
//
// Requires at least 3 non-null points; returns data unchanged otherwise.
//
// span floors at 3, not 2 -- a weighted linear fit through exactly 2
// points, evaluated at either one, reproduces that point's own y-value
// EXACTLY regardless of the weights, so span=2 is a mathematical no-op
// (any series with <=20 real points at the minimum bandwidth would change
// zero values while still labelled "(smoothed)"). Flooring at 3 (the same
// floor applyLowess already requires to run at all, see the length
// check below) means every fit uses at least 3 points, which can only
// reproduce a point's own value by exact coincidence (real floating-
// point EGC data lying perfectly collinear), not structurally.

// Fewer real points than this and smoothing would change nothing: below 3
// there is nothing to fit, and at exactly 3 the window covers the whole
// series, the farthest point gets zero weight, and every fitted value
// lands back on its own point. Such a series is returned as is.
export const LOWESS_MIN_POINTS = 4

export function applyLowess(
  data: { egc: number | null; ts: number }[],
  bandwidth: number,
): { egc: number | null; ts: number }[] {
  const pts = data
    .map((d, i) => ({ i, x: d.ts, y: d.egc }))
    .filter((p): p is { i: number; x: number; y: number } => p.y !== null)

  if (pts.length < LOWESS_MIN_POINTS) return data

  const n    = pts.length
  const span = Math.max(3, Math.ceil(bandwidth * n))
  const smoothed = new Map<number, number>()

  for (const pt of pts) {
    const dists    = pts.map(p => ({ p, d: Math.abs(p.x - pt.x) }))
    dists.sort((a, b) => a.d - b.d)
    const neighbors = dists.slice(0, span)
    // The tricube weight w=(1-u^3)^3 is exactly 0 at u=1 -- so using the
    // farthest INCLUDED point's own distance as maxDist would zero out that
    // point's contribution, silently shrinking every window by one real
    // point. maxDist is therefore the distance to the next point just
    // OUTSIDE the window, so every included point gets a real, nonzero
    // weight; it falls back to the included point's distance only when the
    // window already covers the entire series (no "next point" exists).
    // On the real ~4h-uniform cadence the farthest included point often
    // ties in distance with points just outside the window (at 9 of 15
    // slider settings), which would give it u=1 again -- so this advances
    // past every tied distance to the first
    // genuinely farther point, so the farthest included point's own
    // distance can never equal maxDist.
    const includedMaxD = neighbors[neighbors.length - 1].d
    let maxDist = includedMaxD || 1
    if (span < dists.length) {
      let j = span
      while (j < dists.length && dists[j].d === includedMaxD) j++
      maxDist = j < dists.length ? dists[j].d : (includedMaxD || 1)
    }

    let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0
    for (const { p, d } of neighbors) {
      const u  = d / maxDist
      const w  = Math.pow(1 - Math.pow(u, 3), 3)
      const dx = p.x - pt.x
      sw   += w
      swx  += w * dx
      swy  += w * p.y
      swxx += w * dx * dx
      swxy += w * dx * p.y
    }

    const denom = sw * swxx - swx * swx
    const b     = denom !== 0 ? (sw * swxy - swx * swy) / denom : 0
    const a     = (swy - b * swx) / sw
    smoothed.set(pt.i, a)
  }

  return data.map((d, i) => ({
    ...d,
    egc: smoothed.has(i) ? smoothed.get(i)! : d.egc,
  }))
}

// ── canApplyLowess ─────────────────────────────────────────────────────────
// Same shape as canApplyZScore above --
// applyLowess is a no-op with fewer than LOWESS_MIN_POINTS real points
// (its own early-return, mirrored here rather than duplicated), so this
// is whether it could ACTUALLY smooth anything, not just whether the
// toggle is on. Callers should check this and suppress "(smoothed)"
// labelling when it returns false, instead of trusting the raw
// `smoothed` toggle state alone.

export function canApplyLowess(vals: (number | null)[]): boolean {
  return vals.filter((v): v is number => v !== null).length >= LOWESS_MIN_POINTS
}
