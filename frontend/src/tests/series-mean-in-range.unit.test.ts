/**
 * series-mean-in-range.unit.test.ts
 * ===================================
 * seriesMeanInRange (utils/stats.ts) -- the per-entry mean shown on each
 * Compare page selected-annotation chip. Same metric extraction as
 * Analyze's card-header mean (extractEgc / extractNormEgc), and the same
 * inclusive date-window rule MultiEgcChart applies (isoDate of each
 * point's timepoint.datetime compared against dateFrom/dateTo), so the
 * chip's number always describes exactly what the chart is showing.
 *
 * Run: npx vitest run src/tests/series-mean-in-range.unit.test.ts
 */
import { describe, it, expect } from 'vitest'
import { seriesMeanInRange } from '../utils/stats'

const point = (day: number, egc: number | null, norm: number | null) => ({
  timepoint: { datetime: `2021-05-${String(day).padStart(2, '0')}T08:00:00` },
  value:     { egc, norm_egc: norm },
})

const DATA = [
  point(1, 100, 0.0001),
  point(2, 200, 0.0002),
  point(3, 300, 0.0003),
  point(4, 400, 0.0004),
]

describe('seriesMeanInRange', () => {
  it('raw egc mean over all points', () => {
    expect(seriesMeanInRange(DATA, 'egc', '', '')).toEqual({ mean: 250, n: 4 })
  })

  it('norm_egc mean over all points', () => {
    const r = seriesMeanInRange(DATA, 'norm_egc', '', '')!
    expect(r.n).toBe(4)
    expect(r.mean).toBeCloseTo(0.00025, 12)
  })

  it('date window is inclusive at both ends, matching MultiEgcChart', () => {
    expect(seriesMeanInRange(DATA, 'egc', '2021-05-02', '2021-05-03')).toEqual({ mean: 250, n: 2 })
    expect(seriesMeanInRange(DATA, 'egc', '2021-05-03', '')).toEqual({ mean: 350, n: 2 })
    expect(seriesMeanInRange(DATA, 'egc', '', '2021-05-01')).toEqual({ mean: 100, n: 1 })
  })

  it('points with no value for the metric are skipped, not counted as zero', () => {
    const data = [point(1, 100, null), point(2, null, 0.0002)]
    expect(seriesMeanInRange(data, 'egc', '', '')).toEqual({ mean: 100, n: 1 })
    expect(seriesMeanInRange(data, 'norm_egc', '', '')).toEqual({ mean: 0.0002, n: 1 })
  })

  it('returns null when nothing falls in range', () => {
    expect(seriesMeanInRange(DATA, 'egc', '2021-06-01', '')).toBeNull()
    expect(seriesMeanInRange([], 'egc', '', '')).toBeNull()
  })
})
