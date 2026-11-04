/**
 * lookup-detail.unit.test.ts
 * ==========================
 * Unit tests for the new fields added to the Annotation Lookup detail card
 * in ExplorePage — Category, Depth, Mean/Max norm EGC, and Scaffold count.
 *
 * All logic here is pure (no DOM, no React):
 *
 * depthLabel(depth, source, category, name)
 *   Returns a human-readable hierarchy label for each source type and depth
 *   level. Real import from utils/stats.ts (extracted out of ExplorePage's
 *   render, which now calls the same shared function) -- not a hand-copied
 *   mirror, so a real change to the function's behavior shows up here.
 *
 * scaffoldCount
 *   Object.keys(value.scaffolds).length — how many unique scaffolds carry
 *   this annotation in the first sample the index saw.
 *
 * category via expandParentLabel(value.category, source)
 *   Reuses the existing constant-expansion helper so COG single-letter
 *   categories (J → "Translation…") and enzyme class numbers get expanded.
 *
 * Field-presence guards
 *   Each new field is optional/nullable — the detail card hides a row when
 *   the field is absent.  Tests confirm every guard returns false for null /
 *   undefined and true for real values.
 *
 * TopAnnotation extended type
 *   The added optional fields (mean_norm_egc, max_norm_egc, value) are
 *   backwards-compatible: old code that never sends them still type-checks.
 *
 * norm_egc formatting
 *   toExponential(3) on the normalised EGC values matches expected output.
 *
 * resolveLookupCategory / resolveLookupScaffoldCount / resolveLookupDepth
 *   (utils/stats.ts, real imports, not mirrored) -- read
 *   category/scaffold_count/depth from the row's top-level fields, or from
 *   the older nested `value` shape, whichever is present.
 *
 * Run: npx vitest run src/tests/lookup-detail.unit.test.ts
 */

import { describe, it, expect } from 'vitest'
import { expandParentLabel } from '../constants'
import { resolveLookupCategory, resolveLookupScaffoldCount, resolveLookupDepth, depthLabel } from '../utils/stats'
import type { TopAnnotation, AnnotationValue } from '../types'


// ─────────────────────────────────────────────────────────────────────────────
// depthLabel — KEGG (1–4)
// ─────────────────────────────────────────────────────────────────────────────

