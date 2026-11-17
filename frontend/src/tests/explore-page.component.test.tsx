/**
 * explore-page.component.test.tsx
 * ==================================
 * Focused component tests for ExplorePage (pages/ExplorePage.tsx) covering
 * request-sequence races in the Top EGC
 * Annotations and Annotation Lookup sections, which share one big
 * ExploreState object owned by the parent (App.tsx). Not a general
 * ExplorePage coverage pass -- just the two race scenarios this file's
 * own DatasetOverviewPanel/AnnotationsByParentPanel siblings already have
 * dedicated test files for.
 *
 * Coverage
 * --------
 *   Top EGC: switching the source dropdown while a request is still in
 *     flight does not relabel the eventually-returned rows under the new
 *     source -- CSV export filename, ScaffoldBtn's `source` prop, and
 *     HierarchyBtn's title all read what was actually loaded, not the
 *     live dropdown
 *   Lookup: switching the source dropdown before a search resolves does
 *     not show the returned annotation tagged/labelled under the new
 *     source -- the `.tag` element and the Depth field's per-source rank
 *     label (kegg/cog/enzyme/taxonomy each have a different depth->label
 *     map) both read what was actually searched
 *   Lookup: a taxonomy result's External Databases link uses the bare
 *     leaf name, not the full lineage
 *
 * Run: npx vitest run src/tests/explore-page.component.test.tsx
 */

import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ExplorePage } from '../pages/ExplorePage'
import { makeDefaultExploreState, type ExploreState } from '../pages/exploreState'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data }
}

// Captures the filename passed to downloadCsv (utils/api.ts sets
// `a.download = filename` then calls `a.click()`) without actually
// triggering a browser download.
let lastDownloadFilename: string | null = null
const originalCreateElement = document.createElement.bind(document)

beforeEach(() => {
  mockFetch.mockReset()
  lastDownloadFilename = null
  vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
    const el = originalCreateElement(tag)
    if (tag === 'a') {
      Object.defineProperty(el, 'click', {
        value: () => { lastDownloadFilename = (el as HTMLAnchorElement).download },
        writable: true,
      })
    }
    return el
  })
})

// Minimal stateful wrapper -- ExploreState is owned by App.tsx in
// production; tests need the same real state/setState wiring, not a mock,
// since the bug being tested is specifically about what setState is called
// with when a stale response resolves.
function Harness({ initial, resetKey = 0 }: { initial: Partial<ExploreState>; resetKey?: number }) {
  const [state, setState] = useState<ExploreState>({ ...makeDefaultExploreState(), ...initial })
  return (
    <ExplorePage
      state={state}
      setState={updater => setState(updater)}
      resetKey={resetKey}
      dataDateRange={null}
      indexReady
      onSendToAnalyze={() => {}}
      onGoScaffoldExplore={() => {}}
      onReset={() => {}}
    />
  )
}

describe('ExplorePage — Top EGC Annotations source race', () => {
  it('switching source while the request is in flight does not relabel the still-loading rows', async () => {
    const user = userEvent.setup()
    let resolveEnzyme!: () => void
    const enzymePending = new Promise<void>(resolve => { resolveEnzyme = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=enzyme')) {
        return enzymePending.then(() => jsonResponse({
          data: [{ annotation_id: '1.1.1.1', name: 'alcohol dehydrogenase', parent: null, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          sample_count: 128,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'taxonomy' }} />)

    const select = screen.getAllByRole('combobox')[0]
    await user.selectOptions(select, 'enzyme')
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    // Switch away from enzyme WHILE its request is still pending.
    await user.selectOptions(select, 'cog')

    resolveEnzyme()
    await waitFor(() => {
      expect(screen.getByText('1.1.1.1')).toBeInTheDocument()
    })

    // Real enzyme data must say "enzyme" in the Hierarchy button's title, never
    // "cog" (the live dropdown at the time the stale response landed).
    expect(screen.getByTitle('View 1.1.1.1 in the enzyme hierarchy')).toBeInTheDocument()
    expect(screen.queryByTitle('View 1.1.1.1 in the cog hierarchy')).not.toBeInTheDocument()

    // CSV export: filename must embed the real (enzyme) source, never the
    // live dropdown (cog) that was switched to mid-flight.
    await user.click(screen.getByRole('button', { name: /^↓ CSV$/i }))
    expect(lastDownloadFilename).toBe('top_enzyme_annotations.csv')

    // ScaffoldBtn's `source` prop must also be enzyme -- confirmed via the
    // opened ScaffoldModal's own source tag.
    await user.click(screen.getByTestId('scaffold-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('source-tag')).toHaveTextContent('enzyme')
    })
  })
})

// The "Based on N samples" date suffix
// below the Top EGC table must describe the request that actually
// produced the displayed rows/sampleCount, not whatever is currently
// sitting in the live date picker -- clearing/editing the date fields
// after loading, without clicking Load again, must not flip just this
// suffix to the live (unloaded) value while sampleCount and the table
// still describe the real, still-dated request.
describe('ExplorePage — Top EGC date suffix describes what was loaded, not the live picker', () => {
  it('keeps the loaded date range in the suffix after the date picker is cleared without reloading', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: 'K00001', name: 'alcohol dehydrogenase', parent: null, mean_egc: 100, max_egc: 200, sample_count: 10 }],
          sample_count: 10,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'kegg', dateFrom: '2021-06-01', dateTo: '2021-06-10' }} />)

    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await waitFor(() => {
      expect(screen.getByText(/Based on 10 samples/)).toBeInTheDocument()
    })
    expect(screen.getByText(/2021-06-01 → 2021-06-10/)).toBeInTheDocument()

    // Clear the live date picker WITHOUT clicking Load again -- rows and
    // sampleCount still describe the original 2021-06-01..06-10 request.
    // (Not /clear/i -- the page header's unrelated "Clear Page" button
    // also matches that, since its accessible name includes "Clear".)
    await user.click(screen.getByRole('button', { name: '✕ clear' }))

    expect(screen.getByText(/Based on 10 samples/)).toBeInTheDocument()
    expect(screen.getByText(/2021-06-01 → 2021-06-10/)).toBeInTheDocument()
    expect(screen.queryByText(/\(all dates\)/)).not.toBeInTheDocument()
  })
})

