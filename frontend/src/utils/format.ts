// ── Formatting Utilities ──────────────────────────────────────────────────────
// Pure functions for date/time parsing and display formatting.
// No React imports — safe to use in tests and non-component code.

// ── parseMMDDYY ────────────────────────────────────────────────────────────
// Explicitly recognize and parse the "MM/DD/YY HH:MM" (or "MM/DD/YY")
// format used by the JGI timepoints CSV. This format is NOT passed to
// `new Date()` anywhere in this file, because two-digit years in
// slash-separated date strings are parsed inconsistently across JS engines
// (e.g. "21" may be interpreted as 1921 rather than 2021, or month/day
// order may be misread). Parsing this format manually guarantees the
// month, day, year, hour, and minute always mean exactly what they say.
//
// Returns null if `dt` doesn't match the "MM/DD/YY[ HH:MM]" shape — callers
// should fall back to `new Date(dt)` for ISO-format strings in that case.

function parseMMDDYY(dt: string): {
  month: number  // 1-12
  day:   number  // 1-31
  year:  number  // full 4-digit year
  hour:  number  // 0-23
  min:   number  // 0-59
} | null {
  const match = dt.match(/^(\d{1,2})\/(\d{1,2})\/(\d{2,4})(?:\s+(\d{1,2}):(\d{2}))?/)
  if (!match) return null

  const [, mStr, dStr, yStr, hStr, minStr] = match
  const month = Number(mStr)
  const day   = Number(dStr)
  let   year  = Number(yStr)
  if (year < 100) year += 2000

  return {
    month,
    day,
    year,
    hour: Number(hStr ?? 0),
    min:  Number(minStr ?? 0),
  }
}

// ── parseDateTime ──────────────────────────────────────────────────────────
// Parse a datetime string to a Unix timestamp (ms) for sorting.
// Handles both ISO format and the "MM/DD/YY HH:MM" format used in the
// JGI timepoints CSV.
// Returns 0 for empty or unparseable strings so sort order degrades
// gracefully rather than throwing.

// ── toPlotlyDate ───────────────────────────────────────────────────────────
// Format a Unix ms timestamp as "YYYY-MM-DD HH:MM:SS" in LOCAL time,
// which Plotly treats as a naive (timezone-free) datetime on its date axis.
// Using local time methods means the string round-trips correctly to the
// original clock time stored in the timestamp, regardless of browser timezone.
// This avoids the UTC-offset shift that `toISOString()` introduces:
// e.g. 21:00 PDT → "2021-06-13T04:00:00.000Z" (wrong label) vs
//                  "2021-06-12 21:00:00"        (correct label).

export function toPlotlyDate(ts: number): string {
  const d   = new Date(ts)
  const y   = d.getFullYear()
  const mo  = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const h   = String(d.getHours()).padStart(2, '0')
  const min = String(d.getMinutes()).padStart(2, '0')
  const sec = String(d.getSeconds()).padStart(2, '0')
  return `${y}-${mo}-${day} ${h}:${min}:${sec}`
}

export function parseDateTime(dt: string): number {
  if (!dt) return 0

  const mdy = parseMMDDYY(dt)
  if (mdy) {
    return new Date(mdy.year, mdy.month - 1, mdy.day, mdy.hour, mdy.min).getTime()
  }

  const d = new Date(dt)
  return isNaN(d.getTime()) ? 0 : d.getTime()
}

// ── fmtDate ────────────────────────────────────────────────────────────────
// Format a datetime string as "MM/DD/YY" for axis labels and table cells.
// Falls back to the date portion of the raw string if parsing fails.

export function fmtDate(dt: string): string {
  if (!dt) return ''

  const mdy = parseMMDDYY(dt)
  if (mdy) {
    const m   = String(mdy.month).padStart(2, '0')
    const day = String(mdy.day).padStart(2, '0')
    const yr  = String(mdy.year).slice(2)
    return `${m}/${day}/${yr}`
  }

  const d = new Date(dt)
  if (isNaN(d.getTime())) return dt.split(' ')[0]

  const m   = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  const yr  = String(d.getFullYear()).slice(2)
  return `${m}/${day}/${yr}`
}

