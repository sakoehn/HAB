// ── Solar / Tide overlay utilities ──────────────────────────────────────────
// Pure functions for the day/night shading + tide-flow chart overlays.
// No React imports — safe to use in tests and non-component code.
//
// Shading direction is theme-aware via CSS variables (--shade-overlay,
// --shade-overlay-opacity), NOT JS branching — see App.css. This keeps
// the overlay in sync with however theme switching already works
// elsewhere in the app, with zero coupling between this utility and
// theme state.
//
// Validated approach (see shading mockup):
//   Dark mode  -> lighten DAY hours  (night = unshaded base dark)
//   Light mode -> darken NIGHT hours (day  = unshaded base light)
// Both directions shade AWAY from the page's natural background,
// guaranteeing contrast regardless of which theme is active.

export type SunTimes = Record<string, { sunrise: string; sunset: string }>

export type TidePoint = {
  time:         string  // "YYYY-MM-DD HH:MM", already shifted server-side
  predicted_wl: number  // meters
  tide_event:   string | null
}

export type NightBand = {
  x1:   string  // original datetime string, kept for CSV/debug readability
  x2:   string
  x1Ts: number  // Unix ms — what ReferenceArea actually needs on a
  x2Ts: number  // type="number" time-proportional axis
}

// ── parseLocalDateTime ──────────────────────────────────────────────────────
// Parse the "M/D/YY H:MM" timepoint format OR "YYYY-MM-DD HH:MM" tide format
// into a local Date. Both conventions are already aligned server-side
// (TIDE_SHIFT_HOURS applied in load_tides), so no further offsetting here.

function parseLocalDateTime(dt: string): Date | null {
  // "YYYY-MM-DD HH:MM" (tide/sun-times convention)
  const iso = dt.match(/^(\d{4})-(\d{2})-(\d{2})(?:\s+(\d{1,2}):(\d{2}))?/)
  if (iso) {
    const [, y, m, d, h, min] = iso
    return new Date(Number(y), Number(m) - 1, Number(d), Number(h ?? 0), Number(min ?? 0))
  }
  // "M/D/YY H:MM" (timepoints convention)
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

function hhmmToMinutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number)
  return h * 60 + m
}

// ── resolveSunTimes ──────────────────────────────────────────────────────
// Look up a date's sun-times entry, falling back to the nearest available
// date (by calendar-day distance) if the exact date is missing.
//
// This guards against a real failure mode: if the /sun-times response
// doesn't perfectly cover the chart's full data range (e.g. an off-by-one
// at the start/end boundary, or the chart later includes a date outside
// what was originally fetched), an exact-match-only lookup would classify
// every point on the missing day as "unknown" — which acts as a hard
// run-breaker in computeNightBands and truncates the night band right at
// that boundary (observed: a band that should span 9pm-5am instead only
// showing 1am-5am, because the 9pm-midnight portion fell on a day with no
// exact sun-times entry).
//
// Sunrise/sunset drift by only about a minute per day in this region, so
// falling back even several days is visually indistinguishable from the
// exact value — a reasonable trade for guaranteed coverage.

function resolveSunTimes(
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
    if (dist < closestDist) {
      closestDist = dist
      closest = d
    }
  }
  return closest ? sunTimes[closest] : null
}

// ── computeNightBands ────────────────────────────────────────────────────
// Given chart points (sorted, with a `datetime` field in either the
// timepoints or tide/sun-times convention) and a SunTimes lookup, classify
// each point as day/night using THAT POINT'S OWN calendar day's real
// sunrise/sunset, then merge consecutive night-classified points into a
// single band per continuous night run.
//
// This intentionally does NOT compute night bands per-calendar-day in
// isolation. An earlier version did, and it broke down badly with the
// real ~4-hour EGC sampling cadence: the pre-dawn window is only the
// 1:00/5:00 slots (sunrise is ~5:13-5:17 in this dataset), so any single
// missing slot collapsed that day's band to a single point or made it
// disappear entirely. Real data does have missing slots scattered
// through the dataset (e.g. several days have no 1:00 or no 5:00 row),
// so that fragility wasn't an edge case — it affected most nights.
//
// Merging consecutive night points into one run instead means a full
// night (e.g. 9pm one day through 5am the next) renders as ONE band
// spanning real sunset to real sunrise, using whichever sample points
// happen to exist at the edges of that run — so a single missing slot
// only shortens the band slightly rather than fragmenting or erasing it.
//
// Bands are clipped to the actual data range — we never invent x1/x2
// values outside what's present in `points`, since Recharts resolves
// ReferenceArea bounds against the categorical axis built from the data.
//
// Each point's sun-times entry is resolved via resolveSunTimes (nearest
// available date, not exact-match-only) — see that function's comment
// for why: an exact-match-only lookup would truncate the night band
// right at any date the sun-times response happens not to cover.
//
// Returns [] if sunTimes has no entries for any date in the range, or if
// fewer than 2 points are present.

// ── Boundary buffer ──────────────────────────────────────────────────────
// A sample is treated as night if it falls within this many minutes of
// the real sunset/sunrise, even if technically still on the daylight
// side. Without this, a fixed 4-hour sampling grid (1:00, 5:00, 9:00...)
// compared against a sunset/sunrise that drifts by about a minute per day
// produces a near-total, not occasional, failure: in this dataset's real
// sun-times response, sunset falls between 21:01 and 21:17 on 21 of 22
// days — so a 21:00 sample is classified as daytime on every night except
// the very first, and the entire post-dusk half of the night band never
// renders. 20 minutes is small relative to the 4-hour sampling cadence
// (no genuinely midday/midnight sample could ever fall within it) but
// comfortably covers this dataset's full sunset/sunrise drift range.
const BOUNDARY_BUFFER_MINUTES = 20

