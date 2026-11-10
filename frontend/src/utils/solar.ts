// ── Solar / Tide overlay utilities ──────────────────────────────────────────
// Pure functions for the day/night shading + tide-flow chart overlays.
// No React imports — safe to use in tests and non-component code.

import { toPlotlyDate } from './format'

export type SunTimes = Record<string, { sunrise: string; sunset: string }>

export type TidePoint = {
  time:         string  // "YYYY-MM-DD HH:MM", already shifted server-side
  predicted_wl: number  // meters
  tide_event:   string | null
}

export type NightBand = {
  x1:   string  // "YYYY-MM-DD" of the sunset day
  x2:   string  // "YYYY-MM-DD" of the sunrise day
  x1Ts: number  // Unix ms — exact sunset timestamp
  x2Ts: number  // Unix ms — exact sunrise timestamp
}

// ── parseLocalDateTime ──────────────────────────────────────────────────────
// Parse "M/D/YY H:MM" (timepoints) or "YYYY-MM-DD HH:MM" (tide/sun-times)
// into a local Date. Both formats are already in PDT convention server-side.

function parseLocalDateTime(dt: string): Date | null {
  // "YYYY-MM-DD HH:MM"
  const iso = dt.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/)
  if (iso) {
    const [, y, m, d, h, min] = iso
    return new Date(Number(y), Number(m) - 1, Number(d), Number(h ?? 0), Number(min ?? 0))
  }
  // "M/D/YY H:MM"
  const mdy = dt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/)
  if (mdy) {
    const [, m, d, yRaw, h, min] = mdy
    const y = Number(yRaw) < 100 ? Number(yRaw) + 2000 : Number(yRaw)
    return new Date(y, Number(m) - 1, Number(d), Number(h ?? 0), Number(min ?? 0))
  }
  return null
}

function toIsoDateKey(date: Date): string {
  const y = date.getFullYear()
  const m = String(date.getMonth() + 1).padStart(2, '0')
  const d = String(date.getDate()).padStart(2, '0')
  return `${y}-${m}-${d}`
}

function sunTimeToMs(dateKey: string, hhMM: string): number | null {
  const d = parseLocalDateTime(dateKey + ' ' + hhMM)
  return d ? d.getTime() : null
}

// ── resolveSunTimes ──────────────────────────────────────────────────────
// Look up a date's sun-times entry, falling back to the nearest available
// date if the exact key is missing (e.g. a boundary day not covered by the
// API response). Sunrise/sunset drift only ~1 min/day, so a nearby fallback
// is visually indistinguishable from the exact value.

export function resolveSunTimes(
  dateKey: string,
  sunTimes: SunTimes,
): { sunrise: string; sunset: string } | null {
  if (sunTimes[dateKey]) return sunTimes[dateKey]

  const availableDates = Object.keys(sunTimes)
  if (availableDates.length === 0) return null

  const target = parseLocalDateTime(dateKey + ' 0:00')
  if (!target) return null

  let closest: string | null = null
  let closestDist = Infinity
  for (const d of availableDates) {
    const candidate = parseLocalDateTime(d + ' 0:00')
    if (!candidate) continue
    const dist = Math.abs(candidate.getTime() - target.getTime())
    if (dist < closestDist) { closestDist = dist; closest = d }
  }
  return closest ? sunTimes[closest] : null
}

// ── computeNightBands ────────────────────────────────────────────────────
// Generate night-shading bands from pure astronomical data, with no
// dependence on where data points fall. For each calendar day N in the
// data range, emit one band spanning [sunset(N), sunrise(N+1)] — exact
// times from the sun-times lookup, not snapped to sample positions.
//
// Bands are clipped to the data's [minTs, maxTs] range so Plotly shapes
// don't expand the x-axis beyond what the chart data covers.

export function computeNightBands(
  points: { datetime: string }[],
  sunTimes: SunTimes,
): NightBand[] {
  if (points.length < 2 || Object.keys(sunTimes).length === 0) return []

  // Find the timestamp range of the data
  let minTs = Infinity, maxTs = -Infinity
  for (const pt of points) {
    const d = parseLocalDateTime(pt.datetime)
    if (!d) continue
    const ts = d.getTime()
    if (ts < minTs) minTs = ts
    if (ts > maxTs) maxTs = ts
  }
  if (!isFinite(minTs)) return []

  const bands: NightBand[] = []

  // Start one day before the first data point to catch any pre-dawn night
  // that began the previous evening.
  const first  = new Date(minTs)
  const last   = new Date(maxTs)
  const endDay = new Date(last.getFullYear(),  last.getMonth(),  last.getDate())

  let cur = new Date(first.getFullYear(), first.getMonth(), first.getDate() - 1)

  while (cur <= endDay) {
    const curKey  = toIsoDateKey(cur)
    const nextDay = new Date(cur.getFullYear(), cur.getMonth(), cur.getDate() + 1)
    const nextKey = toIsoDateKey(nextDay)

    const sunCur  = resolveSunTimes(curKey,  sunTimes)
    const sunNext = resolveSunTimes(nextKey, sunTimes)

    if (sunCur && sunNext) {
      const sunsetTs  = sunTimeToMs(curKey,  sunCur.sunset)
      const sunriseTs = sunTimeToMs(nextKey, sunNext.sunrise)

      if (sunsetTs !== null && sunriseTs !== null) {
        // Clip to data range so shapes don't extend the axis beyond the data
        const x1Ts = Math.max(sunsetTs,  minTs)
        const x2Ts = Math.min(sunriseTs, maxTs)
        if (x1Ts < x2Ts) {
          bands.push({ x1: curKey, x2: nextKey, x1Ts, x2Ts })
        }
      }
    }

    cur = nextDay
  }

  return bands
}

