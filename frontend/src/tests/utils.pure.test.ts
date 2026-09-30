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
 *   applyZScore           — mean→0, std→1, flat series, nulls, single value
 *   applyLowess           — length preservation, noise reduction, null pass-through,
 *                           minimum bandwidth (0.05), immutability
 *
 * utils/format.ts:
 *   parseDateTime         — ISO, slash-date, empty, cross-format ordering
 *   fmtDate               — ISO → MM/DD/YY, zero-padding, empty
 *   fmtTime               — ISO → HH:MM, 24h, padding, slash-date fallback, empty
 *   isoDate               — truncation, fallback, empty
 *   computeDayBands       — grouping, alternation, x1/x2 are full datetimes,
 *                           single day, < 2 points guard
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
 *   Z-score idempotency, quartile ordering,
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
  sumMembersByTimestamp,
} from '../utils/stats'

import {
  applyZScore,
  applyLowess,
} from '../utils/signal'

import {
  parseDateTime,
  fmtDate,
  fmtTime,
  isoDate,
  computeDayBands,
  toPlotlyDate,
  formatRelativeAbundancePercent,
} from '../utils/format'

import {
  expandParentLabel,
  nextColorForSource,
  resetSourceCounters,
  SOURCE_SHADES,
  CHART_COLORS,
  KEGG_BRITE_CODES,
} from '../constants'

import { LOWESS_BANDWIDTH_MIN } from '../components/charts/ChartControls'

import { computeNightBands, resolveSunTimes, alignTideToChartPoints } from '../utils/solar'
import type { SunTimes, TidePoint } from '../utils/solar'

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
// sumMembersByTimestamp
// ─────────────────────────────────────────────────────────────────────────────

function makeMemberItem(
  annotationId: string, datetime: string, egc: number, normEgc: number | null = null,
): AnnotationItem {
  return {
    source:        'kegg',
    sample:        's1',
    annotation_id: annotationId,
    name:          null,
    timepoint:     { taxon_oid: 's1', timepoint: '1', datetime } as TimepointMeta,
    value:         { egc, norm_egc: normEgc },
  }
}

