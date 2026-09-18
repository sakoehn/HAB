/**
 * taxonomy-utils.unit.test.ts
 * ===========================
 * Unit tests for utils/taxonomy.ts — the Taxonomy Explorer's client-side
 * "scope root minus exclusions" subtraction logic.
 */

import { describe, it, expect } from 'vitest'

import {
  computeExclusionSeries, computeChartTitle, bareTaxonName, taxonomyDepthFromId, taxonomyDomainFromId,
  isCoveredByAnotherExclusion, filterRedundantExclusions,
} from '../utils/taxonomy'
import { taxonomyRankLabel, expandParentLabel } from '../constants'
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

    const out = computeExclusionSeries(root, ['Bacteria;A'], [excluded], 'X__excl', 'X (minus 1)')

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

    // Siblings, not ancestor/descendant of each other -- neither is redundant.
    const out = computeExclusionSeries(
      root, ['Bacteria;A', 'Bacteria;B'], [excludedA, excludedB], 'X__excl', null,
    )
    expect(out[0].value).toEqual({ egc: 500, norm_egc: 5 })

    const outReversed = computeExclusionSeries(
      root, ['Bacteria;B', 'Bacteria;A'], [excludedB, excludedA], 'X__excl', null,
    )
    expect(outReversed[0].value).toEqual({ egc: 500, norm_egc: 5 })
  })

  it('treats a missing excluded-node sample as contributing 0', () => {
    const root     = [item('s1', 1000, 10), item('s2', 1200, 12)]
    const excluded = [item('s1', 300, 3)] // no entry for s2

    const out = computeExclusionSeries(root, ['Bacteria;A'], [excluded], 'X__excl', null)

    expect(out).toHaveLength(2)
    expect(out[0].value).toEqual({ egc: 700, norm_egc: 7 })
    expect(out[1].value).toEqual({ egc: 1200, norm_egc: 12 }) // unchanged
  })

  it('drops a sample entirely when the root has no data for it', () => {
    const root     = [item('s1', null, null), item('s2', 1200, 12)]
    const excluded = [item('s1', 300, 3), item('s2', 250, 2.5)]

    const out = computeExclusionSeries(root, ['Bacteria;A'], [excluded], 'X__excl', null)

    expect(out).toHaveLength(1)
    expect(out[0].sample).toBe('s2')
  })

  it('is a no-op (identity) when there are zero exclusions', () => {
    const root = [item('s1', 1000, 10), item('s2', 1200, 12)]

    const out = computeExclusionSeries(root, [], [], 'X__excl', null)

    expect(out).toHaveLength(2)
    expect(out[0].value).toEqual({ egc: 1000, norm_egc: 10 })
    expect(out[1].value).toEqual({ egc: 1200, norm_egc: 12 })
  })

  it('passes root norm_egc through as null when root has no norm_egc', () => {
    const root     = [item('s1', 1000, null)]
    const excluded = [item('s1', 300, 3)]

    const out = computeExclusionSeries(root, ['Bacteria;A'], [excluded], 'X__excl', null)

    expect(out[0].value).toEqual({ egc: 700, norm_egc: null })
  })

  // ── W19: descendant of an already-excluded ancestor is not double-subtracted ──

  it('does not double-subtract a descendant of an already-excluded ancestor', () => {
    // Real-world shape: excluding "Bacteria;Proteobacteria" (300) already
    // zeroes out everything under it, including its child
    // "Bacteria;Proteobacteria;Alphaproteobacteria" (120, itself INCLUDED
    // within the 300). Also excluding the child on top must NOT subtract
    // another 120 -- expected result is 1000 - 300 = 700, not 1000-300-120=580.
    const root = [item('s1', 1000, 10)]
    const phylum = [item('s1', 300, 3)]
    const classItem = [item('s1', 120, 1.2)]

    const out = computeExclusionSeries(
      root,
      ['Bacteria;Proteobacteria', 'Bacteria;Proteobacteria;Alphaproteobacteria'],
      [phylum, classItem],
      'X__excl',
      null,
    )
    expect(out[0].value).toEqual({ egc: 700, norm_egc: 7 })
  })

  it('order does not matter: descendant listed before its ancestor is still skipped', () => {
    const root = [item('s1', 1000, 10)]
    const phylum = [item('s1', 300, 3)]
    const classItem = [item('s1', 120, 1.2)]

    const out = computeExclusionSeries(
      root,
      ['Bacteria;Proteobacteria;Alphaproteobacteria', 'Bacteria;Proteobacteria'],
      [classItem, phylum],
      'X__excl',
      null,
    )
    expect(out[0].value).toEqual({ egc: 700, norm_egc: 7 })
  })

  it('a grandchild is also skipped when its grandparent is excluded (not just direct children)', () => {
    const root = [item('s1', 1000, 10)]
    const domain = [item('s1', 500, 5)]
    const genus = [item('s1', 50, 0.5)]

    const out = computeExclusionSeries(
      root,
      ['Bacteria', 'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales'],
      [domain, genus],
      'X__excl',
      null,
    )
    expect(out[0].value).toEqual({ egc: 500, norm_egc: 5 })
  })

  it('a sibling with a similar-looking prefix is NOT treated as a descendant (must match on a full ";" segment boundary)', () => {
    // "Bacteria;Proteobacteria2" starts with the text "Bacteria;Proteobacteria"
    // but is a different, sibling taxon, not a descendant of it.
    const root = [item('s1', 1000, 10)]
    const proteo  = [item('s1', 300, 3)]
    const proteo2 = [item('s1', 200, 2)]

    const out = computeExclusionSeries(
      root,
      ['Bacteria;Proteobacteria', 'Bacteria;Proteobacteria2'],
      [proteo, proteo2],
      'X__excl',
      null,
    )
    // Both are real, independent exclusions -- 1000 - 300 - 200 = 500.
    expect(out[0].value).toEqual({ egc: 500, norm_egc: 5 })
  })
})