// ── alignTideToChartPoints ───────────────────────────────────────────────
// Map raw /api/tides rows (6-min resolution, full dataset range) onto a
// sparser set of chart x-values (sample datetimes) by nearest-neighbor
// lookup, so the tide Area series shares the same categorical x-axis as
// the EGC Line series — required for Recharts to render both on one
// ComposedChart without a second, independent x scale.
//
// Returns a Map from chart datetime string -> predicted_wl (meters), or
// null for points with no tide reading within `maxGapMinutes` (default
// 30 — half the 6-min-resolution data's typical worst-case gap many
// times over, conservative for the 4h EGC sampling cadence).

export const TIDE_MATCH_MAX_MINUTES = 30

export function alignTideToChartPoints(
  chartDatetimes: string[],
  tides:          TidePoint[],
  maxGapMinutes:  number = TIDE_MATCH_MAX_MINUTES,
): Map<string, number | null> {
  const result = new Map<string, number | null>()
  if (tides.length === 0) {
    for (const dt of chartDatetimes) result.set(dt, null)
    return result
  }

  const tideTimes = tides.map(t => parseLocalDateTime(t.time)?.getTime() ?? null)

  for (const dt of chartDatetimes) {
    const target = parseLocalDateTime(dt)?.getTime()
    if (target == null) {
      result.set(dt, null)
      continue
    }

    let lo = 0
    let hi = tideTimes.length - 1
    while (lo < hi) {
      const mid  = (lo + hi) >> 1
      const tMid = tideTimes[mid]
      if (tMid == null || tMid < target) lo = mid + 1
      else hi = mid
    }

    let best = lo
    if (lo > 0) {
      const prevDiff = Math.abs((tideTimes[lo - 1] ?? Infinity) - target)
      const curDiff  = Math.abs((tideTimes[lo]     ?? Infinity) - target)
      if (prevDiff < curDiff) best = lo - 1
    }

    const bestTime = tideTimes[best]
    if (bestTime == null) { result.set(dt, null); continue }

    const gapMinutes = Math.abs(bestTime - target) / 60_000
    result.set(dt, gapMinutes <= maxGapMinutes ? tides[best].predicted_wl : null)
  }

  return result
}

// ── nativeTideTrace ───────────────────────────────────────────────────────
// Snapping the real 6-min-resolution tide data onto the sparse
// (4h-cadence) EGC sample timestamps (alignTideToChartPoints) would distort
// the tide overlay: on the real /api/tides data that shows 59 turning
// points instead of 72, up to 1.07m error, and the wrong flood/ebb
// direction 15.8% of the time (a turning point strictly between two
// samples is invisible; the straight line connecting their snapped values
// can show the opposite of what's actually happening). Plotly doesn't need
// a shared categorical x-axis -- the day/night band shapes in these chart
// components already plot at arbitrary real timestamps -- so this returns the tide series at its
// own native resolution, completely independent of EGC sample timestamps,
// for the VISUAL trace. alignTideToChartPoints is kept for CSV export's
// per-sample-row tide_predicted_wl_m column, a different, legitimate need
// (one tide value per exported EGC row) that this function doesn't serve.
//
// fromIso/toIso ('YYYY-MM-DD', inclusive) restrict the trace to the chart's
// visible date range, if any -- omit either to leave that side unbounded.

export function nativeTideTrace(
  tides:   TidePoint[],
  fromIso?: string,
  toIso?:   string,
  // The chart's first/last sample time: readings outside it are dropped so
  // the tide line doesn't stretch the x-axis past the data.
  span?:    { fromTs?: number; toTs?: number },
): { x: string[]; y: number[] } {
  const x: string[] = []
  const y: number[] = []

  for (const t of tides) {
    const tideDate = t.time.slice(0, 10)
    if (fromIso && tideDate < fromIso) continue
    if (toIso   && tideDate > toIso)   continue
    const ts = parseLocalDateTime(t.time)?.getTime()
    if (ts == null) continue
    if (span?.fromTs != null && ts < span.fromTs) continue
    if (span?.toTs   != null && ts > span.toTs)   continue
    x.push(toPlotlyDate(ts))
    y.push(t.predicted_wl)
  }

  return { x, y }
}
