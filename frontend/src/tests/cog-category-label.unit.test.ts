/**
 * cog-category-label.unit.test.ts
 * =================================
 * primaryLabelWithCogCategory (constants.ts): wherever an annotation is shown
 * by its ID alone with no name beside it (Compare chips, chart legends, group
 * member lists), a bare COG category letter ("E") must also carry its full
 * category name. Every other ID is unchanged (delegates to
 * taxonomyAwarePrimaryLabel).
 *
 * Run: npx vitest run src/tests/cog-category-label.unit.test.ts
 */
import { describe, it, expect } from 'vitest'
import { primaryLabelWithCogCategory, taxonomyAwarePrimaryLabel, COG_CATEGORY_LABELS } from '../constants'

describe('primaryLabelWithCogCategory', () => {
  it('a COG category letter gets its full name', () => {
    expect(primaryLabelWithCogCategory('cog', 'E', 'Amino acid transport and metabolism'))
      .toBe('E · Amino acid transport and metabolism')
  })

  it('works even when no name was plumbed through', () => {
    expect(primaryLabelWithCogCategory('cog', 'C', null)).toBe('C · Energy production and conversion')
  })

  it('every one of the 25 real category letters is covered', () => {
    for (const letter of 'ABCDEFGHIJKLMNOPQRSTUVWXZ') {
      expect(primaryLabelWithCogCategory('cog', letter, null)).toBe(`${letter} · ${COG_CATEGORY_LABELS[letter]}`)
    }
  })

  it('a COG gene id is unchanged', () => {
    expect(primaryLabelWithCogCategory('cog', 'COG0055', 'FoF1-type ATP synthase')).toBe('COG0055')
  })

  it('a single letter from another source is unchanged', () => {
    expect(primaryLabelWithCogCategory('kegg', 'E', null)).toBe('E')
    expect(primaryLabelWithCogCategory('enzyme', '3', 'Hydrolases')).toBe('3')
  })

  it('taxonomy still uses the taxonomy-aware label', () => {
    expect(primaryLabelWithCogCategory('taxonomy', 'Bacteria;Bacteroidetes', 'Bacteroidetes'))
      .toBe(taxonomyAwarePrimaryLabel('taxonomy', 'Bacteria;Bacteroidetes', 'Bacteroidetes'))
  })
})