describe('isCoveredByAnotherExclusion', () => {
  it('true when id is a descendant of another id in the set', () => {
    expect(isCoveredByAnotherExclusion(
      'Bacteria;Proteobacteria;Alphaproteobacteria',
      ['Bacteria;Proteobacteria'],
    )).toBe(true)
  })

  it('false when id is not a descendant of anything in the set', () => {
    expect(isCoveredByAnotherExclusion('Bacteria;Proteobacteria', ['Bacteria;Firmicutes'])).toBe(false)
  })

  it('false for the id itself (not its own descendant)', () => {
    expect(isCoveredByAnotherExclusion('Bacteria;Proteobacteria', ['Bacteria;Proteobacteria'])).toBe(false)
  })

  it('false for a similar-looking sibling prefix (segment-boundary check)', () => {
    expect(isCoveredByAnotherExclusion('Bacteria;Proteobacteria2', ['Bacteria;Proteobacteria'])).toBe(false)
  })

  it('true for a grandchild, not just a direct child', () => {
    expect(isCoveredByAnotherExclusion(
      'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales',
      ['Bacteria'],
    )).toBe(true)
  })

  it('empty set: always false', () => {
    expect(isCoveredByAnotherExclusion('Bacteria;Proteobacteria', [])).toBe(false)
  })
})

