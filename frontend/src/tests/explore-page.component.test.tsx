/**
 * explore-page.component.test.tsx
 * ==================================
 * Focused component tests for ExplorePage (pages/ExplorePage.tsx) covering
 * W29 (docs/AUDIT-2026-09-22.md): request-sequence races in the Top EGC
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
 *     leaf name, not the full lineage (W32, docs/AUDIT-2026-09-22.md)
 *
 * Run: npx vitest run src/tests/explore-page.component.test.tsx
 */

import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ExplorePage, makeDefaultExploreState, type ExploreState } from '../pages/ExplorePage'

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
function Harness({ initial }: { initial: Partial<ExploreState> }) {
  const [state, setState] = useState<ExploreState>({ ...makeDefaultExploreState(), ...initial })
  return (
    <ExplorePage
      state={state}
      setState={updater => setState(updater)}
      resetKey={0}
      dataDateRange={null}
      indexReady
      onSendToAnalyze={() => {}}
      onGoScaffoldExplore={() => {}}
      onReset={() => {}}
    />
  )
}

describe('ExplorePage — Top EGC Annotations source race (W29)', () => {
  it('switching source while the request is in flight does not relabel the still-loading rows', async () => {
    const user = userEvent.setup()
    let resolveKegg!: () => void
    const keggPending = new Promise<void>(resolve => { resolveKegg = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=kegg')) {
        return keggPending.then(() => jsonResponse({
          data: [{ annotation_id: 'K00001', name: 'alcohol dehydrogenase', parent: null, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          sample_count: 128,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'taxonomy' }} />)

    const select = screen.getAllByRole('combobox')[0]
    await user.selectOptions(select, 'kegg')
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    // Switch away from kegg WHILE its request is still pending.
    await user.selectOptions(select, 'cog')

    resolveKegg()
    await waitFor(() => {
      expect(screen.getByText('K00001')).toBeInTheDocument()
    })

    // The audit's own live example: the Hierarchy button's title read
    // "View Bacteria;Proteobacteria in the kegg hierarchy" for rows that
    // were switched to a different source before the button rendered.
    // Real kegg data must say "kegg" here, never "cog" (the live dropdown
    // at the time the stale response landed).
    expect(screen.getByTitle('View K00001 in the kegg hierarchy')).toBeInTheDocument()
    expect(screen.queryByTitle('View K00001 in the cog hierarchy')).not.toBeInTheDocument()

    // CSV export: filename must embed the real (kegg) source, never the
    // live dropdown (cog) that was switched to mid-flight.
    await user.click(screen.getByRole('button', { name: /^↓ CSV$/i }))
    expect(lastDownloadFilename).toBe('top_kegg_annotations.csv')

    // ScaffoldBtn's `source` prop must also be kegg -- confirmed via the
    // opened ScaffoldModal's own source tag.
    await user.click(screen.getByTestId('scaffold-btn'))
    await waitFor(() => {
      expect(screen.getByTestId('source-tag')).toHaveTextContent('kegg')
    })
  })
})

// E1 (docs/AUDIT-2026-10-05.md): the "Based on N samples" date suffix
// below the Top EGC table must describe the request that actually
// produced the displayed rows/sampleCount, not whatever is currently
// sitting in the live date picker -- clearing/editing the date fields
// after loading, without clicking Load again, used to flip just this
// suffix to the live (unloaded) value while sampleCount and the table
// kept describing the real, still-dated request.
describe('ExplorePage — Top EGC date suffix describes what was loaded, not the live picker (E1)', () => {
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

// E8 (docs/AUDIT-2026-10-05.md): the Lookup result list showed only a
// bare mean_egc number, with no (N/128) detection-count disclosure, no
// "mean when detected" tooltip, and no sort-method label -- all three
// of which the Analyze page's own equivalent list (LeftResultList)
// already has, for the same reason: a 9-sample mean and a 128-sample
// mean otherwise look identical, and a sparse detection can outrank a
// fully-detected one with nothing to warn the reader.
describe('ExplorePage — Annotation Lookup detection-count disclosure (E8)', () => {
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
    expect(screen.getByText(/sorted by mean EGC/i)).toBeInTheDocument()
  })
})

describe('ExplorePage — Annotation Lookup source race (W29)', () => {
  it('switching source before the search resolves does not tag the result under the new source', async () => {
    const user = userEvent.setup()
    let resolveKegg!: () => void
    const keggPending = new Promise<void>(resolve => { resolveKegg = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=kegg')) {
        return keggPending.then(() => jsonResponse({
          data: [{ annotation_id: 'K02014', name: 'K02014 protein', parent: null, depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 }],
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
    // (depth 4 = "leaf (KO)"), not cog's (which has no depth-4 entry and
    // would fall back to a bare "4").
    await waitFor(() => {
      expect(document.querySelector('.lookup-meta-value.mono')?.textContent).toContain('leaf (KO)')
    })
  })
})

// W30(a) (docs/AUDIT-2026-09-22.md): a KEGG KO's stored `parent` is
// last-occurrence-wins -- only ONE of its possibly-many real immediate
// parents. The lookup card now fetches /api/kegg/path directly (the same
// real ancestor data the hierarchy popup uses) instead of trusting the
// single stored value.
describe('ExplorePage — Annotation Lookup shows every real KEGG parent (W30a)', () => {
  function mockSearchAndPath(searchRow: object, pathResponse: object | null) {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=kegg')) {
        return Promise.resolve(jsonResponse({ data: [searchRow], total: 1 }))
      }
      if (url.includes('/api/kegg/path')) {
        return pathResponse
          ? Promise.resolve(jsonResponse(pathResponse))
          : Promise.reject(new Error('network error'))
      }
      return Promise.resolve(jsonResponse({}))
    })
  }

  it('shows every real parent for a multi-parent KO, not just the one stored on the row', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      { annotation_id: 'K00844', name: 'HK, hexokinase', parent: '04131', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
      {
        annotation_id: 'K00844',
        path_count: 2,
        paths: [
          [
            { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 1 },
            { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
            { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 3 },
            { annotation_id: 'K00844', name: 'HK, hexokinase', depth: 4 },
          ],
          [
            { annotation_id: '04131', name: 'Membrane trafficking', depth: 1 },
            { annotation_id: '09180', name: 'Brite Hierarchies', depth: 2 },
            { annotation_id: '04131', name: 'Membrane trafficking', depth: 3 },
            { annotation_id: 'K00844', name: 'HK, hexokinase', depth: 4 },
          ],
        ],
      },
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K00844')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    const parentsRow = await screen.findByTestId('lookup-kegg-parents')
    expect(parentsRow).toHaveTextContent('Glycolysis / Gluconeogenesis')
    expect(parentsRow).toHaveTextContent('Membrane trafficking')
    expect(within(parentsRow).getByText('Parents')).toBeInTheDocument() // plural label when there's more than one
  })

  it('shows a single parent without the plural label for a genuinely single-parent KO', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      { annotation_id: 'K00001', name: 'alcohol dehydrogenase', parent: '00010', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
      {
        annotation_id: 'K00001',
        path_count: 1,
        paths: [[
          { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 1 },
          { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
          { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 3 },
          { annotation_id: 'K00001', name: 'alcohol dehydrogenase', depth: 4 },
        ]],
      },
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K00001')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    const parentsRow = await screen.findByTestId('lookup-kegg-parents')
    expect(parentsRow).toHaveTextContent('Glycolysis / Gluconeogenesis')
    expect(within(parentsRow).getByText('Parent')).toBeInTheDocument() // singular, no "s"
  })

  it('shows nothing (not a stale/wrong value) when the real-path fetch fails', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      { annotation_id: 'K00844', name: 'HK, hexokinase', parent: '04131', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
      null,
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K00844')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())
    expect(screen.queryByTestId('lookup-kegg-parents')).toBeNull()
    // The old single-value "Parent" row (driven by r.parent) must also
    // stay suppressed for kegg -- showing it here would be exactly the
    // last-occurrence-wins value this fix exists to stop trusting.
    expect(screen.queryByText('Membrane trafficking')).toBeNull()
  })

  it('a non-kegg source is unaffected -- still shows the single stored parent directly', async () => {
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
    // /api/kegg/path must never be called for a cog lookup.
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/api/kegg/path'))).toBe(false)
    expect(screen.queryByTestId('lookup-kegg-parents')).toBeNull()
  })
})

// E5 (docs/AUDIT-2026-10-05.md): the Category row used to show the single
// stored (last-occurrence-wins, P3) `category` field, directly contradicting
// the (already-fixed, W30a) Parent row beneath it. Live example the audit
// cited: K00134/GAPDH's Category read "Brite Hierarchies" while Parents
// correctly listed Glycolysis among its real pathways. Category now comes
// from the SAME /api/kegg/path response Parents already uses, reading the
// depth-1 (top-level category) end of each real path instead of the
// immediate-parent end.
describe('ExplorePage — Annotation Lookup shows every real KEGG category (E5)', () => {
  function mockSearchAndPath(searchRow: object, pathResponse: object | null) {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=kegg')) {
        return Promise.resolve(jsonResponse({ data: [searchRow], total: 1 }))
      }
      if (url.includes('/api/kegg/path')) {
        return pathResponse
          ? Promise.resolve(jsonResponse(pathResponse))
          : Promise.reject(new Error('network error'))
      }
      return Promise.resolve(jsonResponse({}))
    })
  }

  it('shows every real category for a multi-category-path KO, and never the stale stored value', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      {
        annotation_id: 'K00844', name: 'HK, hexokinase', parent: '04131',
        category: 'Brite Hierarchies', // the stale, last-occurrence-wins stored value
        depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128,
      },
      {
        annotation_id: 'K00844',
        path_count: 2,
        paths: [
          [
            { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 1 },
            { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
            { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 3 },
            { annotation_id: 'K00844', name: 'HK, hexokinase', depth: 4 },
          ],
          [
            { annotation_id: '04131', name: 'Membrane trafficking', depth: 1 },
            { annotation_id: '09180', name: 'Brite Hierarchies', depth: 2 },
            { annotation_id: '04131', name: 'Membrane trafficking', depth: 3 },
            { annotation_id: 'K00844', name: 'HK, hexokinase', depth: 4 },
          ],
        ],
      },
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K00844')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    const categoriesRow = await screen.findByTestId('lookup-kegg-categories')
    expect(categoriesRow).toHaveTextContent('Glycolysis / Gluconeogenesis')
    expect(categoriesRow).toHaveTextContent('Membrane trafficking')
    expect(within(categoriesRow).getByText('Categories')).toBeInTheDocument() // plural when there's more than one

    // The stale stored value must never appear as a Category anywhere on
    // the card -- it does legitimately appear inside the categories row's
    // OWN real data at depth 2 ("Brite Hierarchies" is a real depth-2
    // ancestor on path 2), so this checks the generic single-value
    // Category row specifically stayed suppressed, not that the string
    // never appears at all.
    expect(screen.queryByText('Category')).toBeNull()
  })

  it('shows a single category without the plural label for a genuinely single-category KO', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      { annotation_id: 'K00001', name: 'alcohol dehydrogenase', parent: '00010', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
      {
        annotation_id: 'K00001',
        path_count: 1,
        paths: [[
          { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 1 },
          { annotation_id: '09101', name: 'Carbohydrate metabolism', depth: 2 },
          { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis', depth: 3 },
          { annotation_id: 'K00001', name: 'alcohol dehydrogenase', depth: 4 },
        ]],
      },
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K00001')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    const categoriesRow = await screen.findByTestId('lookup-kegg-categories')
    expect(categoriesRow).toHaveTextContent('Glycolysis / Gluconeogenesis')
    expect(within(categoriesRow).getByText('Category')).toBeInTheDocument() // singular, no "ies"
  })

  it('shows nothing (not a stale/wrong value) when the real-path fetch fails', async () => {
    const user = userEvent.setup()
    mockSearchAndPath(
      {
        annotation_id: 'K00844', name: 'HK, hexokinase', parent: '04131',
        category: 'Brite Hierarchies', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128,
      },
      null,
    )
    render(<Harness initial={{ openSection: 'lookup', lookupSource: 'kegg' }} />)

    await user.type(screen.getByPlaceholderText(/ID \(K02014\)/i), 'K00844')
    await user.click(screen.getByRole('button', { name: /^Search$/i }))

    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())
    expect(screen.queryByTestId('lookup-kegg-categories')).toBeNull()
    // The old single-value "Category" row (driven by the stale stored
    // field) must also stay suppressed for kegg on a fetch failure.
    expect(screen.queryByText('Brite Hierarchies')).toBeNull()
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
    expect(screen.queryByTestId('lookup-kegg-categories')).toBeNull()
    expect(screen.queryByTestId('lookup-cog-categories')).toBeNull()
  })
})

// E5 (cog parity, docs/AUDIT-2026-10-05.md): P4 confirmed the identical bug
// shape for cog -- a COG id's single stored `parent`/`category` field can
// only ever hold ONE of its possibly-many real categories (340 real
// multi-category COGs, e.g. COG0028 real under both E and H). Unlike kegg,
// cog has no separate "parent" vs. "category" distinction (only 2 real
// levels total), so this fixes both rows at once via a single new
// cogCategoryNames row, reading the same /api/cog/path data the hierarchy
// popup already uses -- no new backend endpoint needed, it already existed.
describe('ExplorePage — Annotation Lookup shows every real COG category (E5, cog parity)', () => {
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

// W32 (docs/AUDIT-2026-09-22.md): the lookup card's `name={r.name}` prop on
// ExternalLinks must actually reach the NCBI Taxonomy link -- exercised
// through the real lookup card, not ExternalLinks in isolation (which
// already has its own direct unit coverage in external-links.component.test.tsx).
// `name` deliberately differs from the id's own last `;`-segment so this
// test can tell whether `name` really reached ExternalLinks -- otherwise
// taxonomyAwarePrimaryLabel's id-derived fallback produces the same value
// either way and the test would pass without proving the wiring works.
describe('ExplorePage — Lookup External Databases link (W32)', () => {
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

// A8 (docs/AUDIT-2026-10-05.md): /api/annotations/top previously omitted
// `depth` for kegg/cog/enzyme entirely, so the Top EGC table had no way to
// rank-filter down to real leaf annotations -- since a parent's EGC is the
// sum of its descendants, the unfiltered top list is otherwise dominated by
// branch/rollup nodes. Confirms the rank-filter pills now appear for a
// non-taxonomy source and actually narrow the table by the row's real depth.
describe('ExplorePage — Top EGC rank filter works for non-taxonomy sources (A8)', () => {
  it('filters kegg rows by real depth once it is present on the response', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=kegg')) {
        return Promise.resolve(jsonResponse({
          data: [
            { annotation_id: '09180', name: 'Brite Hierarchies', parent: null, depth: 1, mean_egc: 900, max_egc: 1000, sample_count: 128 },
            { annotation_id: 'K00001', name: 'alcohol dehydrogenase', parent: '00010', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 },
          ],
          sample_count: 128,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'kegg' }} />)

    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    await waitFor(() => {
      expect(screen.getByText('09180')).toBeInTheDocument()
    })
    expect(screen.getByText('K00001')).toBeInTheDocument()

    // Rank pills exist (previously impossible for kegg -- no depth in the
    // response at all) and use a generic "Level N" label, never a
    // taxonomy-specific rung name like "Domain" for a non-taxonomy source.
    expect(screen.getByText('Level 1')).toBeInTheDocument()
    expect(screen.getByText('Level 4')).toBeInTheDocument()

    await user.click(screen.getByText('Level 4'))

    expect(screen.queryByText('09180')).not.toBeInTheDocument()
    expect(screen.getByText('K00001')).toBeInTheDocument()
  })
})

// E6 (docs/AUDIT-2026-10-05.md): the Group column used to show only
// row.parent, the single stored (last-occurrence-wins, P3) value -- live
// example the audit cited: K00134/GAPDH filed under "Exosome" (a rare real
// category) in this table while the (already-fixed, W30a) Lookup card for
// the same KO correctly lists Glycolysis among 9 real parents. Now reuses
// the same bulk /api/kegg/parents lookup AnnotationsByParentPanel already
// calls.
describe('ExplorePage — Top EGC Group column shows every real KEGG parent (E6)', () => {
  function mockTopAndParents(rows: object[], parentsResponse: object | null) {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=kegg')) {
        return Promise.resolve(jsonResponse({ data: rows, sample_count: 128 }))
      }
      if (url.includes('/api/kegg/parents')) {
        return parentsResponse
          ? Promise.resolve(jsonResponse(parentsResponse))
          : Promise.reject(new Error('network error'))
      }
      return Promise.resolve(jsonResponse({}))
    })
  }

  it('discloses "+N more" for a multi-parent KO instead of its single stale stored parent', async () => {
    const user = userEvent.setup()
    mockTopAndParents(
      [{ annotation_id: 'K00134', name: 'GAPDH', parent: '09180', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 }],
      {
        parents: {
          K00134: [
            { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis' },
            { annotation_id: '09180', name: 'Exosome' },
          ],
        },
      },
    )
    render(<Harness initial={{ openSection: 'top-egc', source: 'kegg' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    await waitFor(() => expect(screen.getByText('K00134')).toBeInTheDocument())
    expect(screen.getByText('Glycolysis / Gluconeogenesis (+1 more)')).toBeInTheDocument()
    // The single stale stored parent must not be shown as if it were the
    // KO's whole story.
    expect(screen.queryByText('Exosome')).not.toBeInTheDocument()
  })

  it('shows the plain name with no "+more" suffix for a genuinely single-parent KO', async () => {
    const user = userEvent.setup()
    mockTopAndParents(
      [{ annotation_id: 'K00001', name: 'alcohol dehydrogenase', parent: '00010', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 }],
      { parents: { K00001: [{ annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis' }] } },
    )
    render(<Harness initial={{ openSection: 'top-egc', source: 'kegg' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    await waitFor(() => expect(screen.getByText('K00001')).toBeInTheDocument())
    expect(screen.getByText('Glycolysis / Gluconeogenesis')).toBeInTheDocument()
  })

  it('falls back to the single stored parent and shows a visible warning when /kegg/parents fails', async () => {
    const user = userEvent.setup()
    mockTopAndParents(
      [{ annotation_id: 'K00134', name: 'GAPDH', parent: '09180', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 }],
      null,
    )
    render(<Harness initial={{ openSection: 'top-egc', source: 'kegg' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    await waitFor(() => {
      expect(screen.getByTestId('top-kegg-parents-fetch-failure-warning')).toBeInTheDocument()
    })
    // Fallback: its own stored parent code (09180), resolved the normal way
    // via expandParentLabel/KEGG_BRITE_CODES -- not blank, and not a crash.
    expect(screen.getByText('Brite Hierarchies')).toBeInTheDocument()
  })

  it('retrying after a /kegg/parents failure can recover the real multi-parent disclosure', async () => {
    const user = userEvent.setup()
    let parentsCallCount = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=kegg')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: 'K00134', name: 'GAPDH', parent: '09180', depth: 4, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          sample_count: 128,
        }))
      }
      if (url.includes('/api/kegg/parents')) {
        parentsCallCount++
        if (parentsCallCount === 1) return Promise.reject(new Error('network error'))
        return Promise.resolve(jsonResponse({
          parents: { K00134: [
            { annotation_id: '00010', name: 'Glycolysis / Gluconeogenesis' },
            { annotation_id: '09180', name: 'Exosome' },
          ] },
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'kegg' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    await waitFor(() => {
      expect(screen.getByTestId('top-kegg-parents-fetch-failure-warning')).toBeInTheDocument()
    })

    await user.click(screen.getByTestId('top-kegg-parents-retry-btn'))

    await waitFor(() => expect(screen.getByText('Glycolysis / Gluconeogenesis (+1 more)')).toBeInTheDocument())
    expect(screen.queryByTestId('top-kegg-parents-fetch-failure-warning')).not.toBeInTheDocument()
  })

  it('a non-kegg source is unaffected -- still shows the single stored parent directly', async () => {
    const user = userEvent.setup()
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top') && url.includes('source=cog')) {
        return Promise.resolve(jsonResponse({
          data: [{ annotation_id: 'COG0055', name: 'ATP synthase', parent: 'C', depth: 2, mean_egc: 100, max_egc: 200, sample_count: 128 }],
          sample_count: 128,
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })
    render(<Harness initial={{ openSection: 'top-egc', source: 'cog' }} />)
    await user.click(screen.getByRole('button', { name: /^Load$/i }))

    await waitFor(() => expect(screen.getByText('COG0055')).toBeInTheDocument())
    expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/api/kegg/parents'))).toBe(false)
  })
})
