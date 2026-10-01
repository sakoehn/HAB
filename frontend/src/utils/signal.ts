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
// W (2.6, docs/AUDIT-2026-09-22.md): applyZScore silently returns its input
// UNCHANGED (real, raw values) when fewer than 2 real points exist -- but
// callers kept showing the axis title/tooltip as if standardization had
// happened regardless ("Z-score, σ from mean", a bare value + "σ" in the
// tooltip). Confirmed live: nifH (K02588, 1 sample) plotted its raw
// 1.13e-7 EGC value with the tooltip "0.000σ" -- a real number presented
// as a standardized one it never actually was. Callers should check this
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
// W27 (docs/AUDIT-2026-09-22.md): this range used to be 0.01-0.05 -- for a
// typical 128-sample series that's a span of only 2-7 points, and combined
// with the tricube-weight bug below (fixed here), meant "0 of 128 points
// change" at the two lowest slider settings, confirmed live on real COG0055
// data before this fix.
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
    // W27 (docs/AUDIT-2026-09-22.md): the tricube weight w=(1-u^3)^3 is
    // exactly 0 at u=1 -- so using the farthest INCLUDED point's own
    // distance as maxDist always zeroed out that point's contribution,
    // silently shrinking every window by one real point (worst for small
    // spans: with span=2, the only other point in the window got weight 0,
    // making the "fit" just return the point's own unweighted value
    // unchanged). Using the distance to the next point just OUTSIDE the
    // window instead means every included point gets a real, nonzero
    // weight. Falls back to the old boundary behavior only when the
    // window already covers the entire series (no "next point" exists).
    const maxDist = span < dists.length
      ? (dists[span].d || 1)
      : (neighbors[neighbors.length - 1].d || 1)

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
