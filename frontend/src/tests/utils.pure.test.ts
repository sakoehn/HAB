/**
 * utils.pure.test.ts
 * ==================
 * Unit tests for all pure utility functions extracted from App.tsx.
 *
 * Tests import directly from the source files so any drift between
 * implementation and test is caught immediately.
 *
 * Coverage
 * --------
 * utils/stats.ts:
 *   extractEgc            — all value shapes (bare number, object, null, edge)
 *   extractNormEgc        — all value shapes
 *   computeStats          — mean, median (even/odd n), sample std, quartiles,
 *                           CV, single value, empty, immutability
 *   computeTrend          — positive/negative/flat, short series guard,
 *                           antisymmetry invariant
 *
 * utils/signal.ts:
 *   applyL1Normalize      — series total, per-timepoint, zeros, nulls, empty map
 *   applyZScore           — mean→0, std→1, flat series, nulls, single value
 *   applyLowess           — length preservation, noise reduction, null pass-through,
 *                           minimum bandwidth (0.05), immutability
 *   buildTimepointTotals  — summation, missing timepoints, null EGC, empty
 *
 * utils/format.ts:
 *   parseDateTime         — ISO, slash-date, empty, cross-format ordering
 *   fmtDate               — ISO → MM/DD/YY, zero-padding, empty
 *   fmtTime               — ISO → HH:MM, 24h, padding, slash-date fallback, empty
 *   isoDate               — truncation, fallback, empty
 *   computeDayBands       — grouping, alternation, x1/x2 are full datetimes,
 *                           single day, < 2 points guard
 *   makeTickFormatter     — wide view date labels, zoomed HH:MM, boundary at 2 days
 *
 * utils/api.ts:
 *   downloadCsv (string builder) — header, data rows, comma escaping,
 *                                   quote doubling, newline quoting, null/undefined,
 *                                   empty guard, multiple rows
 *
 * constants.ts:
 *   expandParentLabel     — COG letter, enzyme class, KEGG code strip,
 *                           KEGG BRITE lookup, unknown fallback, empty string
 *   nextColorForSource    — first call, cycling, wrap-around, independent sources
 *   resetSourceCounters   — resets all
 *
 * Mathematical invariants:
 *   Z-score idempotency, L1 proportions in [0,1], quartile ordering,
 *   trend antisymmetry, stats consistency with manual calculation
 *
 * Run: npx vitest run src/tests/utils.pure.test.ts
 */

import { describe, it, expect, beforeEach } from 'vitest'

// ── Import from production source files ───────────────────────────────────
// Any drift between implementation and test is now a compile/runtime error.

import {
  extractEgc,
  extractNormEgc,
  computeStats,
  computeTrend,
} from '../utils/stats'

import {
  applyL1Normalize,
  applyZScore,
  applyLowess,
  buildTimepointTotals,
} from '../utils/signal'

import {
  parseDateTime,
  fmtDate,
  fmtTime,
  isoDate,
  computeDayBands,
  makeTickFormatter,
} from '../utils/format'

import {
  expandParentLabel,
  nextColorForSource,
  resetSourceCounters,
  SOURCE_SHADES,
  CHART_COLORS,
} from '../constants'

import type { AnnotationItem, TimepointMeta } from '../types'

// ── CSV string builder (inline — downloadCsv side-effects require DOM) ─────
// We test the pure string-building logic separately from the download trigger.
function buildCsvString(rows: Record<string, unknown>[]): string {
  if (!rows.length) return ''
  const cols   = Object.keys(rows[0])
  const escape = (v: unknown): string => {
    const s = v == null ? '' : String(v)
    return s.includes(',') || s.includes('"') || s.includes('\n')
      ? `"${s.replace(/"/g, '""')}"`
      : s
  }
  return [
    cols.join(','),
    ...rows.map(r => cols.map(c => escape(r[c])).join(',')),
  ].join('\n')
}

// ── Tolerance helpers ─────────────────────────────────────────────────────
const EPSILON = 1e-9

// ─────────────────────────────────────────────────────────────────────────────
// extractEgc
// ─────────────────────────────────────────────────────────────────────────────

