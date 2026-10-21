/**
 * homonym-hints.unit.test.ts
 * ===========================
 * homonymHints (utils/taxonomy.ts): within one on-screen list, taxa that
 * share a name get the closest ancestor that tells them apart. The
 * immediate parent alone often doesn't -- most same-named, same-rank pairs
 * in this dataset share it and differ only further up.
 */

import { describe, it, expect } from 'vitest'

import { homonymHints, withHomonymHint } from '../utils/taxonomy'

const BOSEA_1 = 'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Bradyrhizobiaceae;Bosea'
const BOSEA_2 = 'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Boseaceae;Bosea'
// Same immediate parent, different grandparent.
const X_1 = 'Bacteria;PhylumA;unclassified;X'
const X_2 = 'Bacteria;PhylumB;unclassified;X'

describe('homonymHints', () => {
  it('gives nothing to names that appear once in the list', () => {
    const hints = homonymHints([BOSEA_1, 'Bacteria;Proteobacteria', 'K00001'])
    expect(hints.size).toBe(0)
  })

  it('uses the immediate parent when that already differs', () => {
    const hints = homonymHints([BOSEA_1, BOSEA_2])
    expect(hints.get(BOSEA_1)).toBe('Bradyrhizobiaceae')
    expect(hints.get(BOSEA_2)).toBe('Boseaceae')
  })

  it('goes further up when the immediate parents are the same', () => {
    const hints = homonymHints([X_1, X_2])
    expect(hints.get(X_1)).toBe('PhylumA')
    expect(hints.get(X_2)).toBe('PhylumB')
  })

  it('ignores the same id listed twice and non-taxonomy ids', () => {
    expect(homonymHints([BOSEA_1, BOSEA_1, 'COG0001', 'COG0001']).size).toBe(0)
  })

  it('separates three same-named taxa', () => {
    const third = 'Bacteria;Firmicutes;Bacilli;Rhizobiales;Boseaceae;Bosea'
    const hints = homonymHints([BOSEA_1, BOSEA_2, third])
    expect(new Set([hints.get(BOSEA_1), hints.get(BOSEA_2), hints.get(third)]).size).toBe(3)
  })
})

describe('withHomonymHint', () => {
  it('appends the hint only when there is one', () => {
    const hints = homonymHints([BOSEA_1, BOSEA_2])
    expect(withHomonymHint('Bosea', BOSEA_1, hints)).toBe('Bosea · Bradyrhizobiaceae')
    expect(withHomonymHint('Lonely', 'Bacteria;Lonely', hints)).toBe('Lonely')
  })
})