// The "Filter by ID, name, or parent group…" box must match the expanded
// label actually shown in the Group column (e.g. "Amino acid transport and
// metabolism"), not just the raw stored r.parent code (e.g. bare "E").
describe('ExplorePage — Top EGC filter box matches the displayed Group label, not just the raw stored code', () => {
  it('matches a row by its expanded Group label even though the stored parent is a bare code', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        return Promise.resolve(jsonResponse({
          data: [
            { annotation_id: 'COG0001', name: 'GroEL', parent: 'E', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128 },
            { annotation_id: 'COG0002', name: 'Other',  parent: 'K', depth: 2, mean_egc: 50,  max_egc: 100, sample_count: 128 },
          ],
          sample_count: 128,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'cog' }} />)

    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await screen.findByText('COG0001')
    // Confirms the Group column really shows the expanded label, not the
    // bare stored code -- otherwise this test would prove nothing.
    expect(screen.getByText('Amino acid transport and metabolism')).toBeInTheDocument()

    await user.type(
      screen.getByPlaceholderText(/Filter by ID, name, or parent group/i),
      'Amino acid',
    )

    expect(screen.getByText('COG0001')).toBeInTheDocument()
    expect(screen.queryByText('COG0002')).not.toBeInTheDocument()
  })
})

// The "Relative" bar's width scales against the shown rows' own max
// mean_egc, so leaf rows ranked on their own fill their bars, and the same
// rows next to a category's much larger total read as small.
describe('ExplorePage — Top EGC "Relative" bars scale to the rows shown', () => {
  it('leaves fill their bars on their own, and shrink once All brings in the category', async () => {
    const user = userEvent.setup()
    const rows = [
      // Depth 1 (category) -- by far the largest mean_egc.
      { annotation_id: 'E', name: 'Amino acid metabolism', parent: null, depth: 1, mean_egc: 1000, max_egc: 2000, sample_count: 128 },
      // Depth 2 (COGs) -- what the default rank shows.
      { annotation_id: 'COG_LEAF_HIGH', name: 'leaf high', parent: 'E', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128 },
      { annotation_id: 'COG_LEAF_LOW',  name: 'leaf low',  parent: 'E', depth: 2, mean_egc: 50,  max_egc: 100, sample_count: 128 },
    ]
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        const depths = [...url.matchAll(/[?&]depth=(\d+)/g)].map(m => Number(m[1]))
        return Promise.resolve(jsonResponse({
          data: depths.length ? rows.filter(r => depths.includes(r.depth)) : rows,
          sample_count: 128,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'cog' }} />)

    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await screen.findByText('COG_LEAF_HIGH')

    function barStyle(annotationId: string): string {
      const row = screen.getByText(annotationId).closest('tr')!
      const bar = row.querySelector('td:last-child > div')!
      return bar.getAttribute('style') ?? ''
    }

    // COGs only: scaled against the top COG's 100.
    expect(screen.queryByText('Amino acid metabolism')).not.toBeInTheDocument()
    expect(barStyle('COG_LEAF_HIGH')).toContain('var(--teal) 100%,')
    expect(barStyle('COG_LEAF_LOW')).toContain('var(--teal) 50%,')

    // All ranks: the category's 1000 sets the scale.
    await user.click(screen.getByRole('button', { name: 'All' }))
    await screen.findByText('Amino acid metabolism')
    expect(barStyle('COG_LEAF_HIGH')).toContain('var(--teal) 10%,')
    expect(barStyle('COG_LEAF_LOW')).toContain('var(--teal) 5%,')
  })
})