describe('filterRedundantExclusions', () => {
  it('removes a descendant when its ancestor is also in the list', () => {
    const result = filterRedundantExclusions([
      'Bacteria;Proteobacteria',
      'Bacteria;Proteobacteria;Alphaproteobacteria',
    ])
    expect(result).toEqual(['Bacteria;Proteobacteria'])
  })

  it('keeps siblings, neither is a descendant of the other', () => {
    const result = filterRedundantExclusions(['Bacteria;Proteobacteria', 'Bacteria;Firmicutes'])
    expect(result).toEqual(['Bacteria;Proteobacteria', 'Bacteria;Firmicutes'])
  })

  it('keeps just the top ancestor out of a 3-level chain', () => {
    const result = filterRedundantExclusions([
      'Bacteria',
      'Bacteria;Proteobacteria',
      'Bacteria;Proteobacteria;Alphaproteobacteria',
    ])
    expect(result).toEqual(['Bacteria'])
  })

  it('empty input: returns []', () => {
    expect(filterRedundantExclusions([])).toEqual([])
  })

  it('does not mutate the input array', () => {
    const input = ['Bacteria;Proteobacteria', 'Bacteria;Proteobacteria;Alphaproteobacteria']
    const original = [...input]
    filterRedundantExclusions(input)
    expect(input).toEqual(original)
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

describe('taxonomyDomainFromId', () => {
  it('a domain-level id returns itself', () => {
    expect(taxonomyDomainFromId('Bacteria')).toBe('Bacteria')
  })

  it('domain is always the lineage-prefix\'s first segment, regardless of depth', () => {
    expect(taxonomyDomainFromId('Bacteria;Proteobacteria;Alphaproteobacteria')).toBe('Bacteria')
    expect(taxonomyDomainFromId('Eukaryota;Metazoa;Chordata;Mammalia')).toBe('Eukaryota')
  })

  it('matches the real Bosea cross-lineage homonym: same domain despite different deeper lineages', () => {
    expect(taxonomyDomainFromId(
      'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Bradyrhizobiaceae;Bosea',
    )).toBe('Bacteria')
    expect(taxonomyDomainFromId(
      'Bacteria;Proteobacteria;Alphaproteobacteria;Hyphomicrobiales;Boseaceae;Bosea',
    )).toBe('Bacteria')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// taxonomyRankLabel (W7) -- Eukaryota lineages carry extra NCBI ranks that
// don't fit the fixed 8-level ladder (Domain..Strain), so a depth number
// alone is ambiguous: depth 3 means "Class" for Bacteria but something else
// for Eukaryota. The domain must be passed in to disambiguate.
// ─────────────────────────────────────────────────────────────────────────────

describe('taxonomyRankLabel', () => {
  it('null depth: "Unknown rank" regardless of domain', () => {
    expect(taxonomyRankLabel(null)).toBe('Unknown rank')
    expect(taxonomyRankLabel(null, 'Eukaryota')).toBe('Unknown rank')
  })

  it('no domain passed: falls back to the fixed ladder (backwards-compatible default)', () => {
    expect(taxonomyRankLabel(1)).toBe('Domain')
    expect(taxonomyRankLabel(3)).toBe('Class')
  })

  it('Bacteria/Archaea/Viruses: uses the fixed ladder', () => {
    expect(taxonomyRankLabel(1, 'Bacteria')).toBe('Domain')
    expect(taxonomyRankLabel(2, 'Bacteria')).toBe('Phylum')
    expect(taxonomyRankLabel(6, 'Archaea')).toBe('Genus')
    expect(taxonomyRankLabel(8, 'Viruses')).toBe('Strain')
  })

  it('Eukaryota: always falls back to "Level N", never the ladder (the actual W7 bug)', () => {
    expect(taxonomyRankLabel(3, 'Eukaryota')).toBe('Level 3')
    expect(taxonomyRankLabel(6, 'Eukaryota')).toBe('Level 6')
    expect(taxonomyRankLabel(1, 'Eukaryota')).toBe('Level 1')
  })

  it('depth beyond the ladder (9+): "Level N" regardless of domain', () => {
    expect(taxonomyRankLabel(9, 'Bacteria')).toBe('Level 9')
    expect(taxonomyRankLabel(9, 'Eukaryota')).toBe('Level 9')
  })

  it('real usage pattern: taxonomyRankLabel(depth, taxonomyDomainFromId(annotationId))', () => {
    const bacteriaId  = 'Bacteria;Proteobacteria;Alphaproteobacteria'
    const eukaryotaId = 'Eukaryota;Metazoa;Chordata'
    expect(taxonomyRankLabel(
      taxonomyDepthFromId(bacteriaId), taxonomyDomainFromId(bacteriaId),
    )).toBe('Class')
    expect(taxonomyRankLabel(
      taxonomyDepthFromId(eukaryotaId), taxonomyDomainFromId(eukaryotaId),
    )).toBe('Level 3')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// expandParentLabel — taxonomy branch (W7): same ladder-vs-Eukaryota bug as
// taxonomyRankLabel, found incidentally while fixing it (same file, same
// root cause: TAXONOMY_RANK_NAMES[segments.length] with no domain check).
// ─────────────────────────────────────────────────────────────────────────────

describe('expandParentLabel — taxonomy Eukaryota regression (W7)', () => {
  it('Bacteria ancestor still gets its rank suffix', () => {
    expect(expandParentLabel('Bacteria;Proteobacteria;Alphaproteobacteria', 'taxonomy'))
      .toBe('Alphaproteobacteria (Class)')
  })

  it('Eukaryota ancestor at the same depth gets no rank suffix, not a wrong one', () => {
    const result = expandParentLabel('Eukaryota;Metazoa;Chordata', 'taxonomy')
    expect(result).toBe('Chordata')
    expect(result).not.toContain('Class')
  })

  it('Eukaryota domain-level id: bare name, no "(Domain)" suffix', () => {
    expect(expandParentLabel('Eukaryota', 'taxonomy')).toBe('Eukaryota')
  })
})
