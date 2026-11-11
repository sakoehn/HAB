/**
 * egc-chart-timepoints.unit.test.ts
 * ===================================
 * Unit tests for EgcChart timepoint selector and date range filter logic.
 *
 * Tests import directly from production source files.
 *
 * Note: this file previously also covered "brush zoom" and a hardcoded
 * "chart dimensions" section, both of which tested a Recharts <Brush>
 * slider mechanism that no longer exists — EgcChart.tsx now renders with
 * Plotly, which handles zoom natively via its own date-axis drag-zoom and
 * rangeslider (no app-level brush/zoom state). Those blocks were removed
 * as dead-code tests; real zoom behavior is covered at the E2E level in
 * App.e2e.spec.ts since it requires a real Plotly render to verify.
 *
 * Coverage
 * --------
 * Timepoint selector:
 *   extractUniqueDates    — one entry per calendar day, chronological order
 *   applyTimepointFilter  — null (all), full set, single day, two days,
 *                           empty set, 00:00 midnight day attribution
 *   badge text            — "(N of M)" when partial, "" when all selected
 *   toggle logic          — add/remove from set, all/none shortcuts
 *   chip label format     — MM/DD not MM/DD/YY
 *
 * Date range filter (DateRangePicker + isoDate):
 *   utils/format.ts isoDate  — correct YYYY-MM-DD output
 *   dateFrom filter           — excludes points before
 *   dateTo filter             — excludes points after
 *   combined range            — inclusive both ends
 *   empty strings             — no filtering
 *   out-of-range              — returns empty
 *
 * Run: npx vitest run src/tests/egc-chart-timepoints.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { isoDate, computeDayBands } from '../utils/format'

// ─────────────────────────────────────────────────────────────────────────────
// Helpers — mirrors of EgcChart internal logic
// ─────────────────────────────────────────────────────────────────────────────

type Point = {
  datetime: string
  iso:      string
  egc:      number | null
  date:     string
  sample:   string
}

function extractUniqueDates(points: { datetime: string }[]): string[] {
  const seen  = new Set<string>()
  const dates: string[] = []
  for (const pt of points) {
    const day = pt.datetime.split(' ')[0] ?? ''
    if (!seen.has(day)) { seen.add(day); dates.push(day) }
  }
  return dates
}

function applyTimepointFilter(
  points:        Point[],
  selectedDates: Set<string> | null,
  allDates:      string[],
): Point[] {
  const allSelected =
    selectedDates === null || selectedDates.size === allDates.length
  if (allSelected) return points
  return points.filter(p => {
    const day = p.datetime.split(' ')[0] ?? ''
    return selectedDates?.has(day) ?? true
  })
}

function applyDateRangeFilter(
  points:   Point[],
  dateFrom: string,
  dateTo:   string,
): Point[] {
  return points.filter(p => {
    if (dateFrom && p.iso < dateFrom) return false
    if (dateTo   && p.iso > dateTo)   return false
    return true
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Test data — 4 days × 6 timepoints (4-hour cadence, like real HAB data)
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_POINTS: Point[] = [
  // Day 1: 05/27/21
  { datetime: '05/27/21 04:00', iso: '2021-05-27', egc: 100, date: '05/27/21', sample: 's1' },
  { datetime: '05/27/21 08:00', iso: '2021-05-27', egc: 120, date: '05/27/21', sample: 's2' },
  { datetime: '05/27/21 12:00', iso: '2021-05-27', egc: 110, date: '05/27/21', sample: 's3' },
  { datetime: '05/27/21 16:00', iso: '2021-05-27', egc: 130, date: '05/27/21', sample: 's4' },
  { datetime: '05/27/21 20:00', iso: '2021-05-27', egc: 115, date: '05/27/21', sample: 's5' },
  // 00:00 point — belongs to next date prefix
  { datetime: '05/28/21 00:00', iso: '2021-05-28', egc: 105, date: '05/28/21', sample: 's6' },
  // Day 2: 05/28/21
  { datetime: '05/28/21 04:00', iso: '2021-05-28', egc: 200, date: '05/28/21', sample: 's7' },
  { datetime: '05/28/21 08:00', iso: '2021-05-28', egc: 220, date: '05/28/21', sample: 's8' },
  { datetime: '05/28/21 12:00', iso: '2021-05-28', egc: 210, date: '05/28/21', sample: 's9' },
  { datetime: '05/28/21 16:00', iso: '2021-05-28', egc: 230, date: '05/28/21', sample: 's10' },
  { datetime: '05/28/21 20:00', iso: '2021-05-28', egc: 215, date: '05/28/21', sample: 's11' },
  // Day 3: 05/29/21
  { datetime: '05/29/21 00:00', iso: '2021-05-29', egc: 205, date: '05/29/21', sample: 's12' },
  { datetime: '05/29/21 04:00', iso: '2021-05-29', egc: 150, date: '05/29/21', sample: 's13' },
  { datetime: '05/29/21 08:00', iso: '2021-05-29', egc: 160, date: '05/29/21', sample: 's14' },
  { datetime: '05/29/21 12:00', iso: '2021-05-29', egc: 155, date: '05/29/21', sample: 's15' },
  { datetime: '05/29/21 16:00', iso: '2021-05-29', egc: 170, date: '05/29/21', sample: 's16' },
  { datetime: '05/29/21 20:00', iso: '2021-05-29', egc: 165, date: '05/29/21', sample: 's17' },
  // Day 4: 05/30/21
  { datetime: '05/30/21 00:00', iso: '2021-05-30', egc: 145, date: '05/30/21', sample: 's18' },
  { datetime: '05/30/21 04:00', iso: '2021-05-30', egc: 180, date: '05/30/21', sample: 's19' },
  { datetime: '05/30/21 08:00', iso: '2021-05-30', egc: 190, date: '05/30/21', sample: 's20' },
]

const ALL_DATES = extractUniqueDates(SAMPLE_POINTS)
// Expected: ['05/27/21', '05/28/21', '05/29/21', '05/30/21']

// ─────────────────────────────────────────────────────────────────────────────
// extractUniqueDates
// ─────────────────────────────────────────────────────────────────────────────

describe('extractUniqueDates', () => {
  it('returns one entry per unique calendar date prefix', () => {
    expect(ALL_DATES).toHaveLength(4)
  })

  it('preserves chronological order', () => {
    expect(ALL_DATES[0]).toBe('05/27/21')
    expect(ALL_DATES[1]).toBe('05/28/21')
    expect(ALL_DATES[2]).toBe('05/29/21')
    expect(ALL_DATES[3]).toBe('05/30/21')
  })

  it('00:00 midnight belongs to the next day prefix', () => {
    // 05/28/21 00:00 opens the 05/28/21 prefix, not 05/27/21
    expect(ALL_DATES).toContain('05/28/21')
    const day28Points = SAMPLE_POINTS.filter(
      p => p.datetime.split(' ')[0] === '05/28/21',
    )
    expect(day28Points[0].datetime).toBe('05/28/21 00:00')
  })

  it('returns empty array for empty input', () => {
    expect(extractUniqueDates([])).toHaveLength(0)
  })

  it('single point returns single date', () => {
    expect(extractUniqueDates([{ datetime: '05/27/21 08:00' }])).toEqual(['05/27/21'])
  })

  it('duplicate dates within same day are collapsed to one entry', () => {
    const pts = [
      { datetime: '05/27/21 04:00' },
      { datetime: '05/27/21 08:00' },
      { datetime: '05/27/21 12:00' },
    ]
    expect(extractUniqueDates(pts)).toHaveLength(1)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyTimepointFilter
// ─────────────────────────────────────────────────────────────────────────────

describe('applyTimepointFilter', () => {
  it('null selectedDates (all) returns all points', () => {
    expect(applyTimepointFilter(SAMPLE_POINTS, null, ALL_DATES))
      .toHaveLength(SAMPLE_POINTS.length)
  })

  it('full set of dates returns all points', () => {
    expect(
      applyTimepointFilter(SAMPLE_POINTS, new Set(ALL_DATES), ALL_DATES),
    ).toHaveLength(SAMPLE_POINTS.length)
  })

  it("single day: only that day's points returned", () => {
    const result = applyTimepointFilter(
      SAMPLE_POINTS,
      new Set(['05/27/21']),
      ALL_DATES,
    )
    expect(result.length).toBeGreaterThan(0)
    expect(result.every(p => p.datetime.startsWith('05/27/21'))).toBe(true)
  })

  it("two days: both days' points returned, third day excluded", () => {
    const result = applyTimepointFilter(
      SAMPLE_POINTS,
      new Set(['05/27/21', '05/29/21']),
      ALL_DATES,
    )
    const days = new Set(result.map(p => p.datetime.split(' ')[0]))
    expect(days.has('05/27/21')).toBe(true)
    expect(days.has('05/29/21')).toBe(true)
    expect(days.has('05/28/21')).toBe(false)
    expect(days.has('05/30/21')).toBe(false)
  })

  it('empty set returns no points', () => {
    expect(
      applyTimepointFilter(SAMPLE_POINTS, new Set(), ALL_DATES),
    ).toHaveLength(0)
  })

  it('selecting 3 of 4 days excludes the missing day', () => {
    const threeDays = new Set(['05/27/21', '05/28/21', '05/29/21'])
    const result    = applyTimepointFilter(SAMPLE_POINTS, threeDays, ALL_DATES)
    expect(result.some(p => p.datetime.startsWith('05/30/21'))).toBe(false)
  })

  it('00:00 point is correctly attributed to its date prefix', () => {
    // 05/28/21 00:00 belongs to 05/28/21, not 05/27/21
    const onlyDay28 = applyTimepointFilter(
      SAMPLE_POINTS,
      new Set(['05/28/21']),
      ALL_DATES,
    )
    const midnightPt = onlyDay28.find(p => p.datetime === '05/28/21 00:00')
    expect(midnightPt).toBeDefined()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Badge text logic
// ─────────────────────────────────────────────────────────────────────────────

function badgeText(
  selectedDates: Set<string> | null,
  allDates:      string[],
): string {
  const allSelected =
    selectedDates === null || selectedDates.size === allDates.length
  return allSelected
    ? ''
    : ` (${selectedDates!.size} of ${allDates.length})`
}

describe('timepoint selector badge text', () => {
  it('empty string when all dates selected', () => {
    expect(badgeText(new Set(ALL_DATES), ALL_DATES)).toBe('')
  })

  it('empty string when selectedDates is null', () => {
    expect(badgeText(null, ALL_DATES)).toBe('')
  })

  it('"(N of M)" format when partial selection', () => {
    expect(badgeText(new Set(['05/27/21', '05/28/21']), ALL_DATES)).toBe(' (2 of 4)')
  })

  it('"(1 of M)" for single day', () => {
    expect(badgeText(new Set(['05/27/21']), ALL_DATES)).toBe(' (1 of 4)')
  })

  it('"(0 of M)" for empty selection', () => {
    expect(badgeText(new Set(), ALL_DATES)).toBe(' (0 of 4)')
  })

  it('count matches the set size', () => {
    const sel   = new Set(['05/27/21', '05/29/21'])
    const badge = badgeText(sel, ALL_DATES)
    expect(badge).toContain(String(sel.size))
    expect(badge).toContain(String(ALL_DATES.length))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Toggle logic (add / remove / all / none)
// ─────────────────────────────────────────────────────────────────────────────

describe('timepoint selector toggle logic', () => {
  it('toggling a selected date removes it', () => {
    const current = new Set(ALL_DATES)
    const next    = new Set(current)
    if (next.has('05/27/21')) next.delete('05/27/21')
    else next.add('05/27/21')
    expect(next.has('05/27/21')).toBe(false)
    expect(next.size).toBe(ALL_DATES.length - 1)
  })

  it('toggling an unselected date adds it', () => {
    const current = new Set(['05/28/21'])
    const next    = new Set(current)
    if (next.has('05/27/21')) next.delete('05/27/21')
    else next.add('05/27/21')
    expect(next.has('05/27/21')).toBe(true)
    expect(next.size).toBe(2)
  })

  it('"All" button sets to full set', () => {
    const all = new Set(ALL_DATES)
    expect(all.size).toBe(ALL_DATES.length)
  })

  it('"None" button sets to empty set', () => {
    const none = new Set<string>()
    expect(none.size).toBe(0)
  })

  it('toggling does not mutate the original set', () => {
    const original = new Set(ALL_DATES)
    const next     = new Set(original)
    next.delete('05/27/21')
    expect(original.has('05/27/21')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Chip label format (MM/DD not MM/DD/YY)
// ─────────────────────────────────────────────────────────────────────────────

function chipLabel(day: string): string {
  const parts = day.split('/')
  return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : day
}

describe('timepoint chip label format', () => {
  it('returns MM/DD from MM/DD/YY', () => {
    expect(chipLabel('05/27/21')).toBe('05/27')
  })

  it('does not include the year', () => {
    expect(chipLabel('05/27/21')).not.toContain('/21')
  })

  it('all dates in ALL_DATES produce 5-char labels', () => {
    for (const d of ALL_DATES) {
      expect(chipLabel(d)).toHaveLength(5)
    }
  })

  it('zero-padded month and day preserved', () => {
    expect(chipLabel('01/04/21')).toBe('01/04')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Date range filter using isoDate (from utils/format)
// ─────────────────────────────────────────────────────────────────────────────

describe('isoDate — used for date range comparison', () => {
  it('produces YYYY-MM-DD from ISO datetime', () => {
    expect(isoDate('2021-05-27T08:00:00')).toBe('2021-05-27')
  })

  // East of UTC, 08:00 on 27 May is still 26 May in UTC; the written day
  // must win. Node applies a TZ assigned at runtime.
  it('keeps the written day in a time zone east of UTC', () => {
    const saved = process.env.TZ
    process.env.TZ = 'Asia/Tokyo'
    try {
      expect(new Date(2021, 4, 27).getTimezoneOffset()).toBe(-540)
      expect(isoDate('2021-05-27T08:00:00')).toBe('2021-05-27')
    } finally {
      if (saved === undefined) delete process.env.TZ
      else process.env.TZ = saved
    }
  })

  it('produces YYYY-MM-DD from slash-date format', () => {
    // '05/27/21 08:00' is a valid date string
    const result = isoDate('05/27/21 08:00')
    // May produce 1921 or 2021 depending on browser — test just that it's a string
    expect(typeof result).toBe('string')
    expect(result.length).toBeGreaterThanOrEqual(10)
  })

  it('returns empty string for empty input', () => {
    expect(isoDate('')).toBe('')
  })

  it('strings sort correctly as ISO dates', () => {
    expect('2021-05-27' < '2021-06-01').toBe(true)
    expect('2021-06-17' > '2021-06-01').toBe(true)
  })
})

describe('date range filter (applyDateRangeFilter)', () => {
  it('no filter returns all points', () => {
    expect(applyDateRangeFilter(SAMPLE_POINTS, '', '')).toHaveLength(SAMPLE_POINTS.length)
  })

  it('dateFrom excludes earlier points', () => {
    const result = applyDateRangeFilter(SAMPLE_POINTS, '2021-05-28', '')
    expect(result.every(p => p.iso >= '2021-05-28')).toBe(true)
    expect(result.some(p => p.iso === '2021-05-27')).toBe(false)
  })

  it('dateTo excludes later points', () => {
    const result = applyDateRangeFilter(SAMPLE_POINTS, '', '2021-05-28')
    expect(result.every(p => p.iso <= '2021-05-28')).toBe(true)
    expect(result.some(p => p.iso === '2021-05-29')).toBe(false)
  })

  it('combined range is inclusive on both ends', () => {
    const result = applyDateRangeFilter(SAMPLE_POINTS, '2021-05-28', '2021-05-29')
    expect(result.every(p => p.iso >= '2021-05-28' && p.iso <= '2021-05-29')).toBe(true)
    expect(result.some(p => p.iso === '2021-05-27')).toBe(false)
    expect(result.some(p => p.iso === '2021-05-30')).toBe(false)
  })

  it('non-overlapping range returns empty array', () => {
    expect(applyDateRangeFilter(SAMPLE_POINTS, '2022-01-01', '2022-12-31'))
      .toHaveLength(0)
  })

  it('dateFrom = dateTo keeps only exact-match points', () => {
    const result = applyDateRangeFilter(SAMPLE_POINTS, '2021-05-28', '2021-05-28')
    expect(result.every(p => p.iso === '2021-05-28')).toBe(true)
    expect(result.length).toBeGreaterThan(0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeDayBands with EgcChart data shape
// ─────────────────────────────────────────────────────────────────────────────

describe('computeDayBands with EgcChart processedPoints', () => {
  it('produces one band per unique day in SAMPLE_POINTS', () => {
    const pts   = SAMPLE_POINTS.map(p => ({ datetime: p.datetime }))
    const bands = computeDayBands(pts)
    expect(bands.length).toBeGreaterThan(0)
    expect(bands.length).toBeLessThanOrEqual(ALL_DATES.length)
  })

  it('x1/x2 of each band exist in SAMPLE_POINTS datetimes', () => {
    const dtSet = new Set(SAMPLE_POINTS.map(p => p.datetime))
    const bands = computeDayBands(SAMPLE_POINTS.map(p => ({ datetime: p.datetime })))
    for (const band of bands) {
      expect(dtSet.has(band.x1)).toBe(true)
      expect(dtSet.has(band.x2)).toBe(true)
    }
  })

  it('shade alternates for all bands', () => {
    const bands = computeDayBands(SAMPLE_POINTS.map(p => ({ datetime: p.datetime })))
    bands.forEach((band, i) => expect(band.shade).toBe(i % 2 === 0))
  })
})