// ── fmtTime ────────────────────────────────────────────────────────────────
// Format a datetime string as "HH:MM" (24-hour) for table cells.
// Falls back to the time portion of the raw string if parsing fails.

export function fmtTime(dt: string): string {
  if (!dt) return ''

  const mdy = parseMMDDYY(dt)
  if (mdy) {
    return `${String(mdy.hour).padStart(2, '0')}:${String(mdy.min).padStart(2, '0')}`
  }

  const d = new Date(dt)
  if (isNaN(d.getTime())) {
    const parts = dt.split(' ')
    return parts[1] ?? ''
  }

  return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
}

// ── isoDate ────────────────────────────────────────────────────────────────
// Extract the ISO date portion ("YYYY-MM-DD") from a datetime string.
// Used for date-range comparisons and HTML date input values.
// Falls back to the first 10 characters if parsing fails.

export function isoDate(dt: string): string {
  if (!dt) return ''

  const mdy = parseMMDDYY(dt)
  if (mdy) {
    const m   = String(mdy.month).padStart(2, '0')
    const day = String(mdy.day).padStart(2, '0')
    return `${mdy.year}-${m}-${day}`
  }

  const d = new Date(dt)
  if (isNaN(d.getTime())) return dt.slice(0, 10)

  return d.toISOString().slice(0, 10)
}

// ── computeDayBands ────────────────────────────────────────────────────────
// Given a sorted list of points with a datetime field, return alternating
// day shading bands for ReferenceArea in Recharts.
//
// Shade parity is computed from the REAL CALENDAR-DAY DISTANCE between each
// group's date and the first date in the series — not from the sequential
// index of groups-with-data. This matters because real sampling can have
// gaps (a day with zero samples never becomes its own group), and indexing
// by group position would silently desync the shade parity for every day
// after a gap, flipping shading for the rest of the dataset even though
// nothing about that data is actually unusual. Anchoring to elapsed
// calendar days makes each day's shade deterministic and independent of
// which other days happen to have data.
//
// Returns [] when fewer than 2 points are present.

export function computeDayBands(
  points: { datetime: string }[],
): { x1: string; x2: string; x1Ts: number; x2Ts: number; shade: boolean }[] {
  if (points.length < 2) return []

  // Group consecutive points by calendar date (MM/DD/YY portion)
  const dayGroups: { date: string; points: { datetime: string }[] }[] = []
  for (const pt of points) {
    const day  = pt.datetime.split(' ')[0] ?? ''
    const last = dayGroups[dayGroups.length - 1]
    if (last && last.date === day) {
      last.points.push(pt)
    } else {
      dayGroups.push({ date: day, points: [pt] })
    }
  }

  if (dayGroups.length === 0) return []

  const MS_PER_DAY = 24 * 60 * 60 * 1000
  const firstDate  = parseGroupDate(dayGroups[0].date)

  return dayGroups.map(group => {
    const groupDate = parseGroupDate(group.date)
    // Round (rather than floor) to absorb any DST-related fractional-day
    // drift between local Date objects constructed at midnight.
    const daysSinceStart = Math.round(
      (groupDate.getTime() - firstDate.getTime()) / MS_PER_DAY,
    )
    const x1 = group.points[0].datetime
    const x2 = group.points[group.points.length - 1].datetime
    return {
      x1,
      x2,
      // x1Ts/x2Ts: midnight-to-23:59:59.999 boundaries for the calendar day.
      // The x-axis is type="number" (Unix ms) so ReferenceArea accepts any
      // timestamp — not just values that match a data point. Using the full
      // calendar day means bands extend to the true day boundary rather than
      // snapping to the nearest sample. The explicit Date constructor for x2Ts
      // is DST-safe (JS resolves local time correctly); +86400000-1 would be
      // wrong on spring-forward days (23-hour days) and land 1 h into the next day.
      x1Ts:  groupDate.getTime(),
      x2Ts:  new Date(
        groupDate.getFullYear(),
        groupDate.getMonth(),
        groupDate.getDate(),
        23, 59, 59, 999,
      ).getTime(),
      shade: daysSinceStart % 2 === 0,
    }
  })
}

