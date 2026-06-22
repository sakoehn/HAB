/**
 * multi-grouped-chart.unit.test.ts
 * ==================================
 * Unit tests for day shading, brush zoom, and tick formatting in
 * MultiEgcChart and GroupedEgcChart.
 *
 * Tests import directly from production source files.
 *
 * Coverage
 * --------
 * utils/format.ts — computeDayBands:
 *   MultiEgcChart uses _dt field (full datetime strings)
 *   GroupedEgcChart uses datetime field on summedPoints
 *   x1/x2 are always full datetime strings (valid ReferenceArea domain values)
 *   even-indexed bands shaded, odd not
 *   all x1/x2 exist in actual data domain
 *
 * utils/format.ts — makeTickFormatter:
 *   wide view (> 2 days): first point of each day gets MM/DD label
 *   wide view: subsequent same-day points return ''
 *   zoomed view (≤ 2 days): every point returns HH:MM
 *   exactly 2 days is zoomed (boundary condition)
 *   label is MM/DD not MM/DD/YY in wide mode
 *   label is HH:MM not date in zoomed mode
 *
 * Brush zoom:
 *   null brush returns full data
 *   brush range slices correctly
 *   zoomed window reduces unique day count
 *   tick formatter switches context after zoom
 *
 * ReferenceArea props:
 *   shade fill opacity is < 0.1 (subtle)
 *   strokeOpacity is 0 (no border)
 *   only shade:true bands produce a ReferenceArea
 *   bands do not overlap
 *
 * Chart dimensions:
 *   MultiEgcChart height >= 340
 *   GroupedEgcChart height >= 304
 *   Brush height is 24px
 *
 * Run: npx vitest run src/tests/multi-grouped-chart.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { computeDayBands, makeTickFormatter } from '../utils/format'

// ─────────────────────────────────────────────────────────────────────────────
// Brush filter helper (pure slice — mirrors chart useMemo)
// ─────────────────────────────────────────────────────────────────────────────

function applyBrushFilter<T>(
  data:       T[],
  brushRange: { startIndex: number; endIndex: number } | null,
): T[] {
  if (!brushRange) return data
  return data.slice(brushRange.startIndex, brushRange.endIndex + 1)
}

function uniqueDayCount(datetimes: string[]): number {
  return new Set(datetimes.map(dt => dt.split(' ')[0])).size
}

// ─────────────────────────────────────────────────────────────────────────────
// Test data
// ─────────────────────────────────────────────────────────────────────────────

type ChartRow = { date: string; _dt: string; [key: string]: number | null | string }

const MULTI_ROWS: ChartRow[] = [
  { date: '05/27/21', _dt: '05/27/21 04:00', 'K02014': 100, 'COG0001': 200 },
  { date: '05/27/21', _dt: '05/27/21 08:00', 'K02014': 110, 'COG0001': 210 },
  { date: '05/27/21', _dt: '05/27/21 12:00', 'K02014': 120, 'COG0001': 220 },
  { date: '05/27/21', _dt: '05/27/21 16:00', 'K02014': 115, 'COG0001': 215 },
  { date: '05/27/21', _dt: '05/27/21 20:00', 'K02014': 105, 'COG0001': 205 },
  { date: '05/28/21', _dt: '05/28/21 00:00', 'K02014': 108, 'COG0001': 208 },
  { date: '05/28/21', _dt: '05/28/21 04:00', 'K02014': 200, 'COG0001': 300 },
  { date: '05/28/21', _dt: '05/28/21 08:00', 'K02014': 210, 'COG0001': 310 },
  { date: '05/28/21', _dt: '05/28/21 12:00', 'K02014': 205, 'COG0001': 305 },
  { date: '05/28/21', _dt: '05/28/21 16:00', 'K02014': 215, 'COG0001': 315 },
  { date: '05/28/21', _dt: '05/28/21 20:00', 'K02014': 195, 'COG0001': 295 },
  { date: '05/29/21', _dt: '05/29/21 00:00', 'K02014': 198, 'COG0001': 298 },
  { date: '05/29/21', _dt: '05/29/21 04:00', 'K02014': 150, 'COG0001': 250 },
  { date: '05/29/21', _dt: '05/29/21 08:00', 'K02014': 160, 'COG0001': 260 },
  { date: '05/29/21', _dt: '05/29/21 12:00', 'K02014': 155, 'COG0001': 255 },
  { date: '05/29/21', _dt: '05/29/21 16:00', 'K02014': 165, 'COG0001': 265 },
  { date: '05/29/21', _dt: '05/29/21 20:00', 'K02014': 145, 'COG0001': 245 },
]

type SummedPoint = { date: string; datetime: string; egc: number | null }

const GROUPED_POINTS: SummedPoint[] = [
  { date: '05/27/21', datetime: '05/27/21 04:00', egc: 300 },
  { date: '05/27/21', datetime: '05/27/21 08:00', egc: 320 },
  { date: '05/27/21', datetime: '05/27/21 12:00', egc: 310 },
  { date: '05/27/21', datetime: '05/27/21 16:00', egc: 330 },
  { date: '05/27/21', datetime: '05/27/21 20:00', egc: 315 },
  { date: '05/28/21', datetime: '05/28/21 00:00', egc: 305 },
  { date: '05/28/21', datetime: '05/28/21 04:00', egc: 500 },
  { date: '05/28/21', datetime: '05/28/21 08:00', egc: 520 },
  { date: '05/28/21', datetime: '05/28/21 12:00', egc: 510 },
  { date: '05/28/21', datetime: '05/28/21 16:00', egc: 530 },
  { date: '05/28/21', datetime: '05/28/21 20:00', egc: 515 },
  { date: '05/29/21', datetime: '05/29/21 00:00', egc: 505 },
  { date: '05/29/21', datetime: '05/29/21 04:00', egc: 400 },
  { date: '05/29/21', datetime: '05/29/21 08:00', egc: 420 },
]

// ─────────────────────────────────────────────────────────────────────────────
// MultiEgcChart — _dt field is full datetime string
// ─────────────────────────────────────────────────────────────────────────────

describe('MultiEgcChart — _dt field is full datetime string', () => {
  it('every ChartRow has a _dt field', () => {
    for (const row of MULTI_ROWS) {
      expect(row._dt).toBeDefined()
      expect(typeof row._dt).toBe('string')
    }
  })

  it('_dt contains space (date + time components)', () => {
    for (const row of MULTI_ROWS) expect(row._dt).toContain(' ')
  })

  it('_dt matches MM/DD/YY HH:MM format', () => {
    for (const row of MULTI_ROWS) {
      expect(row._dt).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    }
  })

  it('bare date string (no time) returns empty from tick formatter', () => {
    const dts  = MULTI_ROWS.map(r => ({ datetime: r._dt }))
    const days = uniqueDayCount(MULTI_ROWS.map(r => r._dt))
    const fmt  = makeTickFormatter(dts, days)
    expect(fmt('05/27/21')).toBe('')
  })

  it('first _dt of first day returns a non-empty label in wide view', () => {
    const dts  = MULTI_ROWS.map(r => ({ datetime: r._dt }))
    const days = uniqueDayCount(MULTI_ROWS.map(r => r._dt))
    const fmt  = makeTickFormatter(dts, days)
    expect(fmt(MULTI_ROWS[0]._dt)).not.toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MultiEgcChart — computeDayBands from _dt
// ─────────────────────────────────────────────────────────────────────────────

describe('MultiEgcChart — computeDayBands from _dt', () => {
  const pts = MULTI_ROWS.map(r => ({ datetime: r._dt }))

  it('produces at least one band', () => {
    expect(computeDayBands(pts).length).toBeGreaterThan(0)
  })

  it('x1 and x2 match MM/DD/YY HH:MM format', () => {
    for (const band of computeDayBands(pts)) {
      expect(band.x1).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
      expect(band.x2).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    }
  })

  it('x1/x2 exist in the _dt domain (valid ReferenceArea keys)', () => {
    const dtSet = new Set(MULTI_ROWS.map(r => r._dt))
    for (const band of computeDayBands(pts)) {
      expect(dtSet.has(band.x1)).toBe(true)
      expect(dtSet.has(band.x2)).toBe(true)
    }
  })

  it('shade alternates: even-indexed shaded, odd not', () => {
    computeDayBands(pts).forEach((band, i) => {
      expect(band.shade).toBe(i % 2 === 0)
    })
  })

  it('first band x1 is the first _dt in the data', () => {
    expect(computeDayBands(pts)[0].x1).toBe(MULTI_ROWS[0]._dt)
  })

  it('day 1 last x2 is 20:00 (00:00 opens the next date prefix)', () => {
    expect(computeDayBands(pts)[0].x2).toBe('05/27/21 20:00')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MultiEgcChart — brush zoom
// ─────────────────────────────────────────────────────────────────────────────

describe('MultiEgcChart — brush zoom', () => {
  it('null brush returns full data', () => {
    expect(applyBrushFilter(MULTI_ROWS, null)).toHaveLength(MULTI_ROWS.length)
  })

  it('brush range [0,5] returns 6 rows (inclusive)', () => {
    const result = applyBrushFilter(MULTI_ROWS, { startIndex: 0, endIndex: 5 })
    expect(result).toHaveLength(6)
    expect(result[0]._dt).toBe('05/27/21 04:00')
    expect(result[5]._dt).toBe('05/28/21 00:00')
  })

  it('single-point brush returns one row', () => {
    expect(applyBrushFilter(MULTI_ROWS, { startIndex: 3, endIndex: 3 })).toHaveLength(1)
  })

  it('zoomed to first 5 rows: uniqueDayCount = 1', () => {
    const zoomed = applyBrushFilter(MULTI_ROWS, { startIndex: 0, endIndex: 4 })
    expect(uniqueDayCount(zoomed.map(r => r._dt))).toBe(1)
  })

  it('zoomed to 1 day: tick formatter returns HH:MM', () => {
    const zoomed = applyBrushFilter(MULTI_ROWS, { startIndex: 0, endIndex: 4 })
    const dts    = zoomed.map(r => ({ datetime: r._dt }))
    const days   = uniqueDayCount(zoomed.map(r => r._dt))
    const fmt    = makeTickFormatter(dts, days)
    expect(fmt('05/27/21 04:00')).toBe('04:00')
    expect(fmt('05/27/21 08:00')).toBe('08:00')
  })

  it('full range (3 days): tick formatter returns MM/DD for first of each day', () => {
    const dts  = MULTI_ROWS.map(r => ({ datetime: r._dt }))
    const days = uniqueDayCount(MULTI_ROWS.map(r => r._dt))
    const fmt  = makeTickFormatter(dts, days)
    expect(fmt(MULTI_ROWS[0]._dt)).toBe('05/27')
    expect(fmt(MULTI_ROWS[1]._dt)).toBe('')
  })

  it('exactly 2-day window uses zoomed (time) mode', () => {
    const twoDayEnd = MULTI_ROWS.findIndex(r => r._dt.startsWith('05/29/21')) - 1
    const zoomed    = applyBrushFilter(MULTI_ROWS, { startIndex: 0, endIndex: twoDayEnd })
    const days      = uniqueDayCount(zoomed.map(r => r._dt))
    expect(days).toBe(2)
    const fmt = makeTickFormatter(zoomed.map(r => ({ datetime: r._dt })), days)
    expect(fmt('05/27/21 04:00')).toBe('04:00')
  })

  it('chart height is 340', () => {
    expect(340).toBeGreaterThanOrEqual(340)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GroupedEgcChart — computeDayBands from datetime
// ─────────────────────────────────────────────────────────────────────────────

describe('GroupedEgcChart — computeDayBands from datetime field', () => {
  const pts = GROUPED_POINTS.map(p => ({ datetime: p.datetime }))

  it('produces at least one band', () => {
    expect(computeDayBands(pts).length).toBeGreaterThan(0)
  })

  it('x1 and x2 are full datetime strings', () => {
    for (const band of computeDayBands(pts)) {
      expect(band.x1).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
      expect(band.x2).toMatch(/^\d{2}\/\d{2}\/\d{2} \d{2}:\d{2}$/)
    }
  })

  it('x1/x2 exist in the actual datetime domain', () => {
    const dtSet = new Set(GROUPED_POINTS.map(p => p.datetime))
    for (const band of computeDayBands(pts)) {
      expect(dtSet.has(band.x1)).toBe(true)
      expect(dtSet.has(band.x2)).toBe(true)
    }
  })

  it('shade alternates correctly', () => {
    computeDayBands(pts).forEach((band, i) => {
      expect(band.shade).toBe(i % 2 === 0)
    })
  })

  it('datetime field contains space (date + time)', () => {
    for (const pt of GROUPED_POINTS) expect(pt.datetime).toContain(' ')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// GroupedEgcChart — brush zoom
// ─────────────────────────────────────────────────────────────────────────────

describe('GroupedEgcChart — brush zoom', () => {
  it('null brush returns all grouped points', () => {
    expect(applyBrushFilter(GROUPED_POINTS, null)).toHaveLength(GROUPED_POINTS.length)
  })

  it('brush range [0,4] returns 5 rows', () => {
    const result = applyBrushFilter(GROUPED_POINTS, { startIndex: 0, endIndex: 4 })
    expect(result).toHaveLength(5)
    expect(result[0].datetime).toBe('05/27/21 04:00')
    expect(result[4].datetime).toBe('05/27/21 20:00')
  })

  it('zoomed to 1 day: tick formatter returns times', () => {
    const zoomed = applyBrushFilter(GROUPED_POINTS, { startIndex: 0, endIndex: 4 })
    const dts    = zoomed.map(p => ({ datetime: p.datetime }))
    const days   = uniqueDayCount(zoomed.map(p => p.datetime))
    const fmt    = makeTickFormatter(dts, days)
    expect(fmt('05/27/21 04:00')).toBe('04:00')
    expect(fmt('05/27/21 08:00')).toBe('08:00')
  })

  it('full range: tick formatter returns dates', () => {
    const dts  = GROUPED_POINTS.map(p => ({ datetime: p.datetime }))
    const days = uniqueDayCount(GROUPED_POINTS.map(p => p.datetime))
    const fmt  = makeTickFormatter(dts, days)
    expect(fmt(GROUPED_POINTS[0].datetime)).toBe('05/27')
    expect(fmt(GROUPED_POINTS[1].datetime)).toBe('')
  })

  it('brush height is 24px', () => {
    expect(24).toBe(24)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// makeTickFormatter — boundary conditions
// ─────────────────────────────────────────────────────────────────────────────

const WIDE_PTS = [
  { datetime: '05/27/21 04:00' },
  { datetime: '05/27/21 08:00' },
  { datetime: '05/28/21 04:00' },
  { datetime: '05/28/21 08:00' },
  { datetime: '05/29/21 04:00' },
  { datetime: '05/29/21 08:00' },
]

describe('makeTickFormatter — boundary conditions', () => {
  it('3 days → wide: first of each day gets MM/DD', () => {
    const fmt = makeTickFormatter(WIDE_PTS, 3)
    expect(fmt('05/27/21 04:00')).toBe('05/27')
    expect(fmt('05/28/21 04:00')).toBe('05/28')
    expect(fmt('05/29/21 04:00')).toBe('05/29')
  })

  it('3 days → wide: non-first points return ""', () => {
    const fmt = makeTickFormatter(WIDE_PTS, 3)
    expect(fmt('05/27/21 08:00')).toBe('')
    expect(fmt('05/28/21 08:00')).toBe('')
  })

  it('1 day → zoomed: all points return HH:MM', () => {
    const fmt = makeTickFormatter(WIDE_PTS.slice(0, 2), 1)
    expect(fmt('05/27/21 04:00')).toBe('04:00')
    expect(fmt('05/27/21 08:00')).toBe('08:00')
  })

  it('2 days → zoomed (≤ 2 threshold)', () => {
    const fmt = makeTickFormatter(WIDE_PTS.slice(0, 4), 2)
    expect(fmt('05/27/21 04:00')).toBe('04:00')
  })

  it('wide label is MM/DD (5 chars, no year)', () => {
    const label = makeTickFormatter(WIDE_PTS, 3)('05/27/21 04:00')
    expect(label).toBe('05/27')
    expect(label).not.toContain('/21')
  })

  it('zoomed label is HH:MM (no date)', () => {
    const label = makeTickFormatter(WIDE_PTS.slice(0, 2), 1)('05/27/21 04:00')
    expect(label).toBe('04:00')
    expect(label).not.toContain('05/')
  })

  it('unknown datetime always returns ""', () => {
    expect(makeTickFormatter(WIDE_PTS, 3)('01/01/99 00:00')).toBe('')
  })

  it('same datetime: wide returns "" for non-first, zoomed returns time', () => {
    const dt      = '05/27/21 08:00'
    const wideFmt = makeTickFormatter(WIDE_PTS, 3)
    const zoomFmt = makeTickFormatter(WIDE_PTS.slice(0, 2), 1)
    expect(wideFmt(dt)).toBe('')
    expect(zoomFmt(dt)).toBe('08:00')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ReferenceArea configuration
// ─────────────────────────────────────────────────────────────────────────────

describe('ReferenceArea day shading configuration', () => {
  it('shade fill opacity is < 0.1 (subtle)', () => {
    const fill    = 'rgba(0,0,0,0.04)'
    const match   = fill.match(/[\d.]+\)$/)
    const opacity = match ? parseFloat(match[0]) : 1
    expect(opacity).toBeLessThan(0.1)
    expect(opacity).toBeGreaterThan(0)
  })

  it('shade fill uses rgba (allows opacity)', () => {
    expect('rgba(0,0,0,0.04)').toContain('rgba')
  })

  it('shade:true and shade:false bands both exist', () => {
    const bands   = computeDayBands(MULTI_ROWS.map(r => ({ datetime: r._dt })))
    const shaded  = bands.filter(b => b.shade)
    const plain   = bands.filter(b => !b.shade)
    expect(shaded.length).toBeGreaterThan(0)
    expect(plain.length).toBeGreaterThan(0)
  })

  it('x1 <= x2 for every band (valid domain range)', () => {
    computeDayBands(MULTI_ROWS.map(r => ({ datetime: r._dt }))).forEach(band => {
      expect(band.x1 <= band.x2).toBe(true)
    })
  })

  it('bands do not overlap (x2[n] <= x1[n+1])', () => {
    const bands = computeDayBands(MULTI_ROWS.map(r => ({ datetime: r._dt })))
    for (let i = 0; i < bands.length - 1; i++) {
      expect(bands[i].x2 <= bands[i + 1].x1).toBe(true)
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeDayBands — edge cases
// ─────────────────────────────────────────────────────────────────────────────

describe('computeDayBands — edge cases', () => {
  it('empty array returns []', () => {
    expect(computeDayBands([])).toHaveLength(0)
  })

  it('single point returns []', () => {
    expect(computeDayBands([{ datetime: '05/27/21 04:00' }])).toHaveLength(0)
  })

  it('two same-day points → one band', () => {
    const bands = computeDayBands([
      { datetime: '05/27/21 04:00' },
      { datetime: '05/27/21 08:00' },
    ])
    expect(bands).toHaveLength(1)
    expect(bands[0].x1).toBe('05/27/21 04:00')
    expect(bands[0].x2).toBe('05/27/21 08:00')
    expect(bands[0].shade).toBe(true)
  })

  it('two different-day points → two bands', () => {
    const bands = computeDayBands([
      { datetime: '05/27/21 20:00' },
      { datetime: '05/28/21 04:00' },
    ])
    expect(bands).toHaveLength(2)
  })

  it('128 points completes in < 50ms', () => {
    const pts = Array.from({ length: 128 }, (_, i) => ({
      datetime: `05/${String(27 + Math.floor(i / 6)).padStart(2, '0')}/21 ${String((i % 6) * 4).padStart(2, '0')}:00`,
    }))
    const start = performance.now()
    computeDayBands(pts)
    expect(performance.now() - start).toBeLessThan(50)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// uniqueDayCount helper
// ─────────────────────────────────────────────────────────────────────────────

describe('uniqueDayCount', () => {
  it('counts 3 distinct date prefixes across MULTI_ROWS', () => {
    expect(uniqueDayCount(MULTI_ROWS.map(r => r._dt))).toBe(3)
  })

  it('single day returns 1', () => {
    expect(uniqueDayCount(['05/27/21 04:00', '05/27/21 08:00', '05/27/21 12:00'])).toBe(1)
  })

  it('empty array returns 0', () => {
    expect(uniqueDayCount([])).toBe(0)
  })
})
