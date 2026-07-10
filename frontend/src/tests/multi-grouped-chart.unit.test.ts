/**
 * multi-grouped-chart.unit.test.ts
 * ==================================
 * Unit tests for day-shading band computation in MultiEgcChart and
 * GroupedEgcChart, both of which render with Plotly (`shapes` of
 * type 'rect') driven by utils/format.ts's computeDayBands().
 *
 * Tests import directly from production source files.
 *
 * Note: this file previously also covered "brush zoom" and
 * "makeTickFormatter" boundary conditions. Both tested a Recharts
 * <Brush>/<XAxis tickFormatter> mechanism that no longer exists —
 * MultiEgcChart.tsx and GroupedEgcChart.tsx now render with Plotly, which
 * handles zoom and axis tick formatting natively via its own date-axis
 * drag-zoom and rangeslider (no app-level brush/zoom state, no custom tick
 * formatter). Those blocks were removed as dead-code tests; real zoom
 * behavior is covered at the E2E level in App.e2e.spec.ts since it requires
 * a real Plotly render to verify.
 *
 * Coverage
 * --------
 * utils/format.ts — computeDayBands:
 *   MultiEgcChart uses _dt field (full datetime strings)
 *   GroupedEgcChart uses datetime field on summedPoints
 *   x1/x2 are always full datetime strings (valid Plotly shape x0/x1 source)
 *   even-indexed bands shaded, odd not
 *   all x1/x2 exist in actual data domain
 *
 * Day-shading shape invariants:
 *   only shade:true bands produce a shaded rect
 *   bands do not overlap
 *
 * Run: npx vitest run src/tests/multi-grouped-chart.unit.test.ts
 */

import { describe, it, expect } from 'vitest'

import { computeDayBands } from '../utils/format'

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

  it('x1/x2 exist in the _dt domain (valid Plotly shape source values)', () => {
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
// Day-shading rect invariants (Plotly `shapes`, built from computeDayBands)
// ─────────────────────────────────────────────────────────────────────────────

describe('Day-shading rects — computeDayBands invariants', () => {
  it('shade:true and shade:false bands both exist', () => {
    const bands  = computeDayBands(MULTI_ROWS.map(r => ({ datetime: r._dt })))
    const shaded = bands.filter(b => b.shade)
    const plain  = bands.filter(b => !b.shade)
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