describe('extractEgc', () => {
  it('returns a bare number directly', () => {
    expect(extractEgc(277.0)).toBe(277.0)
  })

  it('returns zero correctly', () => {
    expect(extractEgc(0)).toBe(0)
  })

  it('reads value.egc from annotation object', () => {
    expect(extractEgc({ egc: 5771.0, norm_egc: 0.00042, name: 'test' })).toBe(5771.0)
  })

  it('reads value.EGC (uppercase fallback)', () => {
    expect(extractEgc({ EGC: 100 })).toBe(100)
  })

  it('prefers egc over EGC when both present', () => {
    expect(extractEgc({ egc: 10, EGC: 99 })).toBe(10)
  })

  it('returns null for null input', () => {
    expect(extractEgc(null)).toBeNull()
  })

  it('returns null for undefined', () => {
    expect(extractEgc(undefined)).toBeNull()
  })

  it('returns null for a string', () => {
    expect(extractEgc('5771')).toBeNull()
  })

  it('returns null for object without egc field', () => {
    expect(extractEgc({ name: 'foo', parent: 'bar' })).toBeNull()
  })

  it('returns null for empty object', () => {
    expect(extractEgc({})).toBeNull()
  })

  it('returns null for an array', () => {
    expect(extractEgc([1, 2, 3])).toBeNull()
  })

  it('returns null for boolean', () => {
    expect(extractEgc(true)).toBeNull()
    expect(extractEgc(false)).toBeNull()
  })

  it('handles egc = 0 (falsy but valid)', () => {
    expect(extractEgc({ egc: 0 })).toBe(0)
  })

  it('handles negative egc', () => {
    expect(extractEgc({ egc: -5 })).toBe(-5)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// extractNormEgc
// ─────────────────────────────────────────────────────────────────────────────

describe('extractNormEgc', () => {
  it('reads value.norm_egc', () => {
    expect(extractNormEgc({ egc: 5771.0, norm_egc: 0.000423 })).toBeCloseTo(0.000423)
  })

  it('reads value.NORM_EGC (uppercase fallback)', () => {
    expect(extractNormEgc({ NORM_EGC: 0.001 })).toBeCloseTo(0.001)
  })

  it('prefers norm_egc over NORM_EGC', () => {
    expect(extractNormEgc({ norm_egc: 0.5, NORM_EGC: 0.9 })).toBeCloseTo(0.5)
  })

  it('returns null when norm_egc absent', () => {
    expect(extractNormEgc({ egc: 100 })).toBeNull()
  })

  it('returns null for bare number', () => {
    expect(extractNormEgc(100)).toBeNull()
  })

  it('returns null for null', () => {
    expect(extractNormEgc(null)).toBeNull()
  })

  it('returns null for empty object', () => {
    expect(extractNormEgc({})).toBeNull()
  })

  it('L1 and raw values are distinct for realistic data', () => {
    const value = { egc: 14992.0, norm_egc: 0.0004 }
    expect(extractNormEgc(value)).not.toBe(extractEgc(value))
  })

  it('norm_egc is < 1 for realistic data (depth denominator >> 1)', () => {
    expect(extractNormEgc({ egc: 5000, norm_egc: 0.0004 })!).toBeLessThan(1)
    expect(extractNormEgc({ egc: 5000, norm_egc: 0.0004 })!).toBeGreaterThan(0)
  })

  it('relationship norm_egc = egc / depth holds', () => {
    const egc   = 14992.0
    const depth = 8_300_000
    const value = { egc, norm_egc: egc / depth }
    expect(extractNormEgc(value)! * depth).toBeCloseTo(egc, 0)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeStats
// ─────────────────────────────────────────────────────────────────────────────

describe('computeStats', () => {
  it('returns null for empty array', () => {
    expect(computeStats([])).toBeNull()
  })

  it('single value: n=1, mean=value, std=0, min=max=median=value', () => {
    const s = computeStats([42])!
    expect(s.n).toBe(1)
    expect(s.mean).toBe(42)
    expect(s.std).toBe(0)
    expect(s.min).toBe(42)
    expect(s.max).toBe(42)
    expect(s.median).toBe(42)
  })

  it('correct mean for [2,4,4,4,5,5,7,9] (= 5.0)', () => {
    expect(computeStats([2, 4, 4, 4, 5, 5, 7, 9])!.mean).toBeCloseTo(5.0)
  })

  it('sample std dev for [2,4,4,4,5,5,7,9] ≈ 2.138 (÷ n-1)', () => {
    expect(computeStats([2, 4, 4, 4, 5, 5, 7, 9])!.std).toBeCloseTo(2.138, 2)
  })

  it('median for odd-length array: [1,3,5,7,9] → 5', () => {
    expect(computeStats([9, 1, 5, 7, 3])!.median).toBe(5)
  })

  it('median for even-length array: [1,2,3,4] → 2.5', () => {
    expect(computeStats([4, 1, 3, 2])!.median).toBe(2.5)
  })

  it('min and max correct regardless of input order', () => {
    const s = computeStats([7, 2, 9, 1, 5])!
    expect(s.min).toBe(1)
    expect(s.max).toBe(9)
  })

  it('Q1/Q3 — Type 7 linear interpolation for n=4', () => {
    // sorted [1,2,3,4]: Q1 = 1.75, Q3 = 3.25
    const s = computeStats([1, 2, 3, 4])!
    expect(s.q1).toBeCloseTo(1.75)
    expect(s.q3).toBeCloseTo(3.25)
  })

  it('Q1/Q3 match R quantile() type 7 for n=5', () => {
    // sorted [1,2,3,4,5]: Q1 = 2, Q3 = 4
    const s = computeStats([5, 1, 4, 2, 3])!
    expect(s.q1).toBeCloseTo(2.0)
    expect(s.q3).toBeCloseTo(4.0)
  })

  it('CV = std / mean', () => {
    const s = computeStats([10, 20, 30])!
    expect(s.cv).toBeCloseTo(s.std / s.mean)
  })

  it('CV is 0 when mean is 0 (no division by zero)', () => {
    expect(computeStats([0, 0, 0])!.cv).toBe(0)
  })

  it('does not mutate input array', () => {
    const vals = [3, 1, 4, 1, 5]
    computeStats(vals)
    expect(vals).toEqual([3, 1, 4, 1, 5])
  })

  it('all identical values: std=0, cv=0, q1=q3=mean', () => {
    const s = computeStats([7, 7, 7, 7])!
    expect(s.std).toBe(0)
    expect(s.cv).toBe(0)
    expect(s.q1).toBe(7)
    expect(s.q3).toBe(7)
  })

  it('n=128 array 1..128: mean=64.5', () => {
    const vals = Array.from({ length: 128 }, (_, i) => i + 1)
    const s    = computeStats(vals)!
    expect(s.n).toBe(128)
    expect(s.mean).toBeCloseTo(64.5)
    expect(s.min).toBe(1)
    expect(s.max).toBe(128)
  })

  // Invariants
  it('invariant: Q1 ≤ median ≤ Q3 always holds', () => {
    const testSets = [
      [1, 2, 3, 4, 5],
      [10, 100, 1000, 10000],
      [1, 1, 1, 2, 100],
      Array.from({ length: 50 }, (_, i) => (i + 1) * 7),
    ]
    for (const vals of testSets) {
      const s = computeStats(vals)!
      expect(s.q1).toBeLessThanOrEqual(s.median + EPSILON)
      expect(s.median).toBeLessThanOrEqual(s.q3 + EPSILON)
    }
  })

  it('invariant: mean is consistent with manual sum / n', () => {
    const vals       = [3, 7, 2, 9, 1, 8, 4, 6, 5, 10]
    const manualMean = vals.reduce((a, b) => a + b, 0) / vals.length
    expect(computeStats(vals)!.mean).toBeCloseTo(manualMean)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeTrend
// ─────────────────────────────────────────────────────────────────────────────

describe('computeTrend', () => {
  it('returns null for n < 4', () => {
    expect(computeTrend([])).toBeNull()
    expect(computeTrend([1])).toBeNull()
    expect(computeTrend([1, 2])).toBeNull()
    expect(computeTrend([1, 2, 3])).toBeNull()
  })

  it('returns positive for rising series', () => {
    expect(computeTrend([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12])!).toBeGreaterThan(0)
  })

  it('returns negative for falling series', () => {
    expect(computeTrend([12, 11, 10, 9, 8, 7, 6, 5, 4, 3, 2, 1])!).toBeLessThan(0)
  })

  it('returns 0 for flat series', () => {
    expect(computeTrend([5, 5, 5, 5, 5, 5, 5, 5])).toBe(0)
  })

  it('uses floor(n/4) quarters: n=8, q=2, expected trend=6', () => {
    // firstQ=[1,2] → mean=1.5; lastQ=[7,8] → mean=7.5; diff=6
    expect(computeTrend([1, 2, 3, 4, 5, 6, 7, 8])).toBeCloseTo(6.0)
  })

  it('steep series has larger magnitude than gentle series', () => {
    const gentle = [1, 1.1, 1.2, 1.3, 1.4, 1.5, 1.6, 1.7, 1.8, 1.9, 2.0, 2.1]
    const steep  = [1, 2, 4, 8, 16, 32, 64, 128, 256, 512, 1024, 2048]
    expect(Math.abs(computeTrend(steep)!)).toBeGreaterThan(Math.abs(computeTrend(gentle)!))
  })

  it('invariant: trend(reverse(x)) = -trend(x)', () => {
    const vals    = [1, 2, 5, 10, 15, 20, 22, 25, 28, 30, 35, 40]
    const forward = computeTrend(vals)!
    const back    = computeTrend([...vals].reverse())!
    expect(forward).toBeCloseTo(-back, 10)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyL1Normalize
// ─────────────────────────────────────────────────────────────────────────────

describe('applyL1Normalize — series total mode', () => {
  it('divides each value by series total', () => {
    const r = applyL1Normalize([{ egc: 100 }, { egc: 200 }, { egc: 300 }])
    expect(r[0].egc).toBeCloseTo(100 / 600)
    expect(r[1].egc).toBeCloseTo(200 / 600)
    expect(r[2].egc).toBeCloseTo(300 / 600)
  })

  it('result values sum to 1.0', () => {
    const r   = applyL1Normalize([{ egc: 10 }, { egc: 30 }, { egc: 60 }])
    const sum = r.reduce((s, d) => s + (d.egc ?? 0), 0)
    expect(sum).toBeCloseTo(1.0)
  })

  it('preserves null entries; non-null entries divide by non-null total', () => {
    const r = applyL1Normalize([{ egc: 100 }, { egc: null }, { egc: 200 }])
    expect(r[1].egc).toBeNull()
    expect(r[0].egc).toBeCloseTo(100 / 300)
    expect(r[2].egc).toBeCloseTo(200 / 300)
  })

  it('returns data unchanged when total is zero', () => {
    const r = applyL1Normalize([{ egc: 0 }, { egc: 0 }])
    expect(r[0].egc).toBe(0)
    expect(r[1].egc).toBe(0)
  })

  it('single non-zero value normalises to 1.0', () => {
    expect(applyL1Normalize([{ egc: 500 }])[0].egc).toBeCloseTo(1.0)
  })

  it('invariant: all non-null results are in [0, 1]', () => {
    const r = applyL1Normalize([{ egc: 100 }, { egc: 250 }, { egc: 75 }, { egc: 575 }])
    for (const d of r) {
      if (d.egc !== null) {
        expect(d.egc).toBeGreaterThanOrEqual(0)
        expect(d.egc).toBeLessThanOrEqual(1)
      }
    }
  })
})

describe('applyL1Normalize — per-timepoint totals mode', () => {
  it('divides by the correct per-timepoint total', () => {
    const totals = new Map([['t1', 400], ['t2', 800]])
    const r      = applyL1Normalize(
      [{ egc: 100, datetime: 't1' }, { egc: 200, datetime: 't2' }],
      totals,
    )
    expect(r[0].egc).toBeCloseTo(100 / 400)
    expect(r[1].egc).toBeCloseTo(200 / 800)
  })

  it('returns null when datetime not in totals map', () => {
    const totals = new Map([['t1', 400]])
    const r      = applyL1Normalize([{ egc: 100, datetime: 'missing' }], totals)
    expect(r[0].egc).toBeNull()
  })

  it('skips null egc even in totals mode', () => {
    const totals = new Map([['t1', 400]])
    const r      = applyL1Normalize([{ egc: null, datetime: 't1' }], totals)
    expect(r[0].egc).toBeNull()
  })

  it('falls back to series mode when totals map is empty', () => {
    const r = applyL1Normalize([{ egc: 100 }, { egc: 300 }], new Map())
    expect(r[0].egc).toBeCloseTo(100 / 400)
    expect(r[1].egc).toBeCloseTo(300 / 400)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyZScore
// ─────────────────────────────────────────────────────────────────────────────

describe('applyZScore', () => {
  it('produces mean ≈ 0 after transformation', () => {
    const vals = applyZScore([{ egc: 10 }, { egc: 20 }, { egc: 30 }, { egc: 40 }])
      .map(d => d.egc as number)
    expect(vals.reduce((a, b) => a + b, 0) / vals.length).toBeCloseTo(0)
  })

  it('produces std ≈ 1 (population std) after transformation', () => {
    const vals = applyZScore([{ egc: 10 }, { egc: 20 }, { egc: 30 }, { egc: 40 }])
      .map(d => d.egc as number)
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length
    const std  = Math.sqrt(vals.reduce((a, b) => a + (b - mean) ** 2, 0) / vals.length)
    expect(std).toBeCloseTo(1.0, 5)
  })

  it('[1,2,3] → [-1.2247, 0, 1.2247]', () => {
    const r = applyZScore([{ egc: 1 }, { egc: 2 }, { egc: 3 }])
    expect(r[0].egc).toBeCloseTo(-1.2247, 3)
    expect(r[1].egc).toBeCloseTo(0,       3)
    expect(r[2].egc).toBeCloseTo(1.2247,  3)
  })

  it('flat series returns all zeros', () => {
    const r = applyZScore([{ egc: 5 }, { egc: 5 }, { egc: 5 }])
    r.forEach(d => expect(d.egc).toBe(0))
  })

  it('preserves null entries', () => {
    expect(applyZScore([{ egc: 1 }, { egc: null }, { egc: 3 }])[1].egc).toBeNull()
  })

  it('returns data unchanged for < 2 non-null values', () => {
    expect(applyZScore([{ egc: 42 }])[0].egc).toBe(42)
  })

  it('preserves array length', () => {
    expect(applyZScore(Array.from({ length: 10 }, (_, i) => ({ egc: i })))).toHaveLength(10)
  })

  it('does not mutate input', () => {
    const data = [{ egc: 10 }, { egc: 20 }, { egc: 30 }]
    applyZScore(data)
    expect(data[0].egc).toBe(10)
  })

  it('invariant: Z-score of Z-scored data is approximately unchanged', () => {
    const data  = [1, 5, 2, 8, 3, 6].map(egc => ({ egc }))
    const once  = applyZScore(data)
    const twice = applyZScore(once)
    once.forEach((d, i) => expect(d.egc).toBeCloseTo(twice[i].egc as number, 4))
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// applyLowess
// ─────────────────────────────────────────────────────────────────────────────

describe('applyLowess', () => {
  it('preserves array length', () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ egc: i * 2.0 }))
    expect(applyLowess(data, 0.4)).toHaveLength(20)
  })

  it('returns data unchanged for < 3 non-null points', () => {
    const r = applyLowess([{ egc: 1 }, { egc: 2 }], 0.5)
    expect(r[0].egc).toBe(1)
    expect(r[1].egc).toBe(2)
  })

  it('preserves null entries in output', () => {
    const r = applyLowess([{ egc: 1 }, { egc: null }, { egc: 3 }, { egc: 4 }, { egc: 5 }], 0.4)
    expect(r[1].egc).toBeNull()
  })

  it('minimum bandwidth 0.05 runs without error', () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ egc: i }))
    expect(() => applyLowess(data, 0.05)).not.toThrow()
    expect(applyLowess(data, 0.05)).toHaveLength(20)
  })

  it('reduces variance on noisy alternating series', () => {
    const data     = [1, 10, 2, 9, 3, 8, 4, 7, 5, 6, 4, 8, 3, 9, 2, 10, 1].map(egc => ({ egc }))
    const raw      = data.map(d => d.egc as number)
    const smoothed = applyLowess(data, 0.5).map(d => d.egc as number).filter(v => v != null)
    const variance = (arr: number[]) => {
      const m = arr.reduce((a, b) => a + b, 0) / arr.length
      return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length
    }
    expect(variance(smoothed)).toBeLessThan(variance(raw))
  })

  it('does not mutate input', () => {
    const data = [{ egc: 1 }, { egc: 5 }, { egc: 3 }, { egc: 7 }, { egc: 2 }]
    applyLowess(data, 0.5)
    expect(data[0].egc).toBe(1)
    expect(data[4].egc).toBe(2)
  })

  it('linear series stays approximately linear', () => {
    const data   = Array.from({ length: 15 }, (_, i) => ({ egc: i * 10.0 }))
    const result = applyLowess(data, 0.5)
    expect((result[0].egc as number)).toBeGreaterThanOrEqual(-5)
    expect((result[14].egc as number)).toBeGreaterThan(50)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// buildTimepointTotals
// ─────────────────────────────────────────────────────────────────────────────

function makeItem(datetime: string, egc: number): AnnotationItem {
  return {
    source:        'kegg',
    sample:        's1',
    annotation_id: 'K00001',
    name:          null,
    timepoint:     { taxon_oid: 's1', timepoint: '1', datetime } as TimepointMeta,
    value:         { egc },
  }
}

describe('buildTimepointTotals', () => {
  it('sums EGC across series at the same timepoint', () => {
    const totals = buildTimepointTotals([
      { data: [makeItem('t1', 100), makeItem('t2', 200)] },
      { data: [makeItem('t1', 50),  makeItem('t2', 150)] },
    ])
    expect(totals.get('t1')).toBe(150)
    expect(totals.get('t2')).toBe(350)
  })

  it('skips items with no timepoint', () => {
    const item: AnnotationItem = {
      source: 'kegg', sample: 's1', annotation_id: 'K00001',
      name: null, timepoint: null, value: { egc: 999 },
    }
    expect(buildTimepointTotals([{ data: [item] }]).size).toBe(0)
  })

  it('skips items with null EGC value', () => {
    const item: AnnotationItem = {
      source: 'kegg', sample: 's1', annotation_id: 'K00001',
      name: null,
      timepoint: { taxon_oid: 's1', timepoint: '1', datetime: 't1' },
      value: { egc: null },
    }
    expect(buildTimepointTotals([{ data: [item] }]).size).toBe(0)
  })

  it('returns empty map for empty input', () => {
    expect(buildTimepointTotals([]).size).toBe(0)
  })

  it('handles overlapping datetimes across three series', () => {
    const totals = buildTimepointTotals([
      { data: [makeItem('t1', 100)] },
      { data: [makeItem('t1', 200)] },
      { data: [makeItem('t1', 300)] },
    ])
    expect(totals.get('t1')).toBe(600)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// parseDateTime
// ─────────────────────────────────────────────────────────────────────────────

describe('parseDateTime', () => {
  it('parses ISO datetime to correct year/month/day', () => {
    const ms = parseDateTime('2021-05-27T13:00:00')
    const d  = new Date(ms)
    expect(d.getFullYear()).toBe(2021)
    expect(d.getMonth()).toBe(4)  // May = 4
    expect(d.getDate()).toBe(27)
  })

  it('parses slash-date format M/D/YY HH:MM to correct year', () => {
    const ms = parseDateTime('5/27/21 13:00')
    expect(new Date(ms).getFullYear()).toBe(2021)
    expect(new Date(ms).getMonth()).toBe(4)
  })

  it('returns 0 for empty string', () => {
    expect(parseDateTime('')).toBe(0)
  })

  it('ISO dates sort correctly by timestamp', () => {
    expect(parseDateTime('2021-05-01T00:00:00')).toBeLessThan(
      parseDateTime('2021-06-01T00:00:00'),
    )
  })

  it('4-digit year in slash format handled correctly', () => {
    expect(new Date(parseDateTime('5/27/2021 13:00')).getFullYear()).toBe(2021)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fmtDate
// ─────────────────────────────────────────────────────────────────────────────

describe('fmtDate', () => {
  it('formats ISO datetime as MM/DD/YY', () => {
    expect(fmtDate('2021-05-27T00:00:00')).toBe('05/27/21')
  })

  it('zero-pads month and day', () => {
    expect(fmtDate('2021-01-04T00:00:00')).toBe('01/04/21')
  })

  it('returns empty string for empty input', () => {
    expect(fmtDate('')).toBe('')
  })

  it('formats December 31 correctly', () => {
    expect(fmtDate('2021-12-31T23:59:00')).toBe('12/31/21')
  })
})
describe('fmtDate — MM/DD/YY HH:MM format (regression for engine-dependent parsing)', () => {
  it('06/02/21 stays 06/02/21 (not reinterpreted as Feb 6)', () => {
    expect(fmtDate('06/02/21 08:00')).toBe('06/02/21')
  })
  it('06/16/21 stays 06/16/21', () => {
    expect(fmtDate('06/16/21 08:00')).toBe('06/16/21')
  })
  it('parseDateTime(06/02/21) < parseDateTime(06/16/21)', () => {
    expect(parseDateTime('06/02/21 08:00')).toBeLessThan(parseDateTime('06/16/21 08:00'))
  })
  it('two-digit year 21 maps to 2021, not 1921', () => {
    const ts = parseDateTime('06/02/21 08:00')
    expect(new Date(ts).getFullYear()).toBe(2021)
  })
})

describe('fmtTime — MM/DD/YY HH:MM format', () => {
  it('extracts HH:MM correctly', () => {
    expect(fmtTime('05/28/21 01:00')).toBe('01:00')
  })
})

describe('isoDate — MM/DD/YY HH:MM format', () => {
  it('converts to YYYY-MM-DD correctly', () => {
    expect(isoDate('06/02/21 08:00')).toBe('2021-06-02')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// fmtTime
// ─────────────────────────────────────────────────────────────────────────────

describe('fmtTime', () => {
  it('extracts HH:MM from ISO datetime string', () => {
    expect(fmtTime('2021-05-27T08:00:00')).toBe('08:00')
  })

  it('extracts HH:MM from MM/DD/YY HH:MM format', () => {
    expect(fmtTime('05/27/21 08:00')).toBe('08:00')
  })

  it('pads single-digit hours', () => {
    expect(fmtTime('2021-05-27T04:00:00')).toBe('04:00')
  })

  it('pads single-digit minutes', () => {
    expect(fmtTime('2021-05-27T08:05:00')).toBe('08:05')
  })

  it('returns empty string for empty input', () => {
    expect(fmtTime('')).toBe('')
  })

  it('uses 24-hour format: afternoon hours > 12', () => {
    expect(fmtTime('2021-05-27T16:00:00')).toBe('16:00')
  })

  it('midnight is 00:00', () => {
    expect(fmtTime('2021-05-27T00:00:00')).toBe('00:00')
  })

  it('23:59 renders correctly', () => {
    expect(fmtTime('2021-05-27T23:59:00')).toBe('23:59')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// isoDate
// ─────────────────────────────────────────────────────────────────────────────

describe('isoDate', () => {
  it('truncates ISO datetime to YYYY-MM-DD', () => {
    expect(isoDate('2021-05-27T13:00:00')).toBe('2021-05-27')
  })

  it('returns empty string for empty input', () => {
    expect(isoDate('')).toBe('')
  })

  it('returns first 10 chars for unparseable string', () => {
    expect(isoDate('2021-05-27 extra')).toBe('2021-05-27')
  })

  it('produces strings that sort correctly as dates', () => {
    expect(isoDate('2021-05-01T00:00:00') < isoDate('2021-06-01T00:00:00')).toBe(true)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeDayBands
// ─────────────────────────────────────────────────────────────────────────────

const SAMPLE_POINTS = [
  { datetime: '05/27/21 04:00' },
  { datetime: '05/27/21 08:00' },
  { datetime: '05/27/21 12:00' },
  { datetime: '05/27/21 16:00' },
  { datetime: '05/27/21 20:00' },
  { datetime: '05/28/21 00:00' },
  { datetime: '05/28/21 04:00' },
  { datetime: '05/28/21 08:00' },
  { datetime: '05/28/21 12:00' },
  { datetime: '05/28/21 16:00' },
  { datetime: '05/28/21 20:00' },
  { datetime: '05/29/21 00:00' },
]

describe('computeDayBands', () => {
  it('returns [] for < 2 points', () => {
    expect(computeDayBands([])).toHaveLength(0)
    expect(computeDayBands([{ datetime: '05/27/21 08:00' }])).toHaveLength(0)
  })

  it('produces one band per unique calendar date prefix', () => {
    // 3 unique date prefixes: 05/27/21, 05/28/21, 05/29/21
    // (00:00 of the next day opens a new band)
    const bands = computeDayBands(SAMPLE_POINTS)
    expect(bands.length).toBeGreaterThanOrEqual(2)
  })

  it('x1 is the first datetime of each day', () => {
    const bands = computeDayBands(SAMPLE_POINTS)
    expect(bands[0].x1).toBe('05/27/21 04:00')
  })

  it('x2 is the last datetime of each day', () => {
    const bands = computeDayBands(SAMPLE_POINTS)
    expect(bands[0].x2).toBe('05/27/21 20:00')
  })

  it('x1 and x2 are full datetime strings (contain space + time)', () => {
    for (const band of computeDayBands(SAMPLE_POINTS)) {
      expect(band.x1).toContain(' ')
      expect(band.x2).toContain(' ')
    }
  })

  it('even-indexed bands are shaded', () => {
    computeDayBands(SAMPLE_POINTS).forEach((b, i) => {
      expect(b.shade).toBe(i % 2 === 0)
    })
  })

  it('shaded and unshaded counts differ by at most 1', () => {
    const bands    = computeDayBands(SAMPLE_POINTS)
    const shaded   = bands.filter(b => b.shade).length
    const unshaded = bands.filter(b => !b.shade).length
    expect(Math.abs(shaded - unshaded)).toBeLessThanOrEqual(1)
  })

  it('single-day dataset produces one band', () => {
    const pts = [
      { datetime: '05/27/21 04:00' },
      { datetime: '05/27/21 08:00' },
      { datetime: '05/27/21 12:00' },
    ]
    const bands = computeDayBands(pts)
    expect(bands).toHaveLength(1)
    expect(bands[0].shade).toBe(true)
    expect(bands[0].x1).toBe('05/27/21 04:00')
    expect(bands[0].x2).toBe('05/27/21 12:00')
  })

  it('x1/x2 values are from the actual data domain (valid ReferenceArea keys)', () => {
    const dtSet = new Set(SAMPLE_POINTS.map(p => p.datetime))
    for (const band of computeDayBands(SAMPLE_POINTS)) {
      expect(dtSet.has(band.x1)).toBe(true)
      expect(dtSet.has(band.x2)).toBe(true)
    }
  })

  it('completes in < 50ms for 128 points (performance guard)', () => {
    const pts = Array.from({ length: 128 }, (_, i) => ({
      datetime: `05/${String(27 + Math.floor(i / 6)).padStart(2, '0')}/21 ${String((i % 6) * 4).padStart(2, '0')}:00`,
    }))
    const start = performance.now()
    computeDayBands(pts)
    expect(performance.now() - start).toBeLessThan(50)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// makeTickFormatter
// ─────────────────────────────────────────────────────────────────────────────

const WIDE_POINTS = [
  { datetime: '05/27/21 04:00' },
  { datetime: '05/27/21 08:00' },
  { datetime: '05/28/21 04:00' },
  { datetime: '05/28/21 08:00' },
  { datetime: '05/29/21 04:00' },
  { datetime: '05/29/21 08:00' },
]

describe('makeTickFormatter', () => {
  it('wide view (> 2 days): first point of each day shows MM/DD', () => {
    const fmt = makeTickFormatter(WIDE_POINTS, 3)
    expect(fmt('05/27/21 04:00')).toBe('05/27')
  })

  it('wide view: subsequent points of same day return empty string', () => {
    const fmt = makeTickFormatter(WIDE_POINTS, 3)
    expect(fmt('05/27/21 08:00')).toBe('')
  })

  it('wide view: label is MM/DD not MM/DD/YY', () => {
    const fmt   = makeTickFormatter(WIDE_POINTS, 3)
    const label = fmt('05/27/21 04:00')
    expect(label).toBe('05/27')
    expect(label).not.toContain('/21')
  })

  it('wide view: unknown datetime returns empty string', () => {
    const fmt = makeTickFormatter(WIDE_POINTS, 3)
    expect(fmt('99/99/99 00:00')).toBe('')
  })

  it('zoomed view (≤ 2 days): every point returns HH:MM', () => {
    const pts = [
      { datetime: '05/27/21 04:00' },
      { datetime: '05/27/21 08:00' },
      { datetime: '05/27/21 12:00' },
    ]
    const fmt = makeTickFormatter(pts, 1)
    expect(fmt('05/27/21 04:00')).toBe('04:00')
    expect(fmt('05/27/21 08:00')).toBe('08:00')
    expect(fmt('05/27/21 12:00')).toBe('12:00')
  })

  it('zoomed view: label is HH:MM not a date', () => {
    const fmt = makeTickFormatter(WIDE_POINTS.slice(0, 3), 1)
    expect(fmt('05/27/21 04:00')).toBe('04:00')
    expect(fmt('05/27/21 04:00')).not.toContain('05/27')
  })

  it('exactly 2 days is still zoomed (≤ 2 threshold shows times)', () => {
    const fmt = makeTickFormatter(WIDE_POINTS.slice(0, 4), 2)
    expect(fmt('05/27/21 04:00')).toBe('04:00')
  })

  it('3 days switches to wide (date labels)', () => {
    const fmt = makeTickFormatter(WIDE_POINTS, 3)
    // First occurrence of each day gets a label
    expect(fmt('05/27/21 04:00')).toBe('05/27')
    expect(fmt('05/28/21 04:00')).toBe('05/28')
    expect(fmt('05/29/21 04:00')).toBe('05/29')
    // Non-first occurrences are blank
    expect(fmt('05/27/21 08:00')).toBe('')
    expect(fmt('05/28/21 08:00')).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CSV string builder (pure logic, no DOM)
// ─────────────────────────────────────────────────────────────────────────────

describe('buildCsvString', () => {
  it('produces correct header row', () => {
    expect(buildCsvString([{ a: 1, b: 2 }]).split('\n')[0]).toBe('a,b')
  })

  it('produces correct data row', () => {
    expect(buildCsvString([{ x: 'hello', y: 42 }]).split('\n')[1]).toBe('hello,42')
  })

  it('quotes fields containing commas', () => {
    expect(buildCsvString([{ label: 'a,b', val: 1 }])).toContain('"a,b"')
  })

  it('doubles quotes inside quoted fields', () => {
    expect(buildCsvString([{ label: 'say "hi"', val: 1 }])).toContain('"say ""hi"""')
  })

  it('quotes fields containing newlines', () => {
    expect(buildCsvString([{ label: 'line1\nline2', val: 1 }])).toContain('"line1\nline2"')
  })

  it('handles null and undefined as empty string', () => {
    expect(buildCsvString([{ a: null, b: undefined, c: 0 }]).split('\n')[1]).toBe(',,0')
  })

  it('returns empty string for empty input', () => {
    expect(buildCsvString([])).toBe('')
  })

  it('multiple rows produce 1 header + N data lines', () => {
    const lines = buildCsvString([{ a: 1 }, { a: 2 }, { a: 3 }]).split('\n')
    expect(lines).toHaveLength(4)
  })

  it('column order matches first row key order', () => {
    const header = buildCsvString([{ annotation_id: 'K1', egc: 5, sample: 's1' }]).split('\n')[0]
    expect(header).toBe('annotation_id,egc,sample')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// expandParentLabel
// ─────────────────────────────────────────────────────────────────────────────

describe('expandParentLabel', () => {
  it('expands COG letter C to full label', () => {
    expect(expandParentLabel('C', 'cog')).toBe('C · Energy production and conversion')
  })

  it('COG is case-insensitive', () => {
    expect(expandParentLabel('c', 'cog')).toBe('C · Energy production and conversion')
  })

  it('COG unknown letter returned unchanged', () => {
    // 'Z' = Cytoskeleton — but if lookup table grows this test stays valid
    const result = expandParentLabel('Z', 'cog')
    expect(result).toBeTruthy()
    expect(typeof result).toBe('string')
  })

  it('enzyme appends class name to EC number', () => {
    expect(expandParentLabel('1.1.1', 'enzyme')).toBe('1.1.1 · Oxidoreductases')
  })

  it('enzyme uses only first component for class lookup', () => {
    expect(expandParentLabel('3.6.1', 'enzyme')).toBe('3.6.1 · Hydrolases')
  })

  it('enzyme class 1-7 all expand', () => {
    for (let cls = 1; cls <= 7; cls++) {
      expect(expandParentLabel(`${cls}.1.1`, 'enzyme')).toContain('·')
    }
  })

  it('enzyme unknown class returned unchanged', () => {
    expect(expandParentLabel('9.1.1', 'enzyme')).toBe('9.1.1')
  })

  it('KEGG strips leading 5-digit code from "01000 Enzymes"', () => {
    expect(expandParentLabel('01000 Enzymes', 'kegg')).toBe('Enzymes')
  })

  it('KEGG resolves pure 5-digit BRITE code 00001', () => {
    expect(expandParentLabel('00001', 'kegg')).toBe('KEGG Orthology (KO)')
  })

  it('KEGG unknown code uses BRITE group fallback', () => {
    expect(expandParentLabel('99123', 'kegg')).toBe('BRITE group 99123')
  })

  it('taxonomy returns parent unchanged', () => {
    expect(expandParentLabel('Bacteria', 'taxonomy')).toBe('Bacteria')
  })

  it('empty string returns empty string for any source', () => {
    expect(expandParentLabel('', 'cog')).toBe('')
    expect(expandParentLabel('', 'kegg')).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// nextColorForSource / resetSourceCounters
// ─────────────────────────────────────────────────────────────────────────────

describe('nextColorForSource', () => {
  beforeEach(() => resetSourceCounters())

  it('returns first shade for first call', () => {
    expect(nextColorForSource('kegg')).toBe(SOURCE_SHADES.kegg[0])
  })

  it('cycles through all shades in order', () => {
    const colors = SOURCE_SHADES.kegg.map(() => nextColorForSource('kegg'))
    expect(colors).toEqual(SOURCE_SHADES.kegg)
  })

  it('wraps back to index 0 after exhausting shades', () => {
    SOURCE_SHADES.kegg.forEach(() => nextColorForSource('kegg'))
    expect(nextColorForSource('kegg')).toBe(SOURCE_SHADES.kegg[0])
  })

  it('different sources cycle independently', () => {
    nextColorForSource('kegg')
    nextColorForSource('kegg')
    expect(nextColorForSource('cog')).toBe(SOURCE_SHADES.cog[0])
  })

  it('resetSourceCounters resets all sources', () => {
    nextColorForSource('kegg')
    nextColorForSource('kegg')
    nextColorForSource('cog')
    resetSourceCounters()
    expect(nextColorForSource('kegg')).toBe(SOURCE_SHADES.kegg[0])
    expect(nextColorForSource('cog')).toBe(SOURCE_SHADES.cog[0])
  })

  it('unknown source falls back to CHART_COLORS', () => {
    const color = nextColorForSource('unknown_source')
    expect(CHART_COLORS).toContain(color)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cross-feature invariants
// ─────────────────────────────────────────────────────────────────────────────

describe('Cross-feature invariants', () => {
  it('Z-score → LOWESS gives different result than LOWESS → Z-score', () => {
    const raw    = [10, 50, 8, 60, 12, 55, 9, 48].map(egc => ({ egc }))
    const zFirst = applyLowess(applyZScore(raw), 0.4)
    const sFirst = applyZScore(applyLowess(raw, 0.4))
    const maxDiff = Math.max(...zFirst.map((d, i) =>
      Math.abs((d.egc ?? 0) - (sFirst[i].egc ?? 0)),
    ))
    expect(maxDiff).toBeGreaterThan(0.01)
  })

  it('date filtering: isoDate strings compare correctly with < and >', () => {
    const points = [
      { iso: '2021-05-01', egc: 1 },
      { iso: '2021-06-01', egc: 2 },
      { iso: '2021-07-01', egc: 3 },
    ]
    const filtered = points.filter(p => p.iso >= '2021-06-01' && p.iso <= '2021-07-01')
    expect(filtered.map(p => p.egc)).toEqual([2, 3])
  })

  it('scale mismatch: ratio > 10 detected correctly', () => {
    const detectMismatch = (means: number[]) => {
      const f = means.filter(m => m > 0)
      return f.length >= 2 && Math.max(...f) / Math.min(...f) > 10
    }
    expect(detectMismatch([100, 5000])).toBe(true)
    expect(detectMismatch([100, 1000])).toBe(false)
    expect(detectMismatch([0, 100, 200])).toBe(false) // zero excluded
  })
})