// The Lookup result list shows a (N/128) detection-count disclosure, a
// "mean when detected" tooltip, and a sort-method label, like the Analyze
// page's own equivalent list (LeftResultList), for the same reason: a 9-sample mean and a 128-sample
// mean otherwise look identical, and a sparse detection can outrank a
// fully-detected one with nothing to warn the reader.
describe('ExplorePage — Annotation Lookup detection-count disclosure', () => {
  it('shows (N/128) and a detection tooltip for a partially-detected result, but not for a fully-detected one', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=kegg')) {
        return Promise.resolve(jsonResponse({
          data: [
            { annotation_id: 'K00001', name: 'alcohol dehydrogenase', parent: null, depth: 4, mean_egc: 100, max_egc: 200, sample_count: 9 },
            { annotation_id: 'K00002', name: 'other dehydrogenase', parent: null, depth: 4, mean_egc: 50, max_egc: 90, sample_count: 128 },
          ],
          total: 2,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K00001')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await screen.findByText('K00001')
    expect(screen.getByText('(9/128)')).toBeInTheDocument()
    expect(screen.queryByText('(128/128)')).not.toBeInTheDocument()
    expect(screen.getByTitle('Mean when detected, across 9 of 128 samples')).toBeInTheDocument()
    expect(screen.getByText(/closest matches first, then by mean EGC/i)).toBeInTheDocument()
  })
})

describe('ExplorePage — Annotation Lookup source race', () => {
  it('switching source before the search resolves does not tag the result under the new source', async () => {
    const user = userEvent.setup()
    let resolveKegg!: () => void
    const keggPending = new Promise<void>(resolve => { resolveKegg = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=kegg')) {
        return keggPending.then(() => jsonResponse({
          data: [{ annotation_id: 'K02014', name: 'K02014 protein', parent: null, depth: 1, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          total: 1,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K02014')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    // Switch the lookup source to cog WHILE kegg's search is still pending.
    const selects = screen.getAllByRole('combobox')
    const lookupSelect = selects[selects.length - 1]
    await user.selectOptions(lookupSelect, 'cog')

    resolveKegg()
    await waitFor(() => {
      expect(screen.getByText('kegg', { selector: '.tag' })).toBeInTheDocument()
    })

    // The result card must be tagged "kegg" (what was really searched),
    // never "cog" (the live dropdown at the time the response landed).
    expect(screen.queryByText('cog', { selector: '.tag' })).not.toBeInTheDocument()

    // Depth field's rank-label switch must use kegg's depth->label map
    // (depth 1 = "KO"), not cog's (where depth 1 is "category").
    await waitFor(() => {
      expect(document.querySelector('.lookup-meta-value.mono')?.textContent).toContain('KO')
    })
    expect(document.querySelector('.lookup-meta-value.mono')?.textContent).not.toContain('category')
  })
})

describe('ExplorePage — Annotation Lookup says what Mean norm EGC is', () => {
  it('describes it as the average of per-sample relative abundance over detected samples', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(jsonResponse(url.includes('/api/search/annotations')
        ? {
            data: [{ annotation_id: 'K02014', name: 'K02014 protein', parent: null, depth: 4, mean_egc: 100, max_egc: 200,
              mean_norm_egc: 0.001, max_norm_egc: 0.002, sample_count: 128 }],
            total: 1,
          }
        : {})))
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)
    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K02014')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    const label = await screen.findByText('Mean norm EGC when detected')
    expect(screen.getByText('Mean EGC when detected')).toBeInTheDocument()
    expect(label.title).toMatch(/average/i)
    expect(label.title).toMatch(/where it was detected/)
    expect(label.title).not.toMatch(/total sample depth/)
  })
})

// KEGG orthologs are a flat list: a KO has no parent or category, so the
// lookup card shows neither and asks the server for no KEGG hierarchy data.
describe('ExplorePage — Annotation Lookup: a KEGG KO is a flat-list entry', () => {
  function lookupKo(row: object) {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=kegg')) {
        return Promise.resolve(jsonResponse({ data: [row], total: 1 }))
      }
      return Promise.resolve(jsonResponse({}))
    })
  }

  it('shows no Parent or Category row and fetches no KEGG hierarchy', async () => {
    const user = userEvent.setup()
    lookupKo({ annotation_id: 'K00844', name: 'hexokinase', parent: null, category: null, depth: 1, mean_egc: 100, max_egc: 200, sample_count: 128 })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K00844')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())
    const meta = document.querySelector('.lookup-meta-grid')!.textContent ?? ''
    expect(meta).not.toMatch(/Parent|Categor/)
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/api/kegg/'))).toBe(false)
    expect(screen.getByRole('link', { name: 'KEGG' })).toHaveAttribute('href', 'https://www.kegg.jp/entry/K00844')
  })

  it('a KO JGI never names says so instead of showing a blank name', async () => {
    const user = userEvent.setup()
    lookupKo({ annotation_id: 'K22909', name: null, parent: null, category: null, depth: 1, mean_egc: 1, max_egc: 2, sample_count: 5 })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K22909')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    expect(await screen.findByTestId('lookup-kegg-no-name')).toHaveTextContent('No name from JGI')
  })

  it('a COG asks for its own categories, never KEGG data', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=cog')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: 'COG0055', name: 'ATP synthase', parent: 'C', category: 'Energy production and conversion', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          total: 1,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'cog' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'COG0055')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/api/kegg/'))).toBe(false)
  })

  it('a genuinely single-parent source (enzyme) is unaffected -- still shows its own stored category directly', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=enzyme')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: '1.1.1.1', name: 'alcohol dehydrogenase', parent: '1.1.1', category: 'Oxidoreductases', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          total: 1,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'enzyme' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), '1.1.1.1')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())
    expect(screen.getByText('Oxidoreductases')).toBeInTheDocument()
    expect(screen.queryByTestId('lookup-cog-categories')).toBeNull()
  })

  it('a renumbered enzyme shows the old EC number JGI\'s files use', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=enzyme')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: '5.6.1.10', name: 'non-chaperonin molecular chaperone ATPase', parent: '5.6.1', category: 'Isomerases', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          total: 1,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'enzyme' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), '5.6.1.10')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    expect(await screen.findByTestId('lookup-ec-renumbered')).toHaveTextContent('3.6.4.10')
  })
})