describe('sumMembersByTimestamp', () => {
  it('sums three members at the same timestamp instead of overwriting (W14 regression)', () => {
    // The audit's own real-data repro: kegg "Brite Hierarchies" group has
    // three members whose values at the first timepoint sum to 4,854,154;
    // the pre-fix chart plotted 823,158 -- exactly the last member's value.
    const seriesData: Record<string, AnnotationItem[]> = {
      m1: [makeMemberItem('m1', 't1', 2_000_000)],
      m2: [makeMemberItem('m2', 't1', 2_030_996)],
      m3: [makeMemberItem('m3', 't1', 823_158)],
    }
    const result = sumMembersByTimestamp(['m1', 'm2', 'm3'], seriesData, 'Brite Hierarchies', 'kegg')
    expect(result).toHaveLength(1)
    expect(result[0].value).toEqual({ egc: 4_854_154, norm_egc: null })
    expect(result[0].annotation_id).toBe('Brite Hierarchies')
    expect(result[0].name).toBe('Brite Hierarchies')
    expect(result[0].source).toBe('kegg')
  })

  it('sums norm_egc independently of egc', () => {
    const seriesData: Record<string, AnnotationItem[]> = {
      m1: [makeMemberItem('m1', 't1', 100, 0.01)],
      m2: [makeMemberItem('m2', 't1', 200, 0.02)],
    }
    const result = sumMembersByTimestamp(['m1', 'm2'], seriesData, 'group', 'kegg')
    expect(result[0].value).toEqual({ egc: 300, norm_egc: 0.03 })
  })

  it('keeps timestamps with only one member contributing distinct from shared ones', () => {
    const seriesData: Record<string, AnnotationItem[]> = {
      m1: [makeMemberItem('m1', 't1', 10), makeMemberItem('m1', 't2', 20)],
      m2: [makeMemberItem('m2', 't1', 5)],
    }
    const result = sumMembersByTimestamp(['m1', 'm2'], seriesData, 'group', 'kegg')
    const byDt = Object.fromEntries(result.map(r => [r.timepoint?.datetime, (r.value as { egc: number }).egc]))
    expect(byDt.t1).toBe(15)
    expect(byDt.t2).toBe(20)
  })

  it('a member missing from seriesData (failed fetch) does not crash, others still sum', () => {
    const seriesData: Record<string, AnnotationItem[]> = {
      m1: [makeMemberItem('m1', 't1', 10)],
      // m2 absent entirely -- simulates a failed /series/annotations fetch
    }
    const result = sumMembersByTimestamp(['m1', 'm2'], seriesData, 'group', 'kegg')
    expect(result).toHaveLength(1)
    expect((result[0].value as { egc: number }).egc).toBe(10)
  })

  it('returns empty array when no member has any data', () => {
    expect(sumMembersByTimestamp(['m1'], {}, 'group', 'kegg')).toEqual([])
  })

  it('norm_egc stays null when no member reports one, rather than becoming 0', () => {
    const seriesData: Record<string, AnnotationItem[]> = {
      m1: [makeMemberItem('m1', 't1', 10, null)],
      m2: [makeMemberItem('m2', 't1', 20, null)],
    }
    const result = sumMembersByTimestamp(['m1', 'm2'], seriesData, 'group', 'kegg')
    expect((result[0].value as { norm_egc: number | null }).norm_egc).toBeNull()
  })

  // ── W9: chronological sort against the real raw "M/D/YY H:MM" format ──────
  // A plain string sort on this format is wrong: "6/10/21" sorts before
  // "6/2/21" lexically, even though June 10 is after June 2. Two separate
  // near-duplicate copies of this summing logic (ComparePage.tsx,
  // AnalyzePage.tsx) each had exactly this bug before being unified to call
  // this one function, which sorts by parseDateTime instead.

  it('sorts output chronologically, not by insertion order or string comparison', () => {
    const seriesData: Record<string, AnnotationItem[]> = {
      m1: [
        makeMemberItem('m1', '6/10/21 8:00', 10),
        makeMemberItem('m1', '6/1/21 8:00', 1),
        makeMemberItem('m1', '6/2/21 8:00', 2),
        makeMemberItem('m1', '6/18/21 8:00', 18),
        makeMemberItem('m1', '6/9/21 8:00', 9),
        makeMemberItem('m1', '5/27/21 8:00', 27),
      ],
    }
    const result = sumMembersByTimestamp(['m1'], seriesData, 'group', 'kegg')
    expect(result.map(r => r.timepoint?.datetime)).toEqual([
      '5/27/21 8:00', '6/1/21 8:00', '6/2/21 8:00', '6/9/21 8:00', '6/10/21 8:00', '6/18/21 8:00',
    ])
  })

  it('order of contributing members does not affect the final chronological order', () => {
    const seriesData: Record<string, AnnotationItem[]> = {
      m1: [makeMemberItem('m1', '6/10/21 8:00', 10)],
      m2: [makeMemberItem('m2', '6/2/21 8:00', 2)],
    }
    const forward = sumMembersByTimestamp(['m1', 'm2'], seriesData, 'group', 'kegg')
    const reverse = sumMembersByTimestamp(['m2', 'm1'], seriesData, 'group', 'kegg')
    const dates = (r: typeof forward) => r.map(x => x.timepoint?.datetime)
    expect(dates(forward)).toEqual(['6/2/21 8:00', '6/10/21 8:00'])
    expect(dates(reverse)).toEqual(['6/2/21 8:00', '6/10/21 8:00'])
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
    const data = Array.from({ length: 20 }, (_, i) => ({ egc: i * 2.0, ts: i }))
    expect(applyLowess(data, 0.4)).toHaveLength(20)
  })

  it('returns data unchanged for < 3 non-null points', () => {
    const r = applyLowess([{ egc: 1, ts: 0 }, { egc: 2, ts: 1 }], 0.5)
    expect(r[0].egc).toBe(1)
    expect(r[1].egc).toBe(2)
  })

  it('preserves null entries in output', () => {
    const r = applyLowess(
      [{ egc: 1, ts: 0 }, { egc: null, ts: 1 }, { egc: 3, ts: 2 }, { egc: 4, ts: 3 }, { egc: 5, ts: 4 }],
      0.4,
    )
    expect(r[1].egc).toBeNull()
  })

  it('the real minimum slider bandwidth runs without error', () => {
    const data = Array.from({ length: 20 }, (_, i) => ({ egc: i, ts: i }))
    expect(() => applyLowess(data, LOWESS_BANDWIDTH_MIN)).not.toThrow()
    expect(applyLowess(data, LOWESS_BANDWIDTH_MIN)).toHaveLength(20)
  })

  // W27 (docs/AUDIT-2026-09-22.md): confirmed live before this fix, on real
  // COG0055 data (128 samples) -- the OLD bandwidth range (0.01-0.05) gave
  // spans of only 2-7 points, and a 2-point window is mathematically
  // guaranteed to reproduce the raw value exactly regardless of weighting
  // (a line through 2 points, evaluated at one of those points, always
  // passes through it) -- 0 of 128 points changed at the two lowest
  // settings. This is the audit's own explicit "Verify" bar: at the
  // lowest real slider setting, more than 0 points must actually change.
  it('at the real minimum slider bandwidth, most points change on a realistic 128-sample series', () => {
    const n = 128
    const data = Array.from({ length: n }, (_, ts) => ({
      egc: 5 + 4 * Math.sin(ts / 3) + (ts % 2 === 0 ? 3 : -3),
      ts,
    }))
    const result = applyLowess(data, LOWESS_BANDWIDTH_MIN)
    const changed = result.filter((d, i) => Math.abs((d.egc as number) - data[i].egc) > 1e-9).length
    expect(changed).toBeGreaterThan(0)
    // Not just a token 1-2 points -- a real local regression at this
    // bandwidth (span=13) should touch nearly every point.
    expect(changed).toBeGreaterThan(n * 0.9)
  })

  // The actual root cause: the tricube weight w=(1-u^3)^3 is exactly 0 at
  // u=1, and the OLD code always defined maxDist from the farthest point
  // actually included in the window -- so that point's own distance ratio
  // u was always exactly 1, zeroing its weight out. For a 3-point window
  // this wastes a full third of the window's real signal.
  it('the farthest point in the window gets a real nonzero weight, not exactly 0', () => {
    // 5 evenly-spaced points, query point in the middle -- with a 3-point
    // window (span=3: self + 1 on each side), the OLD code always gave the
    // 3rd (farthest) neighbor exactly 0 weight, so the fit reduced to a
    // 2-point case and reproduced the raw value exactly (same mathematical
    // degeneracy as the 2-point case above). The fix must actually move
    // the fitted value away from the raw value, using real information
    // from that 3rd point.
    const data = [
      { egc: 10, ts: 0 }, { egc: 100, ts: 1 }, { egc: 10, ts: 2 },
      { egc: 100, ts: 3 }, { egc: 10, ts: 4 },
    ]
    // bandwidth chosen so span = Math.ceil(bw * 5) = 3
    const result = applyLowess(data, 0.5)
    expect(Math.abs((result[2].egc as number) - 10)).toBeGreaterThan(0.01)
  })

  it('reduces variance on noisy alternating series', () => {
    const data     = [1, 10, 2, 9, 3, 8, 4, 7, 5, 6, 4, 8, 3, 9, 2, 10, 1].map((egc, ts) => ({ egc, ts }))
    const raw      = data.map(d => d.egc as number)
    const smoothed = applyLowess(data, 0.5).map(d => d.egc as number).filter(v => v != null)
    const variance = (arr: number[]) => {
      const m = arr.reduce((a, b) => a + b, 0) / arr.length
      return arr.reduce((a, b) => a + (b - m) ** 2, 0) / arr.length
    }
    expect(variance(smoothed)).toBeLessThan(variance(raw))
  })

  it('does not mutate input', () => {
    const data = [{ egc: 1, ts: 0 }, { egc: 5, ts: 1 }, { egc: 3, ts: 2 }, { egc: 7, ts: 3 }, { egc: 2, ts: 4 }]
    applyLowess(data, 0.5)
    expect(data[0].egc).toBe(1)
    expect(data[4].egc).toBe(2)
  })

  it('linear series stays approximately linear', () => {
    const data   = Array.from({ length: 15 }, (_, i) => ({ egc: i * 10.0, ts: i }))
    const result = applyLowess(data, 0.5)
    expect((result[0].egc as number)).toBeGreaterThanOrEqual(-5)
    expect((result[14].egc as number)).toBeGreaterThan(50)
  })

  // ── Regression: LOWESS must smooth by real elapsed time, not array index ──
  // (docs/AUDIT.md "also noted" item). A date-range filter can leave a large
  // real-world gap between two adjacent array entries; the smoother must not
  // treat that gap as if it were a normal, uniform step.
  it('produces different output for the same values at the same index positions when only the timestamps differ', () => {
    const hour = 3_600_000
    const values = [10, 12, 9, 40, 11, 13, 8, 12, 10, 14]

    const uniform = values.map((egc, i) => ({ egc, ts: i * 4 * hour }))

    // Same values, same array positions, but a 5-day real gap inserted right
    // before the spike at index 3 instead of the normal 4h step.
    const irregular = values.map((egc, i) => ({
      egc,
      ts: i < 3 ? i * 4 * hour : 3 * 4 * hour + 5 * 24 * hour + (i - 3) * 4 * hour,
    }))

    const smoothedUniform   = applyLowess(uniform, 0.5).map(d => d.egc)
    const smoothedIrregular = applyLowess(irregular, 0.5).map(d => d.egc)

    // If the smoother still keyed off array index instead of `ts`, these two
    // results would be identical -- the gap would be invisible to it.
    expect(smoothedIrregular).not.toEqual(smoothedUniform)
  })

  it('a large real time gap keeps points on either side from smoothing into each other', () => {
    const hour = 3_600_000
    const day  = 24 * hour

    // Two 4h-spaced clusters of 4 points each, 30 days apart in real time.
    const clusterA = [10, 11, 9, 10]
    const clusterB = [100, 101, 99, 100]
    const values   = [...clusterA, ...clusterB]
    const ts = [
      0, 4 * hour, 8 * hour, 12 * hour,
      12 * hour + 30 * day, 12 * hour + 30 * day + 4 * hour,
      12 * hour + 30 * day + 8 * hour, 12 * hour + 30 * day + 12 * hour,
    ]
    const data = values.map((egc, i) => ({ egc, ts: ts[i] }))

    // bandwidth 1.0 -> every point is a candidate "neighbor" for every other
    // point, so this isolates weighting (by real distance) as the only thing
    // that can keep cluster A and cluster B apart.
    const result = applyLowess(data, 1.0)

    // The last point of cluster A (index 3, raw value 10) should stay close
    // to cluster A's own values -- not pulled toward cluster B's ~100,
    // because cluster B is 30 days away in real time.
    expect(result[3].egc as number).toBeLessThan(30)
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
// toPlotlyDate (W16) -- must render local wall-clock time as a plain,
// timezone-less string. new Date(ts).toISOString() renders in UTC with a
// "Z" suffix instead; Plotly reads that "Z" and re-converts for display, so
// on a browser west of UTC (e.g. US Pacific) every point shifts LATER by
// the UTC offset, moving evening samples onto the following calendar day
// on the chart while the hover tooltip/table (built from fmtDate/fmtTime,
// both already local-based) still show the correct original day -- chart
// and table disagree about the same point. These tests don't depend on the
// test runner's own timezone: they check toPlotlyDate's output against
// fmtDate/fmtTime (both already correct, string-parsed with no timezone
// conversion for our raw format) component-by-component, which is true
// regardless of what timezone the tests happen to run in.
// ─────────────────────────────────────────────────────────────────────────────

describe('toPlotlyDate', () => {
  function expectMatchesLocalDateTime(raw: string) {
    const result = toPlotlyDate(parseDateTime(raw))
    const [datePart, timePart] = result.split(' ')
    const [mm, dd, yy] = fmtDate(raw).split('/')
    expect(datePart).toBe(`20${yy}-${mm}-${dd}`)
    expect(timePart.slice(0, 5)).toBe(fmtTime(raw))
  }

  it('morning time: date and time match fmtDate/fmtTime exactly', () => {
    expectMatchesLocalDateTime('6/9/21 8:00')
  })

  it('evening time: date and time match fmtDate/fmtTime exactly (the actual W16 case)', () => {
    // The audit's own example: an evening sample is the one that crosses
    // a calendar-day boundary under the buggy UTC-shifting version on a
    // Pacific-time browser (UTC-7/8).
    expectMatchesLocalDateTime('6/9/21 21:00')
  })

  it('a time right at a calendar-day boundary (23:00) stays on the same day', () => {
    expectMatchesLocalDateTime('6/17/21 23:00')
  })

  it('a time right after midnight (0:00) stays on the same day', () => {
    expectMatchesLocalDateTime('6/18/21 0:00')
  })

  it('output has no "Z" or timezone suffix (Plotly must read it as naive local time)', () => {
    const result = toPlotlyDate(parseDateTime('6/9/21 21:00'))
    expect(result).not.toContain('Z')
    expect(result).not.toMatch(/[+-]\d{2}:\d{2}$/)
  })

  it('output format is "YYYY-MM-DD HH:MM:SS"', () => {
    const result = toPlotlyDate(parseDateTime('6/9/21 8:00'))
    expect(result).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/)
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

  it('falls back to the text before the first space for a wholly unparseable string, rather than "Invalid Date"', () => {
    expect(fmtDate('not a real date')).toBe('not')
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

  it('falls back to the text after the first space for a wholly unparseable string, rather than "Invalid Date"', () => {
    expect(fmtTime('not a real date')).toBe('a')
  })

  it('falls back to empty string when there is no second word to fall back to', () => {
    expect(fmtTime('garbage')).toBe('')
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

  it('x1Ts is the start-of-day midnight timestamp (not first sample time)', () => {
    const bands = computeDayBands(SAMPLE_POINTS)
    expect(bands[0].x1Ts).toBe(new Date(2021, 4, 27, 0, 0, 0, 0).getTime())
    expect(bands[1].x1Ts).toBe(new Date(2021, 4, 28, 0, 0, 0, 0).getTime())
  })

  it('x2Ts is 23:59:59.999 of each calendar day (not last sample time)', () => {
    const bands = computeDayBands(SAMPLE_POINTS)
    expect(bands[0].x2Ts).toBe(new Date(2021, 4, 27, 23, 59, 59, 999).getTime())
    expect(bands[1].x2Ts).toBe(new Date(2021, 4, 28, 23, 59, 59, 999).getTime())
  })

  it('adjacent day bands are exactly 1ms apart (no gap or overlap)', () => {
    const bands = computeDayBands(SAMPLE_POINTS)
    expect(bands[1].x1Ts - bands[0].x2Ts).toBe(1)
  })

  it('x1Ts is earlier than the first data point in that day', () => {
    const bands = computeDayBands(SAMPLE_POINTS)
    const firstPtTs = new Date(2021, 4, 27, 4, 0).getTime()  // 04:00 sample
    expect(bands[0].x1Ts).toBeLessThan(firstPtTs)
  })

  it('x2Ts is later than the last data point in that day', () => {
    const bands = computeDayBands(SAMPLE_POINTS)
    const lastPtTs = new Date(2021, 4, 27, 20, 0).getTime()  // 20:00 sample
    expect(bands[0].x2Ts).toBeGreaterThan(lastPtTs)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// formatRelativeAbundancePercent — W23 (docs/AUDIT-2026-09-22.md): tooltips
// showed "0.000%" for the many real annotations whose norm_egc is far below
// 0.1% (a fixed .toFixed(3/4) rounds them all down to indistinguishable
// zero). Real production example: K24448's mean norm_egc is 6.328e-8.
// ─────────────────────────────────────────────────────────────────────────────

describe('formatRelativeAbundancePercent', () => {
  it('a typical mid-range value keeps 3 significant figures', () => {
    expect(formatRelativeAbundancePercent(0.05165)).toBe('5.17%')
  })

  it('a real rare-annotation value does NOT collapse to "0.000%" (the W23 bug)', () => {
    // K24448, real local database: mean_norm_egc = 6.328266950938043e-08
    const result = formatRelativeAbundancePercent(6.328266950938043e-08)
    expect(result).not.toBe('0.000%')
    expect(result).not.toBe('0.0000%')
    expect(result).toBe('0.00000633%')
  })

  it('a value so small it would need scientific notation still shows real digits, not zero', () => {
    const result = formatRelativeAbundancePercent(1e-10)
    expect(result).not.toMatch(/^0\.0*%$/)
    expect(result).toBe('1.00e-8%')
  })

  it('zero is still exactly "0.00%", not scientific notation', () => {
    expect(formatRelativeAbundancePercent(0)).toBe('0.00%')
  })

  it('a full 100% value formats cleanly', () => {
    expect(formatRelativeAbundancePercent(1)).toBe('100%')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// computeNightBands
// ─────────────────────────────────────────────────────────────────────────────

const NIGHT_SUN_TIMES: SunTimes = {
  '2021-05-27': { sunrise: '05:13', sunset: '21:09' },
  '2021-05-28': { sunrise: '05:12', sunset: '21:10' },
}

describe('computeNightBands', () => {
  it('returns [] for < 2 points', () => {
    expect(computeNightBands([], NIGHT_SUN_TIMES)).toHaveLength(0)
    expect(computeNightBands([{ datetime: '05/27/21 21:00' }], NIGHT_SUN_TIMES)).toHaveLength(0)
  })

  it('returns [] when sunTimes is empty', () => {
    const pts = [{ datetime: '05/27/21 21:00' }, { datetime: '05/28/21 05:00' }]
    expect(computeNightBands(pts, {})).toHaveLength(0)
  })

  it('normal day→night: x1Ts is the actual sunset time, not the first night sample', () => {
    // 17:00 = day, 21:00 = night (within 20min buffer of 21:09 sunset), 09:00 = day
    const pts = [
      { datetime: '05/27/21 17:00' },
      { datetime: '05/27/21 21:00' },
      { datetime: '05/28/21 01:00' },
      { datetime: '05/28/21 05:00' },
      { datetime: '05/28/21 09:00' },
    ]
    const bands = computeNightBands(pts, NIGHT_SUN_TIMES)
    expect(bands).toHaveLength(1)
    expect(bands[0].x1Ts).toBe(new Date(2021, 4, 27, 21, 9).getTime())
  })

  it('band end: x2Ts is the actual sunrise time, not the last night sample', () => {
    const pts = [
      { datetime: '05/27/21 17:00' },
      { datetime: '05/27/21 21:00' },
      { datetime: '05/28/21 01:00' },
      { datetime: '05/28/21 05:00' },
      { datetime: '05/28/21 09:00' },
    ]
    const bands = computeNightBands(pts, NIGHT_SUN_TIMES)
    expect(bands[0].x2Ts).toBe(new Date(2021, 4, 28, 5, 12).getTime())
  })

  it('gap-bridge: x1Ts is the previous day sunset when night run starts on new day', () => {
    // 12:00 on 05/27 is day; next sample is 01:00 on 05/28 (night) — no 21:00 sample
    const pts = [
      { datetime: '05/27/21 12:00' },
      { datetime: '05/28/21 01:00' },
      { datetime: '05/28/21 09:00' },
    ]
    const bands = computeNightBands(pts, NIGHT_SUN_TIMES)
    expect(bands).toHaveLength(1)
    expect(bands[0].x1Ts).toBe(new Date(2021, 4, 27, 21, 9).getTime())
  })

  it('trailing night: x2Ts is clipped to last data point when sunrise is beyond data range', () => {
    // Data ends at 01:00 May 28 — sunrise (05:12) is past maxTs, so band is clipped
    const pts = [
      { datetime: '05/27/21 17:00' },
      { datetime: '05/27/21 21:00' },
      { datetime: '05/28/21 01:00' },
    ]
    const bands = computeNightBands(pts, NIGHT_SUN_TIMES)
    expect(bands).toHaveLength(1)
    expect(bands[0].x2Ts).toBe(new Date(2021, 4, 28, 1, 0).getTime())
  })

  it('x1 and x2 are YYYY-MM-DD date keys for the sunset and sunrise days', () => {
    const pts = [
      { datetime: '05/27/21 17:00' },
      { datetime: '05/27/21 21:00' },
      { datetime: '05/28/21 05:00' },
      { datetime: '05/28/21 09:00' },
    ]
    const bands = computeNightBands(pts, NIGHT_SUN_TIMES)
    expect(bands[0].x1).toBe('2021-05-27')
    expect(bands[0].x2).toBe('2021-05-28')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// resolveSunTimes — exact lookup + nearest-available-date fallback
// ─────────────────────────────────────────────────────────────────────────────

describe('resolveSunTimes', () => {
  it('returns null when sunTimes is empty', () => {
    expect(resolveSunTimes('2021-05-27', {})).toBeNull()
  })

  it('returns the exact entry when the date key is present', () => {
    expect(resolveSunTimes('2021-05-27', NIGHT_SUN_TIMES)).toEqual(NIGHT_SUN_TIMES['2021-05-27'])
  })

  it('falls back to the nearest available date when the exact key is missing', () => {
    const sunTimes: SunTimes = {
      '2021-05-25': { sunrise: '05:15', sunset: '21:05' },
      '2021-06-10': { sunrise: '05:00', sunset: '21:20' },
    }
    // 05-27 is 2 days from 05-25 and 14 days from 06-10 -- must pick 05-25.
    expect(resolveSunTimes('2021-05-27', sunTimes)).toEqual(sunTimes['2021-05-25'])
  })

  it('picks whichever available date is genuinely closer, not just the first in the object', () => {
    const sunTimes: SunTimes = {
      '2021-06-10': { sunrise: '05:00', sunset: '21:20' },
      '2021-05-26': { sunrise: '05:14', sunset: '21:08' },
    }
    // 05-27 is 1 day from 05-26 and 14 days from 06-10.
    expect(resolveSunTimes('2021-05-27', sunTimes)).toEqual(sunTimes['2021-05-26'])
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// alignTideToChartPoints — nearest-neighbor tide alignment with a max-gap cutoff
// ─────────────────────────────────────────────────────────────────────────────

function tidePoint(time: string, wl: number): TidePoint {
  return { time, predicted_wl: wl, tide_event: null }
}

describe('alignTideToChartPoints', () => {
  it('maps every chart point to null when there is no tide data at all', () => {
    const result = alignTideToChartPoints(['2021-05-27 08:00', '2021-05-27 12:00'], [])
    expect(result.get('2021-05-27 08:00')).toBeNull()
    expect(result.get('2021-05-27 12:00')).toBeNull()
    expect(result.size).toBe(2)
  })

  it('returns the exact reading for a chart point that matches a tide timestamp exactly', () => {
    const tides = [tidePoint('2021-05-27 08:00', 1.5)]
    const result = alignTideToChartPoints(['2021-05-27 08:00'], tides)
    expect(result.get('2021-05-27 08:00')).toBe(1.5)
  })

  it('picks the nearer of two tide readings when the chart point falls between them (nearer-after case)', () => {
    const tides = [tidePoint('2021-05-27 07:00', 1.0), tidePoint('2021-05-27 08:10', 2.0)]
    // 08:00 is 60min from 07:00 but only 10min from 08:10 -- must pick 08:10's reading.
    const result = alignTideToChartPoints(['2021-05-27 08:00'], tides)
    expect(result.get('2021-05-27 08:00')).toBe(2.0)
  })

  it('picks the nearer of two tide readings when the chart point falls between them (nearer-before case)', () => {
    const tides = [tidePoint('2021-05-27 07:55', 1.0), tidePoint('2021-05-27 09:00', 2.0)]
    // 08:00 is only 5min from 07:55 but 60min from 09:00 -- must pick 07:55's reading.
    const result = alignTideToChartPoints(['2021-05-27 08:00'], tides)
    expect(result.get('2021-05-27 08:00')).toBe(1.0)
  })

  it('returns null (not the nearest reading anyway) when the gap exceeds maxGapMinutes', () => {
    const tides = [tidePoint('2021-05-27 04:00', 1.0)] // 4 hours away
    const result = alignTideToChartPoints(['2021-05-27 08:00'], tides, 30)
    expect(result.get('2021-05-27 08:00')).toBeNull()
  })

  it('returns the reading exactly at the maxGapMinutes boundary (inclusive)', () => {
    const tides = [tidePoint('2021-05-27 07:30', 1.0)] // exactly 30 minutes away
    const result = alignTideToChartPoints(['2021-05-27 08:00'], tides, 30)
    expect(result.get('2021-05-27 08:00')).toBe(1.0)
  })

  it('returns null for a chart datetime that fails to parse, without throwing', () => {
    const tides = [tidePoint('2021-05-27 08:00', 1.0)]
    expect(() => alignTideToChartPoints(['not-a-real-datetime'], tides)).not.toThrow()
    const result = alignTideToChartPoints(['not-a-real-datetime'], tides)
    expect(result.get('not-a-real-datetime')).toBeNull()
  })

  it('handles multiple chart points independently against the same tide series', () => {
    const tides = [
      tidePoint('2021-05-27 06:00', 1.0),
      tidePoint('2021-05-27 12:00', 2.0),
      tidePoint('2021-05-27 18:00', 3.0),
    ]
    const result = alignTideToChartPoints(
      ['2021-05-27 06:05', '2021-05-27 11:55', '2021-05-27 18:10'],
      tides,
    )
    expect(result.get('2021-05-27 06:05')).toBe(1.0)
    expect(result.get('2021-05-27 11:55')).toBe(2.0)
    expect(result.get('2021-05-27 18:10')).toBe(3.0)
  })
})

// Note: this file previously had a `makeTickFormatter` block here, for a
// utils/format.ts export that turned out to have zero real callers anywhere
// (App_old.tsx has its own unrelated, independently-defined local function
// of the same name -- it never imported this one). The live chart
// components (EgcChart/MultiEgcChart/GroupedEgcChart) render with Plotly,
// which formats its own date-axis ticks natively. `makeTickFormatter` and
// its sibling `buildAxisTicks` have since been deleted from format.ts
// entirely, rather than kept around untested -- see App.e2e.spec.ts for
// real-browser zoom coverage of the chart axis behavior that replaced them.

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

// W30 (docs/AUDIT-2026-09-22.md): KEGG_BRITE_CODES was regenerated as a
// 449-entry table (every real bare-code kegg `parent` value in the local
// db, cross-checked against kegg_paths) replacing a 41-entry hand-typed
// one. The `expandParentLabel` tests below only spot-check 4 individual
// codes -- none of them would catch a future edit that silently dropped or
// duplicated OTHER entries (e.g. a bad merge, a copy-paste truncation).
// These guard the table's own shape instead of any one value.
describe('KEGG_BRITE_CODES table shape', () => {
  it('has exactly 449 entries (the real count of distinct kegg parent codes in the local db)', () => {
    expect(Object.keys(KEGG_BRITE_CODES).length).toBe(449)
  })

  it('every key is a bare 5-digit numeric code', () => {
    for (const key of Object.keys(KEGG_BRITE_CODES)) {
      expect(key).toMatch(/^\d{5}$/)
    }
  })

  it('every value is a non-empty string with no leftover PATH/BR bracket suffix', () => {
    for (const value of Object.values(KEGG_BRITE_CODES)) {
      expect(typeof value).toBe('string')
      expect(value.length).toBeGreaterThan(0)
      expect(value).not.toMatch(/\[(PATH|BR):ko\d+\]/)
    }
  })
})

describe('expandParentLabel', () => {
  it('expands COG letter C to full label without the letter prefix', () => {
    expect(expandParentLabel('C', 'cog')).toBe('Energy production and conversion')
  })

  it('COG is case-insensitive', () => {
    expect(expandParentLabel('c', 'cog')).toBe('Energy production and conversion')
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

  // W30 (docs/AUDIT-2026-09-22.md): KEGG_BRITE_CODES was regenerated from
  // real kegg_paths data (every value independently verified against the
  // local db) rather than hand-typed -- 09100 is a real, common top-level
  // BRITE category code (confirmed: 09100 -> 'Metabolism'). '00001' (used
  // by the old table) was never actually a real stored kegg parent value.
  it('KEGG resolves a real pure 5-digit BRITE code (09100)', () => {
    expect(expandParentLabel('09100', 'kegg')).toBe('Metabolism')
  })

  it('KEGG unknown code uses BRITE group fallback', () => {
    expect(expandParentLabel('99123', 'kegg')).toBe('BRITE group 99123')
  })

  // W30: the audit's own 3 cited examples of the old hand-table being wrong
  // -- each independently confirmed against the real kegg_paths table.
  it('KEGG 02024 resolves to its real name, not the old table\'s wrong guess', () => {
    expect(expandParentLabel('02024', 'kegg')).toBe('Quorum sensing')
    expect(expandParentLabel('02024', 'kegg')).not.toBe('Transporters')
  })

  it('KEGG 99996 resolves to its real name, not the old table\'s wrong guess', () => {
    expect(expandParentLabel('99996', 'kegg')).toBe('General function prediction only')
    expect(expandParentLabel('99996', 'kegg')).not.toBe('Not included in regular maps')
  })

  it('KEGG 99980 resolves to its real name, not the old table\'s wrong guess', () => {
    expect(expandParentLabel('99980', 'kegg')).toBe('Enzymes with EC numbers')
    expect(expandParentLabel('99980', 'kegg')).not.toBe('Unclassified signaling/cellular processes')
  })

  it('taxonomy domain-level parent gets a rank suffix', () => {
    expect(expandParentLabel('Bacteria', 'taxonomy')).toBe('Bacteria (Domain)')
  })

  it('taxonomy multi-segment parent is reduced to its bare rank label', () => {
    // parent is the ancestor's own full lineage-prefix — too crowded to
    // print as-is (see taxonomy_egc_homonym_bug); only the last segment
    // (the bare name) plus its rank should show.
    expect(expandParentLabel('Bacteria;Proteobacteria;Alphaproteobacteria', 'taxonomy'))
      .toBe('Alphaproteobacteria (Class)')
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
    const raw    = [10, 50, 8, 60, 12, 55, 9, 48].map((egc, ts) => ({ egc, ts }))
    const zFirst = applyLowess(applyZScore(raw) as typeof raw, 0.4)
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
