/**
 * annotation-hierarchy.unit.test.ts
 * ===================================
 * Unit tests for filterRedundantAnnotations (utils/annotationHierarchy.ts).
 *
 * Summing an annotation together with one
 * of its own ancestors/descendants double-counts the contained one's
 * value, since annotation values are hierarchical rollups.
 *
 * Coverage
 * --------
 *   taxonomy: descendant dropped (free prefix check, no fetch)
 *   taxonomy: unrelated siblings both kept
 *   taxonomy: a 3-level nested chain drops both non-root levels
 *   cog/enzyme: descendant dropped via a real /path fetch
 *   kegg: a flat list -- candidates always kept, never looked up
 *   different sources never cross-contaminate (a taxonomy id can't contain a COG)
 *   a failed path fetch keeps the candidate rather than risking a wrong drop
 *   dropped result carries which candidate contained it (for the disclosure message)
 *
 * Run: npx vitest run src/tests/annotation-hierarchy.unit.test.ts
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'

const { mockApiFetch } = vi.hoisted(() => ({ mockApiFetch: vi.fn() }))
vi.mock('../utils/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/api')>()
  return { ...actual, apiFetch: mockApiFetch }
})

import { filterRedundantAnnotations } from '../utils/annotationHierarchy'

function pathResponse(paths: string[][]) {
  return {
    annotation_id: paths[0]?.[paths[0].length - 1] ?? '',
    path_count:    paths.length,
    paths:         paths.map(p => p.map((id, i) => ({ annotation_id: id, name: id, depth: i + 1 }))),
  }
}

beforeEach(() => {
  mockApiFetch.mockReset()
})

describe('filterRedundantAnnotations — taxonomy (free prefix check)', () => {
  it('drops a taxonomy descendant when its ancestor is also in the list', async () => {
    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'Bacteria', source: 'taxonomy' },
      { annotationId: 'Bacteria;Proteobacteria', source: 'taxonomy' },
    ])
    expect(kept).toEqual([{ annotationId: 'Bacteria', source: 'taxonomy' }])
    expect(dropped).toEqual([{
      candidate:   { annotationId: 'Bacteria;Proteobacteria', source: 'taxonomy' },
      containedBy: { annotationId: 'Bacteria', source: 'taxonomy' },
    }])
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('keeps unrelated taxonomy siblings, neither is a prefix of the other', async () => {
    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'Bacteria;Proteobacteria', source: 'taxonomy' },
      { annotationId: 'Bacteria;Bacteroidetes', source: 'taxonomy' },
    ])
    expect(kept).toHaveLength(2)
    expect(dropped).toHaveLength(0)
  })

  it('drops every non-root level of a 3-level nested chain', async () => {
    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'Bacteria', source: 'taxonomy' },
      { annotationId: 'Bacteria;Proteobacteria', source: 'taxonomy' },
      { annotationId: 'Bacteria;Proteobacteria;Alphaproteobacteria', source: 'taxonomy' },
    ])
    expect(kept).toEqual([{ annotationId: 'Bacteria', source: 'taxonomy' }])
    // Pin down `containedBy`, not just which candidates get dropped -- both
    // are correctly attributed to Bacteria here (the first ancestor found
    // in list order), not the nearer Proteobacteria. Containment is
    // transitive so either attribution would be factually correct, but
    // without this assertion a change to which one gets reported (e.g. to
    // prefer the nearest ancestor for a more specific disclosure message)
    // could land silently, with no test noticing either way.
    expect(dropped).toEqual([
      {
        candidate:   { annotationId: 'Bacteria;Proteobacteria', source: 'taxonomy' },
        containedBy: { annotationId: 'Bacteria', source: 'taxonomy' },
      },
      {
        candidate:   { annotationId: 'Bacteria;Proteobacteria;Alphaproteobacteria', source: 'taxonomy' },
        containedBy: { annotationId: 'Bacteria', source: 'taxonomy' },
      },
    ])
  })
})

describe('filterRedundantAnnotations — kegg/cog/enzyme', () => {
  it('drops a cog descendant using its real ancestor path', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('id=H')) return pathResponse([['H']])
      if (url.includes('id=COG0028')) return pathResponse([['H', 'COG0028']])
      throw new Error(`unexpected url: ${url}`)
    })

    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'H', source: 'cog' },
      { annotationId: 'COG0028', source: 'cog' },
    ])
    expect(kept).toEqual([{ annotationId: 'H', source: 'cog' }])
    expect(dropped).toEqual([{
      candidate:   { annotationId: 'COG0028', source: 'cog' },
      containedBy: { annotationId: 'H', source: 'cog' },
    }])
  })

  // KEGG orthologs are a flat list: no KO contains another, so KEGG
  // candidates are never looked up and never dropped.
  it('kegg candidates are always kept, with no path lookup', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      throw new Error(`unexpected url: ${url}`)
    })

    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'K00844', source: 'kegg' },
      { annotationId: 'K00845', source: 'kegg' },
    ])
    expect(kept).toHaveLength(2)
    expect(dropped).toHaveLength(0)
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('a lone candidate in a source never triggers a fetch (nothing to compare against)', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      throw new Error(`unexpected url: ${url}`)
    })

    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'Bacteria', source: 'taxonomy' },
      { annotationId: 'K00001', source: 'kegg' },
    ])
    expect(kept).toHaveLength(2)
    expect(dropped).toHaveLength(0)
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('cog and enzyme candidates present at once never cross into each other\'s /path endpoint', async () => {
    // A prior version of this test used 1 candidate per source, which can't
    // actually detect cross-source contamination -- group.length < 2 means
    // no fetch happens at all regardless of source-scoping. This version
    // puts 2+ real candidates in TWO hierarchy sources at once (one pair
    // genuinely related, one pair genuinely unrelated) and asserts on the
    // real fetch call log, not just the final kept/dropped outcome --
    // confirmed by deliberately breaking the source filter
    // (candidates.filter(c => c.source === source) -> c.source !== 'taxonomy',
    // pooling cog/enzyme into one shared group) and watching the
    // outcome assertions below still pass while the call-log assertions
    // correctly failed, before reverting.
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('/api/cog/path')) {
        if (url.includes('id=H'))       return pathResponse([['H']])
        if (url.includes('id=COG0028')) return pathResponse([['H', 'COG0028']])
      }
      if (url.includes('/api/enzyme/path')) {
        if (url.endsWith('id=1')) return pathResponse([['1']])
        // Genuinely unrelated to class 1 -- it is in class 2.
        if (url.includes('id=2.7.1.1')) return pathResponse([['2', '2.7', '2.7.1', '2.7.1.1']])
      }
      throw new Error(`unexpected url: ${url}`)
    })

    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'H',       source: 'cog' },
      { annotationId: 'COG0028', source: 'cog' },
      { annotationId: '1',       source: 'enzyme' },
      { annotationId: '2.7.1.1', source: 'enzyme' },
    ])

    expect(kept).toEqual(expect.arrayContaining([
      { annotationId: 'H',      source: 'cog' },
      { annotationId: '1',       source: 'enzyme' },
      { annotationId: '2.7.1.1', source: 'enzyme' },
    ]))
    expect(dropped).toEqual([{
      candidate:   { annotationId: 'COG0028', source: 'cog' },
      containedBy: { annotationId: 'H', source: 'cog' },
    }])

    const urls = mockApiFetch.mock.calls.map(call => call[0] as string)
    for (const url of urls.filter(u => u.includes('id=H') || u.includes('id=COG0028'))) {
      expect(url).toContain('/api/cog/path')
    }
    const enzymeUrls = urls.filter(u => u.endsWith('id=1') || u.includes('id=2.7.1.1'))
    expect(enzymeUrls).toHaveLength(2)
    for (const url of enzymeUrls) {
      expect(url).toContain('/api/enzyme/path')
    }
  })

  it('a failed path fetch keeps the candidate rather than risking an incorrect drop', async () => {
    mockApiFetch.mockImplementation(async (url: string) => {
      if (url.includes('id=H')) throw new Error('network error')
      if (url.includes('id=COG0028')) return pathResponse([['H', 'COG0028']])
      throw new Error(`unexpected url: ${url}`)
    })

    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'H', source: 'cog' },
      { annotationId: 'COG0028', source: 'cog' },
    ])
    // H's own ancestors are unknown (fetch failed), but COG0028 fetched fine
    // and its real path shows H as a real ancestor -- COG0028 still gets
    // dropped correctly. Nothing here should incorrectly drop H itself.
    expect(kept.map(c => c.annotationId)).toContain('H')
    expect(dropped.map(d => d.candidate.annotationId)).toEqual(['COG0028'])
  })
})

describe('filterRedundantAnnotations — no-op cases', () => {
  it('a single candidate is always kept, no fetch needed', async () => {
    const { kept, dropped } = await filterRedundantAnnotations([
      { annotationId: 'K00001', source: 'kegg' },
    ])
    expect(kept).toEqual([{ annotationId: 'K00001', source: 'kegg' }])
    expect(dropped).toHaveLength(0)
    expect(mockApiFetch).not.toHaveBeenCalled()
  })

  it('an empty list returns empty results', async () => {
    const { kept, dropped } = await filterRedundantAnnotations([])
    expect(kept).toHaveLength(0)
    expect(dropped).toHaveLength(0)
  })
})
