/**
 * taxonomy-utils.unit.test.ts
 * ===========================
 * Unit tests for utils/taxonomy.ts — the Taxonomy Explorer's client-side
 * "scope root minus exclusions" subtraction logic.
 */

import { describe, it, expect } from 'vitest'

import { computeExclusionSeries, computeChartTitle, bareTaxonName, taxonomyDepthFromId } from '../utils/taxonomy'
import type { AnnotationItem } from '../types'

function item(sample: string, egc: number | null, normEgc: number | null = null): AnnotationItem {
  return {
    source:        'taxonomy',
    sample,
    timepoint:     null,
    annotation_id: 'X',
    name:          null,
    value:         { egc, norm_egc: normEgc },
  }
}

describe('computeExclusionSeries', () => {
  it('subtracts a single exclusion per matching sample', () => {
    const root      = [item('s1', 1000, 10), item('s2', 1200, 12)]
    const excluded  = [item('s1', 300, 3), item('s2', 250, 2.5)]

    const out = computeExclusionSeries(root, [excluded], 'X__excl', 'X (minus 1)')

    expect(out).toHaveLength(2)
    expect(out[0].annotation_id).toBe('X__excl')
    expect(out[0].name).toBe('X (minus 1)')
    expect(out[0].value).toEqual({ egc: 700, norm_egc: 7 })
    expect(out[1].value).toEqual({ egc: 950, norm_egc: 9.5 })
  })

  it('subtracts multiple exclusions, order-independent', () => {
    const root = [item('s1', 1000, 10)]
    const excludedA = [item('s1', 300, 3)]
    const excludedB = [item('s1', 200, 2)]

    const out = computeExclusionSeries(root, [excludedA, excludedB], 'X__excl', null)
    expect(out[0].value).toEqual({ egc: 500, norm_egc: 5 })

    const outReversed = computeExclusionSeries(root, [excludedB, excludedA], 'X__excl', null)
    expect(outReversed[0].value).toEqual({ egc: 500, norm_egc: 5 })
  })

  it('treats a missing excluded-node sample as contributing 0', () => {
    const root     = [item('s1', 1000, 10), item('s2', 1200, 12)]
    const excluded = [item('s1', 300, 3)] // no entry for s2

    const out = computeExclusionSeries(root, [excluded], 'X__excl', null)

    expect(out).toHaveLength(2)
    expect(out[0].value).toEqual({ egc: 700, norm_egc: 7 })
    expect(out[1].value).toEqual({ egc: 1200, norm_egc: 12 }) // unchanged
  })

  it('drops a sample entirely when the root has no data for it', () => {
    const root     = [item('s1', null, null), item('s2', 1200, 12)]
    const excluded = [item('s1', 300, 3), item('s2', 250, 2.5)]

    const out = computeExclusionSeries(root, [excluded], 'X__excl', null)

    expect(out).toHaveLength(1)
    expect(out[0].sample).toBe('s2')
  })

  it('is a no-op (identity) when there are zero exclusions', () => {
    const root = [item('s1', 1000, 10), item('s2', 1200, 12)]

    const out = computeExclusionSeries(root, [], 'X__excl', null)

    expect(out).toHaveLength(2)
    expect(out[0].value).toEqual({ egc: 1000, norm_egc: 10 })
    expect(out[1].value).toEqual({ egc: 1200, norm_egc: 12 })
  })

  it('passes root norm_egc through as null when root has no norm_egc', () => {
    const root     = [item('s1', 1000, null)]
    const excluded = [item('s1', 300, 3)]

    const out = computeExclusionSeries(root, [excluded], 'X__excl', null)

    expect(out[0].value).toEqual({ egc: 700, norm_egc: null })
  })
})

describe('computeChartTitle', () => {
  it('is just the root name when there are no exclusions', () => {
    expect(computeChartTitle('Bacteria', [])).toBe('Bacteria')
  })

  it('lists a single excluded branch', () => {
    expect(computeChartTitle('Bacteria', ['Proteobacteria']))
      .toBe('Bacteria — Excluding Proteobacteria')
  })

  it('lists multiple excluded branches, comma-separated', () => {
    expect(computeChartTitle('Bacteria', ['Proteobacteria', 'Firmicutes']))
      .toBe('Bacteria — Excluding Proteobacteria, Firmicutes')
  })

  it('preserves exclusion order as given', () => {
    expect(computeChartTitle('Bacteria', ['Firmicutes', 'Proteobacteria']))
      .toBe('Bacteria — Excluding Firmicutes, Proteobacteria')
  })
})

describe('bareTaxonName', () => {
  it('returns a domain-level id unchanged (no semicolons)', () => {
    expect(bareTaxonName('Bacteria')).toBe('Bacteria')
  })

  it('returns the last segment of a multi-segment lineage-prefix', () => {
    expect(bareTaxonName('Bacteria;Proteobacteria;Alphaproteobacteria')).toBe('Alphaproteobacteria')
  })
})

describe('taxonomyDepthFromId', () => {
  it('a domain-level id has depth 1', () => {
    expect(taxonomyDepthFromId('Bacteria')).toBe(1)
  })

  it('depth equals the segment count of the lineage-prefix', () => {
    expect(taxonomyDepthFromId('Bacteria;Proteobacteria')).toBe(2)
    expect(taxonomyDepthFromId('Bacteria;Proteobacteria;Alphaproteobacteria')).toBe(3)
  })

  it('matches the real Bosea cross-lineage homonym at genus depth (6)', () => {
    // Same real, verified homonym used throughout the SQL test suite
    // (see tests/sql/test_cache_sql.py) — both lineages are genus-level.
    expect(taxonomyDepthFromId(
      'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Bradyrhizobiaceae;Bosea',
    )).toBe(6)
    expect(taxonomyDepthFromId(
      'Bacteria;Proteobacteria;Alphaproteobacteria;Hyphomicrobiales;Boseaceae;Bosea',
    )).toBe(6)
  })
})
