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
// bandwidth: fraction of data used as neighbours per fit (0.01 – 0.05).
//   Lower → tighter fit to local fluctuations.
//   Higher → smoother global trend.
//
// Points with egc = null are excluded from the fit but retained in the
// output array so the chart's x-axis alignment is preserved.
//
// Requires at least 3 non-null points; returns data unchanged otherwise.

export function applyLowess(
  data: { egc: number | null; ts: number }[],
  bandwidth: number,
): { egc: number | null; ts: number }[] {
  const pts = data
    .map((d, i) => ({ i, x: d.ts, y: d.egc }))
    .filter((p): p is { i: number; x: number; y: number } => p.y !== null)

  if (pts.length < 3) return data

  const n    = pts.length
  const span = Math.max(2, Math.ceil(bandwidth * n))
  const smoothed = new Map<number, number>()

  for (const pt of pts) {
    const dists    = pts.map(p => ({ p, d: Math.abs(p.x - pt.x) }))
    dists.sort((a, b) => a.d - b.d)
    const neighbors = dists.slice(0, span)
    const maxDist   = neighbors[neighbors.length - 1].d || 1

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