// Same for cog -- a COG id's single stored `parent`/`category` field can
// only ever hold ONE of its possibly-many real categories (340 real
// multi-category COGs, e.g. COG0028 real under both E and H). COG has no
// separate "parent" vs. "category" distinction (only 2 real levels
// total), so a single cogCategoryNames row covers both, reading the
// same /api/cog/path data the hierarchy popup uses.
describe('ExplorePage — Annotation Lookup shows every real COG category', () => {
  function mockSearchAndPath(searchRow: object, pathResponse: object | null) {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=cog')) {
        return Promise.resolve(jsonResponse({ data: [searchRow], total: 1 }))
      }
      if (url.includes('/api/cog/path')) {
        return pathResponse
          ? Promise.resolve(jsonResponse(pathResponse))
          : Promise.reject(new Error('network error'))
      }
      return Promise.resolve(jsonResponse({}))
    })
  }

  it('shows every real category for a multi-category COG, and never the stale stored value', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      {
        annotation_id: 'COG0028', name: 'Multifunctional...', parent: 'E', // alphabetically-first, the stale stored value
        category: 'E', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128,
      },
      {
        annotation_id: 'COG0028',
        path_count: 2,
        paths: [
          [{ annotation_id: 'E', name: 'Amino acid transport and metabolism', depth: 1 }, { annotation_id: 'COG0028', name: 'Multifunctional...', depth: 2 }],
          [{ annotation_id: 'H', name: 'Coenzyme transport and metabolism', depth: 1 }, { annotation_id: 'COG0028', name: 'Multifunctional...', depth: 2 }],
        ],
      },
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'cog' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'COG0028')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    const categoriesRow = await screen.findByTestId('lookup-cog-categories')
    expect(categoriesRow).toHaveTextContent('Amino acid transport and metabolism')
    expect(categoriesRow).toHaveTextContent('Coenzyme transport and metabolism')
    expect(within(categoriesRow).getByText('Categories')).toBeInTheDocument() // plural when there's more than one

    // The generic single-value Category/Parent rows must both stay
    // suppressed for cog -- showing either would be exactly the
    // last-occurrence-wins value this fix exists to stop trusting.
    expect(screen.queryByText('Category')).toBeNull()
    expect(screen.queryByText('Parent')).toBeNull()
  })

  it('shows a single category without the plural label for a genuinely single-category COG', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      { annotation_id: 'COG0055', name: 'ATP synthase', parent: 'C', category: 'C', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128 },
      {
        annotation_id: 'COG0055',
        path_count: 1,
        paths: [[{ annotation_id: 'C', name: 'Energy production and conversion', depth: 1 }, { annotation_id: 'COG0055', name: 'ATP synthase', depth: 2 }]],
      },
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'cog' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'COG0055')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    const categoriesRow = await screen.findByTestId('lookup-cog-categories')
    expect(categoriesRow).toHaveTextContent('Energy production and conversion')
    expect(within(categoriesRow).getByText('Category')).toBeInTheDocument() // singular, no "ies"
  })

  it('shows nothing (not a stale/wrong value) when the real-path fetch fails', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      { annotation_id: 'COG0028', name: 'Multifunctional...', parent: 'E', category: 'E', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128 },
      null,
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'cog' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'COG0028')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())
    expect(screen.queryByTestId('lookup-cog-categories')).toBeNull()
    expect(screen.queryByText('Category')).toBeNull()
    expect(screen.queryByText('Parent')).toBeNull()
  })
})