// ── parseGroupDate ───────────────────────────────────────────────────────
// Parse a "M/D/YY" calendar-date string (the `date` key produced by
// computeDayBands's grouping step) into a local midnight Date, for elapsed
// day-count arithmetic. Distinct from parseMMDDYY since the input here is
// always already-validated date-only text (no time component to parse),
// not raw user-facing datetime strings.

function parseGroupDate(dateStr: string): Date {
  const [m, d, y] = dateStr.split('/').map(Number)
  const year = y < 100 ? y + 2000 : y
  return new Date(year, (m || 1) - 1, d || 1)
}

// ── makeTickFormatter ──────────────────────────────────────────────────────
// Returns a context-aware XAxis tick formatter for EgcChart.
//
// Wide view  (> 2 days): show MM/DD.
// Zoomed view (≤ 2 days): show HH:MM.
//
// Formats directly from the numeric `value` via `new Date(value)`, rather
// than looking up `value` in a table of real data points. That distinction
// matters because the XAxis is type="number" (time-proportional): Recharts
// generates its own evenly-spaced tick positions across the numeric domain,
// and those positions essentially never land exactly on a real sample's
// timestamp (confirmed: with ~22 days of data, only the very first and
// last auto-generated ticks coincided with an actual point). An
// exact-match lookup therefore returned '' for nearly every tick, which is
// why dates stopped appearing on the axis after the time-scale switch.
// Formatting straight from the Date object works for any tick value
// Recharts chooses to generate.
//
// `points`/`uniqueDayCount` are still accepted (unused by the formatter
// itself now) to keep call sites and the wide/zoomed threshold decision
// unchanged — only the lookup mechanism changed, not the function's role.

export function makeTickFormatter(
  points: { datetime: string; ts: number }[],
  uniqueDayCount: number,
): (value: number) => string {
  if (uniqueDayCount > 2) {
    return (value: number) => {
      const d = new Date(value)
      if (isNaN(d.getTime())) return ''
      return `${d.getMonth() + 1}/${d.getDate()}`
    }
  }

  return (value: number) => {
    const d = new Date(value)
    if (isNaN(d.getTime())) return ''
    return `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

// ── buildAxisTicks ───────────────────────────────────────────────────────
// Returns an explicit array of timestamps to pass as XAxis's `ticks` prop.
//
// Needed because Recharts' default tick generation on a type="number"
// axis picks a small number of "nice" evenly-spaced values across the
// domain (observed: ~4-5 ticks regardless of how many days the data
// spans), which is too sparse for a chart meant to be read day-by-day.
// Passing `ticks` explicitly bypasses that auto-generation entirely.
//
// Wide view  (> 2 days): one tick per calendar day, thinned to at most
// `maxTicks` by taking every Nth day if there are more days than that
// (so labels stay readable at -40° rotation regardless of how wide the
// date range gets — e.g. the full 23-day dataset thins to every 2nd day
// rather than rendering all 23 and overlapping).
// Zoomed view (≤ 2 days): one tick per sample, so every point gets an
// HH:MM label — matches makeTickFormatter's zoomed-view granularity.

export function buildAxisTicks(
  points: { datetime: string; ts: number }[],
  uniqueDayCount: number,
  maxTicks: number = 15,
): number[] {
  if (points.length === 0) return []

  if (uniqueDayCount <= 2) {
    return points.map(p => p.ts)
  }

  const seenDays: Set<string> = new Set()
  const dayTicks: number[] = []
  for (const p of points) {
    const day = p.datetime.split(' ')[0] ?? ''
    if (!seenDays.has(day)) {
      seenDays.add(day)
      dayTicks.push(p.ts)
    }
  }

  if (dayTicks.length <= maxTicks) return dayTicks

  const step = Math.ceil(dayTicks.length / maxTicks)
  return dayTicks.filter((_, i) => i % step === 0)
}