export function computeNightBands(
  points: { datetime: string }[],
  sunTimes: SunTimes,
): NightBand[] {
  if (points.length < 2 || !sunTimes || Object.keys(sunTimes).length === 0) return []

  // Classify each point using its own calendar day's sunrise/sunset
  // (falling back to the nearest available date if the exact day isn't
  // covered — see resolveSunTimes). isNight is null only when sunTimes
  // has no entries at all anywhere, which is already guarded above.
  const classified: { raw: string; ts: number; isNight: boolean | null }[] = []
  for (const pt of points) {
    const parsed = parseLocalDateTime(pt.datetime)
    if (!parsed) continue
    const ts      = parsed.getTime()
    const dateKey = toIsoDateKey(parsed)
    const sun = resolveSunTimes(dateKey, sunTimes)
    if (!sun) {
      classified.push({ raw: pt.datetime, ts, isNight: null })
      continue
    }
    const minutes     = parsed.getHours() * 60 + parsed.getMinutes()
    const sunriseMin   = hhmmToMinutes(sun.sunrise)
    const sunsetMin    = hhmmToMinutes(sun.sunset)
    const isNight       =
      minutes < sunriseMin + BOUNDARY_BUFFER_MINUTES ||
      minutes >= sunsetMin - BOUNDARY_BUFFER_MINUTES
    classified.push({ raw: pt.datetime, ts, isNight })
  }

  // Merge consecutive isNight===true points into bands.
  //
  // Gap-bridging: when STARTING a fresh run, check whether the point
  // immediately before it falls on a different calendar day. If so, a
  // sunset boundary was crossed between them with no sample landing
  // inside that boundary window at all — e.g. a day with no 21:00
  // sample, so the night classified-true point closest to that boundary
  // is the FOLLOWING day's pre-dawn sample, with nothing to merge with
  // on the post-dusk side. Anchoring the run's start at that previous
  // point (the real last sample before the gap) instead of at the first
  // night-classified point bridges the gap using two genuine existing
  // x-values, rather than leaving a zero-width/invisible band.
  //
  // This only changes behavior across a calendar-day change with no
  // anchor; a normal same-evening "day point -> night point" transition
  // (e.g. 17:00 day, 21:00 night) is on the same calendar day and is
  // unaffected — confirmed byte-identical against the no-gap case.
  const bands: NightBand[] = []
  let runStart: { raw: string; ts: number } | null = null
  for (let i = 0; i < classified.length; i++) {
    const c = classified[i]
    if (c.isNight === true) {
      if (runStart === null) {
        if (i > 0) {
          const prev = classified[i - 1]
          const prevDateKey = toIsoDateKey(parseLocalDateTime(prev.raw)!)
          const curDateKey  = toIsoDateKey(parseLocalDateTime(c.raw)!)
          runStart = prevDateKey !== curDateKey
            ? { raw: prev.raw, ts: prev.ts }
            : { raw: c.raw, ts: c.ts }
        } else {
          runStart = { raw: c.raw, ts: c.ts }
        }
      }
    } else if (runStart !== null) {
      const end = classified[i - 1]
      bands.push({ x1: runStart.raw, x2: end.raw, x1Ts: runStart.ts, x2Ts: end.ts })
      runStart = null
    }
  }
  if (runStart !== null) {
    const end = classified[classified.length - 1]
    bands.push({ x1: runStart.raw, x2: end.raw, x1Ts: runStart.ts, x2Ts: end.ts })
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

export function alignTideToChartPoints(
  chartDatetimes: string[],
  tides:          TidePoint[],
  maxGapMinutes:  number = 30,
): Map<string, number | null> {
  const result = new Map<string, number | null>()
  if (tides.length === 0) {
    for (const dt of chartDatetimes) result.set(dt, null)
    return result
  }

  // Tides are already chronological from the backend; build parallel
  // arrays once for binary search instead of re-scanning per chart point.
  const tideTimes = tides.map(t => parseLocalDateTime(t.time)?.getTime() ?? null)

  for (const dt of chartDatetimes) {
    const target = parseLocalDateTime(dt)?.getTime()
    if (target == null) {
      result.set(dt, null)
      continue
    }

    // Binary search for closest tide timestamp
    let lo = 0
    let hi = tideTimes.length - 1
    while (lo < hi) {
      const mid = (lo + hi) >> 1
      const tMid = tideTimes[mid]
      if (tMid == null || tMid < target) lo = mid + 1
      else hi = mid
    }

    let best = lo
    if (lo > 0) {
      const prevDiff = Math.abs((tideTimes[lo - 1] ?? Infinity) - target)
      const curDiff  = Math.abs((tideTimes[lo] ?? Infinity) - target)
      if (prevDiff < curDiff) best = lo - 1
    }

    const bestTime = tideTimes[best]
    if (bestTime == null) {
      result.set(dt, null)
      continue
    }

    const gapMinutes = Math.abs(bestTime - target) / 60_000
    result.set(dt, gapMinutes <= maxGapMinutes ? tides[best].predicted_wl : null)
  }

  return result
}