// The lookup card's `name={r.name}` prop on
// ExternalLinks must actually reach the NCBI Taxonomy link -- exercised
// through the real lookup card, not ExternalLinks in isolation (which
// already has its own direct unit coverage in external-links.component.test.tsx).
// `name` deliberately differs from the id's own last `;`-segment so this
// test can tell whether `name` really reached ExternalLinks -- otherwise
// taxonomyAwarePrimaryLabel's id-derived fallback produces the same value
// either way and the test would pass without proving the wiring works.
describe('ExplorePage — Lookup External Databases link', () => {
  it('a taxonomy result\'s NCBI Taxonomy link uses the real name prop, not just the id-derived fallback', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=taxonomy')) {
        return Promise.resolve(jsonResponse({
          data: [{
            annotation_id: 'Bacteria;Proteobacteria', name: 'Proteobacteria (beta)', parent: 'Bacteria',
            mean_egc: 100, max_egc: 200, sample_count: 128,
          }],
          total: 1,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'taxonomy' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'Proteobacteria')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await waitFor(() => {
      expect(screen.getByRole('link', { name: 'NCBI Taxonomy' })).toHaveAttribute(
        'href', 'https://www.ncbi.nlm.nih.gov/taxonomy/?term=Proteobacteria%20(beta)',
      )
    })
  })
})

// /api/annotations/top returns `depth` for every source so the Top EGC
// table can rank-filter down to real leaf annotations -- since a parent's
// EGC is the sum of its descendants, the unfiltered top list is dominated
// by branch/rollup nodes. Confirms the rank-filter pills appear for a
// non-taxonomy source and actually narrow the table by the row's real depth.
describe('ExplorePage — Top EGC rank pills work for non-taxonomy sources', () => {
  it('enzyme pills use enzyme rank names and add their rank to the request', async () => {
    const user = userEvent.setup()
    const rows = [
      { annotation_id: '1', name: 'Oxidoreductases', parent: null, depth: 1, mean_egc: 900, max_egc: 1000, sample_count: 128 },
      { annotation_id: '1.1.1.1', name: 'alcohol dehydrogenase', parent: '1.1.1', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
    ]
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=enzyme')) {
        const depths = [...url.matchAll(/[?&]depth=(\d+)/g)].map(m => Number(m[1]))
        return Promise.resolve(jsonResponse({
          data: depths.length ? rows.filter(r => depths.includes(r.depth)) : rows,
          sample_count: 128,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'enzyme' }} />)

    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await screen.findByText('1.1.1.1')
    expect(screen.queryByText('Oxidoreductases')).not.toBeInTheDocument()

    // enzyme's own rank names (same as the Lookup card's Depth row), never a
    // taxonomy rung name like "Domain" for a non-taxonomy source.
    const pill = (label: string) => screen.getAllByRole('button').find(b => b.className.includes('al-source-pill') && b.textContent === label)
    expect(pill('class')).toBeDefined()
    expect(pill('leaf (EC)')).toBeDefined()
    expect(screen.queryByText('Domain')).not.toBeInTheDocument()

    await user.click(pill('class')!)

    await screen.findByText('Oxidoreductases')
    expect(screen.getByText('1.1.1.1')).toBeInTheDocument()
  })
})

// KEGG orthologs are a flat list: the Group column is empty for a KO and
// nothing asks the server for KEGG parents.
describe('ExplorePage — Top EGC Group column for KEGG', () => {
  it('a KO has no group, and no parents are requested', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=kegg')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: 'K00134', name: 'glyceraldehyde 3-phosphate dehydrogenase', parent: null, depth: 1, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          sample_count: 128,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'kegg' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    await waitFor(() => expect(screen.getByText('K00134')).toBeInTheDocument())
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/parents'))).toBe(false)
    expect(screen.queryByTestId('top-multi-parents-fetch-failure-warning')).toBeNull()
  })
})

// A Lookup rank filter picked for one set of results must not silently
// carry over to the next search -- the new results may have none of that
// rank, and the pill bar (shown only when there's more than one rank to
// choose from) would then vanish, leaving an empty list with no way to
// clear it. Top EGC fetches its chosen rank from the server instead (see
// "Top EGC ranks the chosen level on the server").
describe('ExplorePage — rank filters reset when new rows load', () => {
  const pill = (label: string) =>
    screen.getAllByRole('button').find(b => b.className.includes('al-source-pill') && b.textContent === label)

  it('Lookup: a new search clears the rank filter', async () => {
    const user = userEvent.setup()
    let rows: object[] = [
      { annotation_id: '1', source: 'enzyme', name: 'Oxidoreductases', parent: null, depth: 1, mean_egc: 900, max_egc: 1000, sample_count: 128 },
      { annotation_id: '1.1.1.1', source: 'enzyme', name: 'alcohol dehydrogenase', parent: '1.1.1', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
    ]
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(jsonResponse(url.includes('/api/search/annotations') ? { data: rows, total: rows.length } : {})))
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'enzyme' }} />)

    const input = screen.getByPlaceholderText(/ID \(K02014\)/i)
    await user.type(input, 'dehydrogenase')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))
    await waitFor(() => expect(pill('leaf (EC)')).toBeDefined())
    await user.click(pill('leaf (EC)')!)

    rows = [
      { annotation_id: '2', source: 'enzyme', name: 'Transferases', parent: null, depth: 1, mean_egc: 600, max_egc: 700, sample_count: 128 },
      { annotation_id: '3', source: 'enzyme', name: 'Hydrolases', parent: null, depth: 1, mean_egc: 500, max_egc: 600, sample_count: 128 },
    ]
    await user.clear(input)
    await user.type(input, 'ases')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await waitFor(() => expect(screen.getByText('Transferases')).toBeInTheDocument())
    expect(screen.getByText('Hydrolases')).toBeInTheDocument()
  })
})

describe('ExplorePage — Annotation Lookup opens an exact match', () => {
  function lookupRows(firstMatch: string) {
    return [
      { annotation_id: '2.7.1.1', source: 'enzyme', name: 'hexokinase', parent: '2.7.1', depth: 4, mean_egc: 10, max_egc: 20, sample_count: 80, match: firstMatch },
      { annotation_id: '2.7.1.170', source: 'enzyme', name: 'anhydro-N-acetylmuramic acid kinase', parent: '2.7.1', depth: 4, mean_egc: 900, max_egc: 1000, sample_count: 128, match: 'starts' },
    ]
  }

  it('selects the one exact match even when the search also found longer ids', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(jsonResponse(url.includes('/api/search/annotations') ? { data: lookupRows('exact'), total: 62 } : {})))
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'enzyme' }} />)

    await user.type(screen.getByPlaceholderText(/ID/i), '2.7.1.1')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    expect(await screen.findByRole('button', { name: /View Timeseries in Analyze/i })).toBeInTheDocument()
    expect(screen.getByText(/closest matches first, then by mean EGC/i)).toBeInTheDocument()
  })

  it('selects nothing when no result is an exact match', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(jsonResponse(url.includes('/api/search/annotations') ? { data: lookupRows('starts'), total: 62 } : {})))
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'enzyme' }} />)

    await user.type(screen.getByPlaceholderText(/ID/i), '2.7.1')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await screen.findByText('2.7.1.170')
    expect(screen.queryByRole('button', { name: /View Timeseries in Analyze/i })).not.toBeInTheDocument()
  })
})

describe('ExplorePage — Top EGC Group column shows every real COG category', () => {
  it('a multi-category COG shows both categories, not just its stored one', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: 'COG0028', name: 'thiamine pyrophosphate enzyme', parent: 'E', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          sample_count: 128,
        }))
      if (url.includes('/api/cog/parents'))
        return Promise.resolve(jsonResponse({
          parents: {
            COG0028: [
              { annotation_id: 'E', name: 'Amino acid transport and metabolism' },
              { annotation_id: 'H', name: 'Coenzyme transport and metabolism' },
            ],
          },
        }))
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'cog' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    await waitFor(() => expect(screen.getByText(/Amino acid transport and metabolism \(\+1 more\)/)).toBeInTheDocument())
    expect(screen.getByTitle(/Coenzyme transport and metabolism/)).toBeInTheDocument()
  })
})

