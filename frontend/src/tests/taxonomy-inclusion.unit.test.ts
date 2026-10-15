/**
 * taxonomy-inclusion.unit.test.ts
 * =================================
 * computeInclusionSeries (utils/taxonomy.ts) -- the Taxonomy page's
 * "Keep only checked" line: the per-sample sum of only the checked branches,
 * the complement of computeExclusionSeries' "minus checked" line (the two
 * always add back up to the scope's full total).
 *
 * Run: npx vitest run src/tests/taxonomy-inclusion.unit.test.ts
 */
import { describe, it, expect } from 'vitest'
import { computeInclusionSeries, computeExclusionSeries } from '../utils/taxonomy'
import type { AnnotationItem } from '../types'

const pt = (id: string, sample: string, egc: number | null, norm: number | null = null): AnnotationItem => ({
  source: 'taxonomy', sample, annotation_id: id, name: id,
  timepoint: { taxon_oid: sample, timepoint: sample, datetime: `2021-05-0${sample.slice(1)}T08:00:00` },
  value: { egc, norm_egc: norm },
} as AnnotationItem)

const ROOT = [pt('Bacteria', 's1', 100, 0.10), pt('Bacteria', 's2', 200, 0.20), pt('Bacteria', 's3', 300, 0.30)]
const A    = [pt('Bacteria;A', 's1', 10, 0.01), pt('Bacteria;A', 's2', 20, 0.02)]           // absent in s3
const B    = [pt('Bacteria;B', 's1', 5, 0.005), pt('Bacteria;B', 's3', 30, 0.03)]           // absent in s2
const egc  = (s: AnnotationItem[]) => s.map(i => (i.value as { egc: number }).egc)
const norm = (s: AnnotationItem[]) => s.map(i => (i.value as { norm_egc: number }).norm_egc)

describe('computeInclusionSeries', () => {
  it('sums only the kept branches per sample, on the scope\'s sample axis (absent = 0)', () => {
    const out = computeInclusionSeries(ROOT, ['Bacteria;A', 'Bacteria;B'], [A, B], 'X__keep', 'A + B')
    expect(out.map(i => i.sample)).toEqual(['s1', 's2', 's3'])
    expect(egc(out)).toEqual([15, 20, 30])
    norm(out).forEach((v, i) => expect(v).toBeCloseTo([0.015, 0.02, 0.03][i], 12))
    expect(out[0]).toMatchObject({ annotation_id: 'X__keep', name: 'A + B' })
  })

  it('a kept branch nested under another kept branch is not counted twice', () => {
    const AA = [pt('Bacteria;A;AA', 's1', 7), pt('Bacteria;A;AA', 's2', 7)]
    const out = computeInclusionSeries(ROOT, ['Bacteria;A', 'Bacteria;A;AA'], [A, AA], 'X', null)
    expect(egc(out)).toEqual([10, 20, 0])
  })

  it('keep + remove for the same checked set add back up to the full scope total', () => {
    const kept    = computeInclusionSeries(ROOT, ['Bacteria;A', 'Bacteria;B'], [A, B], 'k', null)
    const removed = computeExclusionSeries(ROOT, ['Bacteria;A', 'Bacteria;B'], [A, B], 'r', null)
    expect(egc(kept).map((v, i) => v + egc(removed)[i])).toEqual(egc(ROOT))
  })

  it('drops samples where the scope itself has no value, same as the exclusion line', () => {
    const root = [pt('Bacteria', 's1', null), pt('Bacteria', 's2', 200)]
    const out = computeInclusionSeries(root, ['Bacteria;A'], [A], 'k', null)
    expect(out.map(i => i.sample)).toEqual(['s2'])
  })
})

describe('computeChartTitle follows the mode', () => {
  it('remove mode (default) says Excluding; keep mode says Only', async () => {
    const { computeChartTitle } = await import('../utils/taxonomy')
    const ids = ['Bacteria;Actinobacteria', 'Bacteria;Bacteroidetes']
    expect(computeChartTitle('Bacteria', ids)).toBe('Bacteria — Excluding Actinobacteria, Bacteroidetes')
    expect(computeChartTitle('Bacteria', ids, 'keep')).toBe('Bacteria — Only Actinobacteria, Bacteroidetes')
    expect(computeChartTitle('Bacteria', [], 'keep')).toBe('Bacteria')
  })
})
