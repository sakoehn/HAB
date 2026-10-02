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