describe('ExplorePage — Lookup shows the scaffold range across samples', () => {
  it('shows fewest to most scaffolds per sample, not one arbitrary sample', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: 'K02703', name: 'psbA', parent: null, depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128, scaffold_count: 16 }],
          total: 1,
        }))
      }
      if (url.includes('/api/annotations/scaffolds/summary') && url.includes('annotation_id=K02703')) {
        return Promise.resolve(jsonResponse({
          data: [
            { sample: 's1', date: '5/27/21 13:00', scaffold_count: 14, gene_count: 20 },
            { sample: 's2', date: '5/27/21 17:00', scaffold_count: 11, gene_count: 15 },
            { sample: 's3', date: '5/27/21 21:00', scaffold_count: 17, gene_count: 22 },
          ],
          total: 3,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)
    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K02703')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    const label = await screen.findByText('Scaffolds per sample')
    expect(label.title).toMatch(/3 samples/)
    expect(label.parentElement!.textContent).toContain('11–17')
    expect(screen.queryByText('Scaffolds (sample)')).not.toBeInTheDocument()
  })
})

describe('ExplorePage — the Lookup rank filter names the right kind of level', () => {
  it('an enzyme result list calls them levels, not taxonomic ranks', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(jsonResponse(url.includes('/api/search/annotations')
        ? {
            data: [
              { annotation_id: '1.1.1.1', name: 'alcohol dehydrogenase', parent: '1.1.1', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
              { annotation_id: '1.1.1', name: 'With NAD(+) or NADP(+) as acceptor', parent: '1.1', depth: 3, mean_egc: 900, max_egc: 990, sample_count: 128 },
            ],
            total: 2,
          }
        : {})))
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'enzyme' }} />)
    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), '1.1.1')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))
    const filter = await waitFor(() => {
      const el = document.querySelector('.al-rank-filter')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    await user.click(within(filter).getByTitle('Help'))
    const tip = await screen.findByText(/Narrows the result list/)
    expect(tip.textContent).toMatch(/selected level\(s\)/)
    expect(tip.textContent).not.toMatch(/taxonomic/)
  })
})

describe('ExplorePage — enzyme groups are headed by their own name', () => {
  function mockEnzyme() {
    mockFetch.mockImplementation((url: string) => {
      if (!url.includes('/api/annotations/top')) return Promise.resolve(jsonResponse({}))
      if (url.includes('ids=')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: '1.1.1', name: 'With NAD+ or NADP+ as acceptor', parent: '1.1', mean_egc: 500, max_egc: 900, sample_count: 128 }],
        }))
      }
      return Promise.resolve(jsonResponse({
        data: [
          { annotation_id: '1.1.1.1', name: 'alcohol dehydrogenase', parent: '1.1.1', mean_egc: 100, max_egc: 200, sample_count: 128 },
          { annotation_id: '1.1.1.2', name: 'alcohol dehydrogenase (NADP+)', parent: '1.1.1', mean_egc: 50, max_egc: 90, sample_count: 128 },
        ],
        sample_count: 128,
      }))
    })
  }

  it('Annotations by Parent', async () => {
    mockEnzyme()
    render(<Harness initial={{ openSection: 'by-parent', parentSource: 'enzyme' }} />)
    expect(await screen.findByText('1.1.1 · With NAD+ or NADP+ as acceptor')).toBeInTheDocument()
    expect(screen.queryByText('1.1.1 · Oxidoreductases')).not.toBeInTheDocument()
  })

  it('Dataset Overview', async () => {
    mockEnzyme()
    const user = userEvent.setup()
    render(<Harness initial={{ openSection: 'overview', parentSource: 'cog' }} />)
    await user.selectOptions(screen.getAllByRole('combobox')[0], 'enzyme')
    await user.click(screen.getByRole('button', { name: /Load Overview/i }))
    expect((await screen.findAllByText(/1\.1\.1 · With NAD\+ or NADP\+ as acceptor/)).length).toBeGreaterThan(0)
    expect(screen.queryByText(/1\.1\.1 · Oxidoreductases/)).not.toBeInTheDocument()
  })
})