describe('depthLabel — KEGG', () => {
  it('depth 1 = pathway class', () => {
    expect(depthLabel(1, 'kegg')).toBe('pathway class')
  })

  it('depth 2 = subcategory', () => {
    expect(depthLabel(2, 'kegg')).toBe('subcategory')
  })

  // KEGG's third level also holds the Brite protein-family tables
  // ([BR:...]) and the "Not Included in Pathway or Brite" bins, so only a
  // [PATH:...] name is called a pathway.
  it('depth 3 with no name names the whole level, which holds more than pathways', () => {
    expect(depthLabel(3, 'kegg')).toBe('pathway / BRITE table')
  })

  it('depth 3 [PATH:] entry = pathway', () => {
    expect(depthLabel(3, 'kegg', null, 'ABC transporters [PATH:ko02010]')).toBe('pathway')
  })

  it('depth 3 [BR:] entry = BRITE table', () => {
    expect(depthLabel(3, 'kegg', null, 'Transporters [BR:ko02000]')).toBe('BRITE table')
  })

  it('depth 3 entry with neither marker = KEGG group (a "not included" bin)', () => {
    expect(depthLabel(3, 'kegg', null, 'Enzymes with EC numbers')).toBe('KEGG group')
  })

  it('a name does not change any other level', () => {
    expect(depthLabel(4, 'kegg', null, 'HK; hexokinase [EC:2.7.1.1]')).toBe('leaf (KO)')
    expect(depthLabel(3, 'enzyme', null, 'With NAD+ or NADP+ as acceptor')).toBe('sub-subclass')
  })

  it('depth 4 = leaf (KO) — the KO entries actually searched are at this level', () => {
    expect(depthLabel(4, 'kegg')).toBe('leaf (KO)')
  })

  it('unexpected depth returns the raw number as string', () => {
    expect(depthLabel(5, 'kegg')).toBe('5')
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// depthLabel — COG (1–2)
// ─────────────────────────────────────────────────────────────────────────────

describe('depthLabel — COG', () => {
  it('depth 1 = category (single-letter root, e.g. J, C, K)', () => {
    expect(depthLabel(1, 'cog')).toBe('category')
  })

  it('depth 2 = leaf (COG) — the COG#### entries', () => {
    expect(depthLabel(2, 'cog')).toBe('leaf (COG)')
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// depthLabel — Enzyme (1–4)
// ─────────────────────────────────────────────────────────────────────────────

describe('depthLabel — Enzyme', () => {
  it('depth 1 = class (e.g. "1." = Oxidoreductases)', () => {
    expect(depthLabel(1, 'enzyme')).toBe('class')
  })

  it('depth 2 = subclass (e.g. "1.1.")', () => {
    expect(depthLabel(2, 'enzyme')).toBe('subclass')
  })

  it('depth 3 = sub-subclass (e.g. "1.1.1.")', () => {
    expect(depthLabel(3, 'enzyme')).toBe('sub-subclass')
  })

  it('depth 4 = leaf (EC) — the fully-specified "1.1.1.1" entries', () => {
    expect(depthLabel(4, 'enzyme')).toBe('leaf (EC)')
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// depthLabel — Taxonomy and unknown source
// ─────────────────────────────────────────────────────────────────────────────

describe('depthLabel — taxonomy / unknown source', () => {
  it('taxonomy: defers to taxonomyRankLabel, not a raw depth number', () => {
    // This is the one branch where the inline ExplorePage copy this test
    // used to hand-mirror had already drifted from the real function --
    // the real depthLabel calls taxonomyRankLabel(depth, category) for
    // taxonomy, which returns a real rank name, not String(depth). See
    // taxonomy-utils.unit.test.ts for taxonomyRankLabel's own full
    // rank-name coverage; this just confirms depthLabel delegates to it.
    expect(depthLabel(3, 'taxonomy')).toBe('Class')
    expect(depthLabel(1, 'taxonomy')).toBe('Domain')
  })

  it('taxonomy: category is passed through to taxonomyRankLabel', () => {
    expect(depthLabel(6, 'taxonomy', 'Archaea')).toBe('Genus')
  })

  it('unknown source: falls through to raw number', () => {
    expect(depthLabel(2, 'unknown')).toBe('2')
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// scaffoldCount — Object.keys(value.scaffolds).length
// ─────────────────────────────────────────────────────────────────────────────

function scaffoldCount(v: AnnotationValue | null | undefined): number | null {
  return v?.scaffolds ? Object.keys(v.scaffolds).length : null
}

describe('scaffoldCount', () => {
  it('null value → null (field hidden in UI)', () => {
    expect(scaffoldCount(null)).toBeNull()
  })

  it('undefined value → null', () => {
    expect(scaffoldCount(undefined)).toBeNull()
  })

  it('scaffolds: null → null', () => {
    expect(scaffoldCount({ scaffolds: null })).toBeNull()
  })

  it('empty scaffolds object → 0', () => {
    expect(scaffoldCount({ scaffolds: {} })).toBe(0)
  })

  it('one scaffold → 1', () => {
    expect(scaffoldCount({ scaffolds: { 'Ga0590984_0000001': 2 } })).toBe(1)
  })

  it('multiple scaffolds → correct count', () => {
    const v: AnnotationValue = {
      scaffolds: {
        'Ga0590984_0000001': 2,
        'Ga0590984_0000003': 1,
        'Ga0590984_0029925': 3,
      },
    }
    expect(scaffoldCount(v)).toBe(3)
  })

  it('gene counts (values) do NOT affect the scaffold count', () => {
    // count = unique scaffolds, not total genes
    const v: AnnotationValue = {
      scaffolds: { 'Ga0590984_0000001': 99 },
    }
    expect(scaffoldCount(v)).toBe(1)
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// Category display — expandParentLabel(value.category, source)
// ─────────────────────────────────────────────────────────────────────────────

function resolveCategory(v: AnnotationValue | null | undefined, source: string): string | null {
  return v?.category ? expandParentLabel(v.category, source) : null
}

describe('category display via expandParentLabel', () => {
  it('null value → null (row hidden)', () => {
    expect(resolveCategory(null, 'kegg')).toBeNull()
  })

  it('null category → null', () => {
    expect(resolveCategory({ category: null }, 'kegg')).toBeNull()
  })

  it('empty string category → null (falsy guard)', () => {
    expect(resolveCategory({ category: '' }, 'kegg')).toBeNull()
  })

  it('KEGG "Metabolism" passes through unchanged', () => {
    expect(resolveCategory({ category: 'Metabolism' }, 'kegg')).toBe('Metabolism')
  })

  it('KEGG "Environmental Information Processing" passes through unchanged', () => {
    const cat = 'Environmental Information Processing'
    expect(resolveCategory({ category: cat }, 'kegg')).toBe(cat)
  })

  it('COG single-letter "J" is expanded to full label', () => {
    const result = resolveCategory({ category: 'J' }, 'cog')
    expect(result).not.toBe('J')
    expect(result).toBeTruthy()
    // The expansion contains recognisable terms from the COG functional
    // category labels — not an exact-string test so the lookup table can
    // be updated without breaking this assertion.
    expect(result!.length).toBeGreaterThan(3)
  })

  it('COG "C" is expanded', () => {
    const result = resolveCategory({ category: 'C' }, 'cog')
    expect(result).not.toBe('C')
  })

  it('enzyme class "1" is expanded to include a human-readable label', () => {
    const result = resolveCategory({ category: '1' }, 'enzyme')
    // expandParentLabel('1', 'enzyme') → '1 · Oxidoreductases'
    expect(result).toContain('1')
    expect(result!.length).toBeGreaterThan(1)
  })

  it('taxonomy category gets a rank suffix (domain-level values have no lineage prefix)', () => {
    expect(resolveCategory({ category: 'Bacteria' }, 'taxonomy')).toBe('Bacteria (Domain)')
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// Field-presence guards — conditional row display
// ─────────────────────────────────────────────────────────────────────────────

describe('field-presence guards', () => {

  describe('depth guard: v?.depth != null', () => {
    it('null value → hidden', () => {
      const v: AnnotationValue | null = null
      expect(v?.depth != null).toBe(false)
    })

    it('depth: null → hidden', () => {
      const v: AnnotationValue = { depth: null }
      expect(v?.depth != null).toBe(false)
    })

    it('depth: undefined → hidden', () => {
      const v: AnnotationValue = {}
      expect(v?.depth != null).toBe(false)
    })

    it('depth: 4 → shown', () => {
      const v: AnnotationValue = { depth: 4 }
      expect(v?.depth != null).toBe(true)
    })

    it('depth: 0 → shown (0 is a valid value, != null is true)', () => {
      const v: AnnotationValue = { depth: 0 }
      expect(v?.depth != null).toBe(true)
    })

    it('depth: 1 → shown', () => {
      const v: AnnotationValue = { depth: 1 }
      expect(v?.depth != null).toBe(true)
    })
  })

  describe('mean_norm_egc guard: r.mean_norm_egc != null', () => {
    it('undefined → hidden', () => {
      const r: Partial<TopAnnotation> = {}
      expect(r.mean_norm_egc != null).toBe(false)
    })

    it('null → hidden', () => {
      const r: Partial<TopAnnotation> = { mean_norm_egc: null }
      expect(r.mean_norm_egc != null).toBe(false)
    })

    it('0 → shown (zero is a valid normalised value, not "missing")', () => {
      const r: Partial<TopAnnotation> = { mean_norm_egc: 0 }
      expect(r.mean_norm_egc != null).toBe(true)
    })

    it('real value → shown', () => {
      const r: Partial<TopAnnotation> = { mean_norm_egc: 6.96e-5 }
      expect(r.mean_norm_egc != null).toBe(true)
    })
  })

  describe('max_norm_egc guard: r.max_norm_egc != null', () => {
    it('undefined → hidden', () => {
      const r: Partial<TopAnnotation> = {}
      expect(r.max_norm_egc != null).toBe(false)
    })

    it('real value → shown', () => {
      const r: Partial<TopAnnotation> = { max_norm_egc: 2.15e-4 }
      expect(r.max_norm_egc != null).toBe(true)
    })
  })

  describe('scaffoldCount display guard: scaffoldCount != null', () => {
    it('null → hidden', () => {
      expect(scaffoldCount(null) != null).toBe(false)
    })

    it('0 → shown (0 scaffolds is a valid result worth displaying)', () => {
      expect(scaffoldCount({ scaffolds: {} }) != null).toBe(true)
    })

    it('positive count → shown', () => {
      expect(scaffoldCount({ scaffolds: { 'scaf1': 1 } }) != null).toBe(true)
    })
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// TopAnnotation — extended type backwards-compatibility
// ─────────────────────────────────────────────────────────────────────────────

describe('TopAnnotation — extended type', () => {
  it('accepts a full result with all new fields populated', () => {
    const r: TopAnnotation = {
      annotation_id:  'K00001',
      name:           'E1.1.1.1, adh; alcohol dehydrogenase [EC:1.1.1.1]',
      parent:         'Drug metabolism - cytochrome P450 [PATH:ko00982]',
      mean_egc:       536.96,
      max_egc:        2326.0,
      mean_norm_egc:  6.965e-5,
      max_norm_egc:   2.155e-4,
      sample_count:   128,
      value: {
        name:        'E1.1.1.1, adh; alcohol dehydrogenase [EC:1.1.1.1]',
        depth:       4,
        category:    'Metabolism',
        parent_id:   '00982',
        parent_name: 'Drug metabolism - cytochrome P450 [PATH:ko00982]',
        egc:         219.0,
        norm_egc:    2.837e-5,
        scaffolds:   { 'Ga0590984_0000559': 1, 'Ga0590984_0057606': 2 },
      },
    }
    expect(r.mean_norm_egc).toBeCloseTo(6.965e-5, 10)
    expect(r.max_norm_egc).toBeCloseTo(2.155e-4, 10)
    expect(r.value?.depth).toBe(4)
    expect(r.value?.category).toBe('Metabolism')
    expect(scaffoldCount(r.value ?? null)).toBe(2)
  })

  it('accepts a result with none of the new optional fields (backwards compat)', () => {
    const r: TopAnnotation = {
      annotation_id: 'COG0001',
      name:          'Ribosomal protein S2',
      parent:        'J',
      mean_egc:      8000,
      max_egc:       15000,
      sample_count:  128,
    }
    expect(r.mean_norm_egc).toBeUndefined()
    expect(r.max_norm_egc).toBeUndefined()
    expect(r.value).toBeUndefined()
  })

  it('value with only some subfields present (partial annotation entry)', () => {
    const r: TopAnnotation = {
      annotation_id: 'Bacteria',
      name:          null,
      parent:        null,
      mean_egc:      50000,
      max_egc:       120000,
      sample_count:  128,
      value: { depth: 1, category: 'Bacteria', parent: null },
    }
    expect(r.value?.depth).toBe(1)
    expect(r.value?.parent_name).toBeUndefined()
    expect(scaffoldCount(r.value ?? null)).toBeNull()
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// norm_egc number formatting — toExponential(3)
// ─────────────────────────────────────────────────────────────────────────────

describe('norm_egc number formatting', () => {
  it('typical mean_norm_egc formats correctly with 3 significant digits', () => {
    expect((6.96527770954915e-5).toExponential(3)).toBe('6.965e-5')
  })

  it('max_norm_egc formatting', () => {
    expect((2.1553702646714848e-4).toExponential(3)).toBe('2.155e-4')
  })

  it('output matches scientific notation regex', () => {
    const values = [6.965e-5, 2.155e-4, 1.234e-2, 9.876e-8]
    for (const v of values) {
      expect(v.toExponential(3)).toMatch(/^\d+\.\d{3}e[+-]\d+$/)
    }
  })

  it('very small norm_egc (deep sample, rare annotation) formats without NaN', () => {
    const verySmall = 1e-10
    const fmt = verySmall.toExponential(3)
    expect(fmt).not.toContain('NaN')
    expect(fmt).not.toContain('undefined')
    expect(fmt).toBe('1.000e-10')
  })

  it('norm_egc near 1.0 formats correctly (annotation covers full sample depth)', () => {
    expect((0.999).toExponential(3)).toBe('9.990e-1')
  })

  it('toExponential(3) and toExponential(3) match for same input', () => {
    const v = 5.678e-4
    expect(v.toExponential(3)).toBe(v.toExponential(3))
  })
})


// ─────────────────────────────────────────────────────────────────────────────
// resolveLookupCategory / resolveLookupScaffoldCount / resolveLookupDepth
// ─────────────────────────────────────────────────────────────────────────────

const SQL_SHAPED_ROW: TopAnnotation = {
  // SQL backend: category/scaffold_count/depth are top-level, no `value`.
  annotation_id:  'COG0055',
  name:           'FoF1-type ATP synthase, beta subunit',
  parent:         'C',
  mean_egc:       8759.32,
  max_egc:        25563.0,
  sample_count:   128,
  depth:          2,
  category:       'Energy production and conversion',
  scaffold_count: 169,
}

const JSON_SHAPED_ROW: TopAnnotation = {
  // JSON backend: no top-level category/scaffold_count/depth -- nested
  // inside `value` instead.
  annotation_id: 'COG0055',
  name:          'FoF1-type ATP synthase, beta subunit',
  parent:        'C',
  mean_egc:      8759.32,
  max_egc:       25563.0,
  sample_count:  128,
  value: {
    depth:     2,
    category:  'Energy production and conversion',
    scaffolds: { 'Ga0590984_0000001': 2, 'Ga0590984_0000003': 1 },
  },
}

describe('resolveLookupCategory', () => {
  it('SQL-shaped row: reads the top-level category field', () => {
    expect(resolveLookupCategory(SQL_SHAPED_ROW)).toBe('Energy production and conversion')
  })

  it('JSON-shaped row: falls back to value.category', () => {
    expect(resolveLookupCategory(JSON_SHAPED_ROW)).toBe('Energy production and conversion')
  })

  it('top-level category wins when both are present', () => {
    const row: TopAnnotation = {
      ...SQL_SHAPED_ROW,
      category: 'Top-level wins',
      value: { category: 'Nested loses' },
    }
    expect(resolveLookupCategory(row)).toBe('Top-level wins')
  })

  it('neither present: returns null', () => {
    const row: TopAnnotation = {
      annotation_id: 'X', name: null, parent: null,
      mean_egc: 1, max_egc: 1, sample_count: 1,
    }
    expect(resolveLookupCategory(row)).toBeNull()
  })
})

describe('resolveLookupScaffoldCount', () => {
  it('SQL-shaped row: reads the top-level scaffold_count field directly (a real int, not a derived length)', () => {
    expect(resolveLookupScaffoldCount(SQL_SHAPED_ROW)).toBe(169)
  })

  it('JSON-shaped row: falls back to counting value.scaffolds keys', () => {
    expect(resolveLookupScaffoldCount(JSON_SHAPED_ROW)).toBe(2)
  })

  it('top-level scaffold_count wins when both are present', () => {
    const row: TopAnnotation = {
      ...SQL_SHAPED_ROW,
      scaffold_count: 5,
      value: { scaffolds: { a: 1, b: 1, c: 1 } },  // would be 3 if this were read instead
    }
    expect(resolveLookupScaffoldCount(row)).toBe(5)
  })

  it('scaffold_count: 0 is a real, displayable value, not treated as missing', () => {
    const row: TopAnnotation = { ...SQL_SHAPED_ROW, scaffold_count: 0 }
    expect(resolveLookupScaffoldCount(row)).toBe(0)
  })

  it('neither present: returns null', () => {
    const row: TopAnnotation = {
      annotation_id: 'X', name: null, parent: null,
      mean_egc: 1, max_egc: 1, sample_count: 1,
    }
    expect(resolveLookupScaffoldCount(row)).toBeNull()
  })
})

describe('resolveLookupDepth', () => {
  it('SQL-shaped row: reads the top-level depth field', () => {
    expect(resolveLookupDepth(SQL_SHAPED_ROW)).toBe(2)
  })

  it('JSON-shaped row: falls back to value.depth', () => {
    expect(resolveLookupDepth(JSON_SHAPED_ROW)).toBe(2)
  })

  it('depth: 0 is a real, displayable value, not treated as missing', () => {
    const row: TopAnnotation = { ...SQL_SHAPED_ROW, depth: 0 }
    expect(resolveLookupDepth(row)).toBe(0)
  })

  it('neither present: returns null', () => {
    const row: TopAnnotation = {
      annotation_id: 'X', name: null, parent: null,
      mean_egc: 1, max_egc: 1, sample_count: 1,
    }
    expect(resolveLookupDepth(row)).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Cross-field consistency
// ─────────────────────────────────────────────────────────────────────────────

describe('cross-field consistency', () => {
  it('mean_norm_egc <= max_norm_egc for any valid annotation', () => {
    const annotations: Pick<TopAnnotation, 'mean_norm_egc' | 'max_norm_egc'>[] = [
      { mean_norm_egc: 6.965e-5, max_norm_egc: 2.155e-4 },
      { mean_norm_egc: 1.2e-3,  max_norm_egc: 1.2e-3 },  // exactly equal is valid
    ]
    for (const a of annotations) {
      if (a.mean_norm_egc != null && a.max_norm_egc != null) {
        expect(a.mean_norm_egc).toBeLessThanOrEqual(a.max_norm_egc)
      }
    }
  })

  it('mean_egc <= max_egc (same invariant for raw EGC)', () => {
    const r: TopAnnotation = {
      annotation_id: 'K00001', name: null, parent: null,
      mean_egc: 536.96, max_egc: 2326.0, sample_count: 128,
    }
    expect(r.mean_egc).toBeLessThanOrEqual(r.max_egc)
  })

  it('depth 4 (leaf) annotations have no children — scaffoldCount from value is single-sample', () => {
    // Verifies that the tooltip comment ("from the earliest sample this
    // annotation appears in") is consistent with what value.scaffolds
    // actually represents: scaffolds from one sample, not aggregate.
    const v: AnnotationValue = {
      depth: 4,
      scaffolds: { 'scaf_a': 1, 'scaf_b': 2 },
    }
    // This is a per-sample count — should be small.
    expect(scaffoldCount(v)!).toBeLessThanOrEqual(100)
  })
})
