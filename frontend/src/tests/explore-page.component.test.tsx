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
 *
 * Run: npx vitest run src/tests/explore-page.component.test.tsx
 */

import { useState } from 'react'
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
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