describe('ExplorePage — a section keeps what it loaded when you switch away and back', () => {
  function mockTop() {
    mockFetch.mockImplementation((url: string) =>
      url.includes('/api/annotations/top')
        ? Promise.resolve(jsonResponse({
            data: [{ annotation_id: 'X1', name: 'X1', parent: 'P1', mean_egc: 10, max_egc: 20, sample_count: 128 }],
            sample_count: 128,
          }))
        : Promise.resolve(jsonResponse({})),
    )
  }
  // List loads only; the follow-up lookup of the groups' own totals
  // (ids=) is counted separately.
  const topCalls = (source: string) =>
    mockFetch.mock.calls.filter(c => String(c[0]).includes('/api/annotations/top') && String(c[0]).includes(`source=${source}`) && !String(c[0]).includes('ids=')).length
  const ownTotalCalls = (source: string) =>
    mockFetch.mock.calls.filter(c => String(c[0]).includes('/api/annotations/top') && String(c[0]).includes(`source=${source}`) && String(c[0]).includes('ids=')).length

  it('Dataset Overview', async () => {
    mockTop()
    const user = userEvent.setup()
    // by-Parent on a different source, so its own request isn't counted here.
    render(<Harness initial={{ openSection: 'overview', parentSource: 'cog' }} />)
    await user.click(screen.getByRole('button', { name: /Load Overview/i }))
    await screen.findByText(/parent groups/)
    await user.click(screen.getByRole('button', { name: /Annotations by Parent/ }))
    await user.click(screen.getByRole('button', { name: /Dataset Overview/ }))
    expect(screen.getByText(/parent groups/)).toBeVisible()
    expect(topCalls('taxonomy')).toBe(1)
    expect(ownTotalCalls('taxonomy')).toBe(1)
  })

  it('Annotations by Parent', async () => {
    mockTop()
    const user = userEvent.setup()
    render(<Harness initial={{ openSection: 'by-parent', parentSource: 'cog' }} />)
    await waitFor(() => expect(topCalls('cog')).toBe(1))
    await user.click(screen.getByRole('button', { name: /Dataset Overview/ }))
    await user.click(screen.getByRole('button', { name: /Annotations by Parent/ }))
    await screen.findByText('P1')
    expect(topCalls('cog')).toBe(1)
    expect(ownTotalCalls('cog')).toBe(1)
  })

  it('Clear Page still starts Annotations by Parent over', async () => {
    mockTop()
    const { rerender } = render(<Harness initial={{ openSection: 'by-parent', parentSource: 'cog' }} />)
    await waitFor(() => expect(topCalls('cog')).toBe(1))
    rerender(<Harness initial={{ openSection: 'by-parent', parentSource: 'cog' }} resetKey={1} />)
    await waitFor(() => expect(topCalls('cog')).toBe(2))
  })
})

describe('ExplorePage — Bulk Download section', () => {
  const SUMMARY = { source: 'taxonomy', parent: null, rank: 'phylum', taxa: 111, samples: 128, max_rows: 14208, sparse: false }

  it('opens from its card', async () => {
    mockFetch.mockResolvedValue(jsonResponse(SUMMARY))
    const user = userEvent.setup()
    render(<Harness initial={{}} />)
    expect(screen.queryByTestId('bulk-start')).toBeNull()
    await user.click(screen.getByRole('button', { name: /Bulk Download/ }))
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Whole dataset')
  })

  it('starts from a taxon handed over by another page', async () => {
    mockFetch.mockResolvedValue(jsonResponse(SUMMARY))
    render(<Harness initial={{
      openSection: 'bulk-download',
      bulkDownloadInitialParent: { lineage: 'Bacteria;Proteobacteria;Gammaproteobacteria' },
    }} />)
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Gammaproteobacteria')
  })

  it('keeps its choices when another section is opened and closed again', async () => {
    mockFetch.mockResolvedValue(jsonResponse(SUMMARY))
    const user = userEvent.setup()
    render(<Harness initial={{ openSection: 'bulk-download' }} />)
    await user.selectOptions(screen.getByLabelText('Download every'), 'genus')
    await user.click(screen.getByRole('button', { name: /Annotation Lookup/ }))
    await user.click(screen.getByRole('button', { name: /Bulk Download/ }))
    expect((screen.getByLabelText('Download every') as HTMLSelectElement).value).toBe('genus')
  })
})


describe('ExplorePage — Lookup card links to Bulk Download', () => {
  const SUMMARY = { source: 'enzyme', parent: '5.6.2', rank: 'ec', taxa: 2, samples: 128, max_rows: 256, sparse: false }

  function lookupFetch(result: Record<string, unknown>) {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations')) {
        return Promise.resolve(jsonResponse({ data: [{ mean_egc: 1, max_egc: 1, sample_count: 128, parent: null, ...result }], total: 1 }))
      }
      if (url.includes('/api/series/export/summary')) return Promise.resolve(jsonResponse(SUMMARY))
      return Promise.resolve(jsonResponse({ data: [] }))
    })
  }

  async function lookUp(user: ReturnType<typeof userEvent.setup>, source: string, q: string) {
    render(<Harness initial={{ openSection: 'lookup', lookupSource: source }} />)
    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), q)
    await user.click(screen.getByRole('button', { name: /^Search$/i }))
    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())
  }

  it('an Enzyme sub-subclass opens Bulk Download starting from it', async () => {
    const user = userEvent.setup()
    lookupFetch({ annotation_id: '5.6.2', name: 'Enzymes altering nucleic acid conformation', depth: 3 })
    await lookUp(user, 'enzyme', '5.6.2')
    await user.click(screen.getByRole('button', { name: /Bulk download from here/ }))
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('enzyme')
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('5.6.2 Enzymes altering nucleic acid conformation')
    expect((screen.getByLabelText('Download every') as HTMLSelectElement).value).toBe('ec')
  })

  it('a taxon opens Bulk Download starting from its lineage', async () => {
    const user = userEvent.setup()
    lookupFetch({ annotation_id: 'Bacteria;Proteobacteria', name: 'Proteobacteria', depth: 2 })
    await lookUp(user, 'taxonomy', 'Proteobacteria')
    await user.click(screen.getByRole('button', { name: /Bulk download from here/ }))
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('taxonomy')
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Bacteria › Proteobacteria')
  })

  it('has no link for a term with nothing below it (an EC number)', async () => {
    const user = userEvent.setup()
    lookupFetch({ annotation_id: '5.6.2.1', name: 'DNA topoisomerase', depth: 4 })
    await lookUp(user, 'enzyme', '5.6.2.1')
    expect(screen.queryByRole('button', { name: /Bulk download from here/ })).toBeNull()
  })

  it('a COG category opens Bulk Download at COG level', async () => {
    const user = userEvent.setup()
    lookupFetch({ annotation_id: 'C', name: 'Energy production and conversion', depth: 1 })
    await lookUp(user, 'cog', 'C')
    await user.click(screen.getByRole('button', { name: /Bulk download from here/ }))
    expect((screen.getByLabelText('Source') as HTMLSelectElement).value).toBe('cog')
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('C Energy production and conversion')
    expect((screen.getByLabelText('Download every') as HTMLSelectElement).value).toBe('cog')
  })

  it('has no link for a single COG (nothing below it)', async () => {
    const user = userEvent.setup()
    lookupFetch({ annotation_id: 'COG0028', name: 'Acetolactate synthase large subunit', depth: 2 })
    await lookUp(user, 'cog', 'COG0028')
    expect(screen.queryByRole('button', { name: /Bulk download from here/ })).toBeNull()
  })

  // KEGG orthologs are a flat list, so nothing is below a KO.
  it('has no link for a KEGG KO', async () => {
    const user = userEvent.setup()
    lookupFetch({ annotation_id: 'K00844', name: 'hexokinase', depth: 1 })
    await lookUp(user, 'kegg', 'K00844')
    expect(screen.queryByRole('button', { name: /Bulk download from here/ })).toBeNull()
  })
})

// Every category's EGC contains its members', so an all-ranks top list is
// all categories (enzyme's top 25 holds no EC number). Top EGC Annotations asks the
// server for the chosen rank(s): by default each source's most specific
// level, and a rank pill fetches that rank's own top N.
describe('ExplorePage — Top EGC ranks the chosen level on the server', () => {
  const ROWS = [
    { annotation_id: '1', name: 'Oxidoreductases', parent: null, depth: 1, mean_egc: 900, max_egc: 1000, sample_count: 128 },
    { annotation_id: '1.1.1', name: 'With NAD(+) or NADP(+) as acceptor', parent: '1.1', depth: 3, mean_egc: 300, max_egc: 400, sample_count: 128 },
    { annotation_id: '1.1.1.1', name: 'alcohol dehydrogenase', parent: '1.1.1', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
  ]
  const topUrls = () => mockFetch.mock.calls.map(c => String(c[0]))
    .filter(u => u.includes('/api/annotations/top') && !u.includes('ids='))
  const depthsOf = (url: string) => [...url.matchAll(/[?&]depth=(\d+)/g)].map(m => Number(m[1]))
  const pill = (label: string) =>
    screen.getAllByRole('button').find(b => b.className.includes('al-source-pill') && b.textContent === label)!

  beforeEach(() => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        const depths = depthsOf(url)
        const data = depths.length ? ROWS.filter(r => depths.includes(r.depth)) : ROWS
        return Promise.resolve(jsonResponse({ data, sample_count: 128 }))
      }
      return Promise.resolve(jsonResponse({}))
    })
  })

  it.each([['kegg', 1], ['cog', 2], ['enzyme', 4], ['taxonomy', 7]])(
    'first load of %s asks for its most specific level (depth %i)',
    async (source, depth) => {
      const user = userEvent.setup()
      render(<Harness initial={{ openSection: 'top-egc', source }} />)
      await user.click(screen.getByRole('button', { name: /^Load$/i }))
      await waitFor(() => expect(topUrls()).toHaveLength(1))
      expect(depthsOf(topUrls()[0])).toEqual([depth])
    },
  )

  it('shows every level of the source as a pill, even ones absent from the rows', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ openSection: 'top-egc', source: 'enzyme' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await screen.findByText('1.1.1.1')
    expect(screen.queryByText('Oxidoreductases')).not.toBeInTheDocument()
    for (const label of ['All', 'class', 'subclass', 'sub-subclass', 'leaf (EC)']) {
      expect(pill(label)).toBeDefined()
    }
    expect(pill('leaf (EC)').className).toContain('al-source-pill-active')
  })

  it('a rank pill fetches that rank, and All fetches every rank', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ openSection: 'top-egc', source: 'enzyme' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await screen.findByText('1.1.1.1')

    await user.click(pill('leaf (EC)'))            // off
    await user.click(pill('class'))        // on
    await screen.findByText('Oxidoreductases')
    expect(depthsOf(topUrls().at(-1)!)).toEqual([1])
    expect(screen.queryByText('1.1.1.1')).not.toBeInTheDocument()

    await user.click(pill('All'))
    await screen.findByText('1.1.1.1')
    expect(depthsOf(topUrls().at(-1)!)).toEqual([])
    expect(screen.getByText('Oxidoreductases')).toBeInTheDocument()
  })

  it('reloading keeps the chosen rank; another source starts at its own default', async () => {
    const user = userEvent.setup()
    render(<Harness initial={{ openSection: 'top-egc', source: 'enzyme' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await screen.findByText('1.1.1.1')
    await user.click(pill('All'))
    await screen.findByText('Oxidoreductases')

    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await waitFor(() => expect(topUrls()).toHaveLength(3))
    expect(depthsOf(topUrls()[2])).toEqual([])

    await user.selectOptions(screen.getByDisplayValue('enzyme'), 'cog')
    await user.click(screen.getByRole('button', { name: /^Load$/i }))
    await waitFor(() => expect(topUrls()).toHaveLength(4))
    expect(topUrls()[3]).toContain('source=cog')
    expect(depthsOf(topUrls()[3])).toEqual([2])
  })
})
