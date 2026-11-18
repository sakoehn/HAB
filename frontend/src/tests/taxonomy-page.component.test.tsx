/**
 * taxonomy-page.component.test.tsx
 * ==================================
 * Component test for TaxonomyPage (pages/TaxonomyPage.tsx).
 *
 * Narrow, focused coverage — not a full page test suite. Covers the one
 * gap found when a user asked to jump from the Taxonomy page's chart
 * straight into Scaffold Explore: TaxonomyPage never threaded
 * onGoScaffoldExplore through to its MultiEgcChart the way AnalyzePage,
 * ComparePage, and ExplorePage already do. The underlying show/hide-button
 * and click-behavior logic is already covered generically in
 * scaffold-modal.component.test.tsx; this only proves TaxonomyPage wires
 * the callback through end to end.
 *
 * Run: npx vitest run src/tests/taxonomy-page.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { useState } from 'react'
import { render, screen, fireEvent, waitFor, within } from '@testing-library/react'

import { TaxonomyPage } from '../pages/TaxonomyPage'
import { makeDefaultTaxonomyState, type TaxonomyState } from '../pages/taxonomyState'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const { mockDownloadCsv } = vi.hoisted(() => ({ mockDownloadCsv: vi.fn() }))
vi.mock('../utils/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/api')>()
  return { ...actual, downloadCsv: mockDownloadCsv }
})

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data }
}

beforeEach(() => {
  mockFetch.mockReset()
})

// TaxonomyPage is a controlled component -- it never updates itself, it
// relies on the parent re-rendering it with a new `state` after `setState`
// fires. A no-op setState mock would leave fetchSeries's state update with
// nowhere to go, so the chart would never reach rootStatus 'ok'. This
// wrapper gives it a real, working setState backed by actual React state,
// the same relationship App.tsx has with it in production.
function Wrapper({
  onGoScaffoldExplore,
  initialState,
}: {
  onGoScaffoldExplore: (annotationId: string, source: string) => void
  initialState?:       Partial<TaxonomyState>
}) {
  const [state, setState] = useState<TaxonomyState>({
    ...makeDefaultTaxonomyState(), rootId: 'Bacteria', ...initialState,
  })
  return (
    <TaxonomyPage
      state={state}
      setState={updater => setState(updater)}
      onGoScaffoldExplore={onGoScaffoldExplore}
    />
  )
}

describe('TaxonomyPage — scaffold explore hand-off', () => {
  it('threads onGoScaffoldExplore through to the chart\'s scaffold modal', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria', name: 'Bacteria',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
            value: { egc: 100 },
          }],
        }))
      }
      if (url.includes('/api/annotations/scaffolds/summary')) {
        return Promise.resolve(jsonResponse({
          data: [{ sample: 's1', date: '5/9/21 13:00', scaffold_count: 3, gene_count: 7 }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    const onGoScaffoldExplore = vi.fn()

    render(<Wrapper onGoScaffoldExplore={onGoScaffoldExplore} />)

    // Chart's legend renders a scaffold button per series once the root's
    // series data has loaded (rootStatus 'ok').
    await waitFor(() => expect(screen.getByTestId('scaffold-btn')).toBeTruthy())
    fireEvent.click(screen.getByTestId('scaffold-btn'))

    await waitFor(() => expect(screen.getByTestId('explore-btn')).toBeTruthy())
    fireEvent.click(screen.getByTestId('explore-btn'))

    expect(onGoScaffoldExplore).toHaveBeenCalledWith('Bacteria', 'taxonomy')
  })
})

describe('TaxonomyPage — exclusion series has no scaffold button', () => {
  it('shows a scaffold button for the real root series but not for the synthetic minus-exclusions series', async () => {
    // The "minus" series (annotationId like "Bacteria (minus 1 exclusion)")
    // is a computed line, not a real backend annotation_id -- there's
    // nothing for /annotations/scaffolds to look up for it, so it must
    // not get a scaffold button the way a real series does.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria', name: 'Bacteria',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
            value: { egc: 100 },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          excludedIds: new Set(['Actinobacteria']),
          seriesCache: {
            'Actinobacteria::taxonomy': {
              data: [{
                source: 'taxonomy', sample: 's1', annotation_id: 'Actinobacteria', name: 'Actinobacteria',
                timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
                value: { egc: 20 },
              }],
              status: 'ok',
            },
          },
        }}
      />,
    )

    // Both the full root series and the minus-exclusions series should be
    // in the legend (2 legend items), but only 1 scaffold button.
    await waitFor(() => {
      expect(document.querySelectorAll('.legend-item').length).toBe(2)
    })
    expect(screen.getAllByTestId('scaffold-btn').length).toBe(1)
  })
})

describe('TaxonomyPage — failed exclusion fetch', () => {
  it('shows an explicit error banner instead of silently falling back to the unmodified total', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=Bacteria&')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria', name: 'Bacteria',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
            value: { egc: 1000 },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          excludedIds: new Set(['Bacteria;Actinobacteria']),
          seriesCache: {
            'Bacteria;Actinobacteria::taxonomy': { data: [], status: 'error' },
          },
        }}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/Failed to load 1 exclusion/i)).toBeInTheDocument()
    })
    expect(screen.getByText(/Actinobacteria/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Remove failed exclusion/i })).toBeInTheDocument()
  })

  it('a successfully-loaded exclusion is still applied even when a different one failed', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=Bacteria&')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria', name: 'Bacteria',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
            value: { egc: 1000 },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          excludedIds: new Set(['Bacteria;Actinobacteria', 'Bacteria;Firmicutes']),
          seriesCache: {
            'Bacteria;Actinobacteria::taxonomy': { data: [], status: 'error' },
            'Bacteria;Firmicutes::taxonomy': {
              data: [{
                source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria;Firmicutes', name: 'Firmicutes',
                timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
                value: { egc: 300 },
              }],
              status: 'ok',
            },
          },
        }}
      />,
    )

    // The minus series is still computed with the one exclusion that did
    // load -- the title says "minus 1 exclusion" (Firmicutes), not 0.
    await waitFor(() => {
      expect(screen.getByText(/Failed to load 1 exclusion/i)).toBeInTheDocument()
    })
    expect(document.querySelectorAll('.legend-item').length).toBe(2)
  })

  it('no error banner when every exclusion loads successfully', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=Bacteria&')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria', name: 'Bacteria',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
            value: { egc: 1000 },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          excludedIds: new Set(['Bacteria;Firmicutes']),
          seriesCache: {
            'Bacteria;Firmicutes::taxonomy': {
              data: [{
                source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria;Firmicutes', name: 'Firmicutes',
                timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
                value: { egc: 300 },
              }],
              status: 'ok',
            },
          },
        }}
      />,
    )

    await waitFor(() => {
      expect(document.querySelectorAll('.legend-item').length).toBe(2)
    })
    expect(screen.queryByText(/Failed to load/i)).not.toBeInTheDocument()
  })
})

// A failed series fetch is cached as {status: 'error'}, and the page's own
// fetch effect only fetches a taxon with NO cache entry at all -- so Retry
// must evict that entry, or a one-off transient failure would be permanent
// for the rest of the session.
describe('TaxonomyPage — retry after a failed series fetch', () => {
  it('retrying a failed root series clears the error and loads the real data', async () => {
    let seriesCalls = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=Bacteria&')) {
        seriesCalls++
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria', name: 'Bacteria',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
            value: { egc: 1000 },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          seriesCache: { 'Bacteria::taxonomy': { data: [], status: 'error' } },
        }}
      />,
    )

    expect(screen.getByText(/Failed to load series for Bacteria/i)).toBeInTheDocument()
    // The pre-fix effect never re-fetches an id that already has a cache
    // entry (even an error one) -- confirm nothing has fired yet.
    expect(seriesCalls).toBe(0)

    fireEvent.click(screen.getByRole('button', { name: /^Retry$/i }))

    await waitFor(() => {
      expect(screen.queryByText(/Failed to load series for Bacteria/i)).not.toBeInTheDocument()
    })
    expect(seriesCalls).toBe(1)
    expect(document.querySelectorAll('.legend-item').length).toBe(1)
  })

  it('retrying a failed exclusion clears its error and applies it to the chart', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=Bacteria&')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria', name: 'Bacteria',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
            value: { egc: 1000 },
          }],
        }))
      }
      if (url.includes('annotation_id=Bacteria%3BActinobacteria')) {
        return Promise.resolve(jsonResponse({
          data: [{
            source: 'taxonomy', sample: 's1', annotation_id: 'Bacteria;Actinobacteria', name: 'Actinobacteria',
            timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
            value: { egc: 20 },
          }],
        }))
      }
      return Promise.resolve(jsonResponse({}))
    })

    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          excludedIds: new Set(['Bacteria;Actinobacteria']),
          seriesCache: {
            'Bacteria;Actinobacteria::taxonomy': { data: [], status: 'error' },
          },
        }}
      />,
    )

    await waitFor(() => {
      expect(screen.getByText(/Failed to load 1 exclusion/i)).toBeInTheDocument()
    })
    const retryBtn = screen.getByRole('button', { name: /^Retry$/i })

    fireEvent.click(retryBtn)

    await waitFor(() => {
      expect(screen.queryByText(/Failed to load/i)).not.toBeInTheDocument()
    })
    // Both the root and the now-successfully-retried exclusion are real
    // series -- 2 legend items, exclusion actually applied.
    expect(document.querySelectorAll('.legend-item').length).toBe(2)
  })
})


// UI round 2026-10-14: "Keep only checked" mode -- the same checked set, read
// as an explicit include instead of an exclude.
describe('TaxonomyPage — Remove / Keep-only mode', () => {
  const point = (id: string, egc: number) => ({
    source: 'taxonomy', sample: 's1', annotation_id: id, name: id,
    timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
    value: { egc },
  })
  const cached = (id: string, egc: number) => ({ data: [point(id, egc)], status: 'ok' as const })

  function renderWithTwoChecked() {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations'))
        return Promise.resolve(jsonResponse({ data: [point('Bacteria', 100)] }))
      return Promise.resolve(jsonResponse({ data: [] }))
    })
    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          excludedIds: new Set(['Bacteria;Actinobacteria', 'Bacteria;Bacteroidetes']),
          seriesCache: {
            'Bacteria;Actinobacteria::taxonomy': cached('Bacteria;Actinobacteria', 20),
            'Bacteria;Bacteroidetes::taxonomy':  cached('Bacteria;Bacteroidetes', 30),
          },
        }}
      />,
    )
  }
  const legend = () => [...document.querySelectorAll('.legend-item')].map(e => e.textContent ?? '')

  it('defaults to Remove: heading and line read as today', async () => {
    renderWithTwoChecked()
    await waitFor(() => expect(legend().some(t => t.includes('minus 2 exclusions'))).toBe(true))
    expect(screen.getByRole('heading', { name: /remove branches/i })).toBeInTheDocument()
  })

  it("switching to Keep only shows the kept branches' sum, with the same checked set", async () => {
    renderWithTwoChecked()
    await waitFor(() => expect(legend().some(t => t.includes('minus 2 exclusions'))).toBe(true))
    fireEvent.click(screen.getByLabelText(/keep only checked/i))
    await waitFor(() => expect(legend().some(t => t.includes('Actinobacteria + Bacteroidetes'))).toBe(true))
    expect(legend().some(t => t.includes('minus'))).toBe(false)
    expect(screen.getByRole('heading', { name: /keep branches/i })).toBeInTheDocument()
    // switching back restores the remove line for the same checked set
    fireEvent.click(screen.getByLabelText(/remove checked/i))
    await waitFor(() => expect(legend().some(t => t.includes('minus 2 exclusions'))).toBe(true))
  })

  // A long tree scrolls inside its box; the mode switch and heading must stay
  // in view so the user always sees whether checks remove or keep.
  it('keeps the mode switch and heading in a sticky header above the scrolling tree', async () => {
    renderWithTwoChecked()
    await waitFor(() => expect(legend().some(t => t.includes('minus 2 exclusions'))).toBe(true))
    const header = screen.getByRole('radiogroup', { name: /what checked branches do/i })
      .closest('[data-testid="taxonomy-tree-controls"]') as HTMLElement | null
    expect(header).not.toBeNull()
    expect(header).toHaveStyle({ position: 'sticky' })
    expect(header).toContainElement(screen.getByRole('heading', { name: /remove branches/i }))
    expect(header!.querySelector('.tax-tree, .tax-tree-status')).toBeNull()
  })
})

describe('TaxonomyPage — taxon search shows every match and says how many', () => {
  function taxon(i: number) {
    return { annotation_id: `Bacteria;Taxon${i}`, name: `Taxon${i}`, source: 'taxonomy', depth: 2 }
  }

  async function search(data: object[], total: number) {
    mockFetch.mockImplementation((url: string) =>
      url.includes('/api/search/annotations')
        ? Promise.resolve(jsonResponse({ data, total }))
        : Promise.resolve(jsonResponse({})),
    )
    render(<Wrapper onGoScaffoldExplore={vi.fn()} initialState={{ rootId: null }} />)
    fireEvent.change(screen.getByPlaceholderText(/search for a taxon/i), { target: { value: 'taxon' } })
    fireEvent.click(screen.getByRole('button', { name: 'Find' }))
    return screen.findByTestId('taxonomy-search-count')
  }

  it('lists all 20 matches, not just the first 12, and counts them', async () => {
    const count = await search(Array.from({ length: 20 }, (_, i) => taxon(i)), 20)
    expect(count).toHaveTextContent('20 matching taxa')
    expect(screen.getByText('Taxon19')).toBeInTheDocument()
  })

  it('says when the server returned only part of the matches', async () => {
    const count = await search([taxon(0), taxon(1), taxon(2)], 1234)
    expect(count).toHaveTextContent(/first 3 of 1,234 matching taxa/)
  })
})

describe('TaxonomyPage — rank CSV keeps same-named taxa apart', () => {
  it('writes one row per lineage, with the lineage, so homonyms are not merged', async () => {
    const rows = [
      { taxon: 'Bosea', lineage: 'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Bradyrhizobiaceae;Bosea' },
      { taxon: 'Bosea', lineage: 'Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;Boseaceae;Bosea' },
    ]
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(jsonResponse(url.includes('/api/taxonomy/export') ? rows : {})),
    )
    render(<Wrapper onGoScaffoldExplore={vi.fn()} initialState={{ rootId: null }} />)
    fireEvent.click(screen.getByRole('button', { name: '↓ CSV' }))
    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalled())
    expect(mockDownloadCsv.mock.calls[0][0]).toEqual(rows)
  })
})

describe('TaxonomyPage — labels count and word what the chart actually does', () => {
  const point = (id: string, egc: number) => ({
    source: 'taxonomy', sample: 's1', annotation_id: id, name: id,
    timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime: '2021-05-09T13:00:00' },
    value: { egc },
  })
  const cached = (id: string, egc: number) => ({ data: [point(id, egc)], status: 'ok' as const })
  const legend = () => [...document.querySelectorAll('.legend-item')].map(e => e.textContent ?? '')

  beforeEach(() => {
    mockFetch.mockImplementation((url: string) =>
      Promise.resolve(jsonResponse(url.includes('/api/series/annotations') ? { data: [point('Bacteria', 100)] } : { data: [] })),
    )
  })

  it('a checked branch inside another checked branch is not counted twice', async () => {
    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          excludedIds: new Set(['Bacteria;Actinobacteria', 'Bacteria;Actinobacteria;Actinomycetia']),
          seriesCache: {
            'Bacteria;Actinobacteria::taxonomy':               cached('Bacteria;Actinobacteria', 20),
            'Bacteria;Actinobacteria;Actinomycetia::taxonomy': cached('Bacteria;Actinobacteria;Actinomycetia', 5),
          },
        }}
      />,
    )
    await waitFor(() => expect(legend().some(t => t.includes('minus 1 exclusion'))).toBe(true))
    expect(legend().some(t => t.includes('minus 2'))).toBe(false)
  })

  it('in Keep only mode the failure banner says what is kept, not excluded', async () => {
    render(
      <Wrapper
        onGoScaffoldExplore={vi.fn()}
        initialState={{
          selectionMode: 'keep',
          excludedIds: new Set(['Bacteria;Actinobacteria', 'Bacteria;Bacteroidetes']),
          seriesCache: {
            'Bacteria;Actinobacteria::taxonomy': cached('Bacteria;Actinobacteria', 20),
            'Bacteria;Bacteroidetes::taxonomy':  { data: [], status: 'error' },
          },
        }}
      />,
    )
    const banner = await screen.findByText(/Failed to load 1/i)
    expect(banner.textContent).toMatch(/keeps only the 1/i)
    expect(banner.textContent).not.toMatch(/excludes/i)
  })
})

describe('TaxonomyPage — bulk download shortcut', () => {
  it('hands the current scope to the Bulk Download section', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))
    const onGoBulkDownload = vi.fn()
    const state = { ...makeDefaultTaxonomyState(), rootId: 'Bacteria;Proteobacteria;Gammaproteobacteria' }
    render(
      <TaxonomyPage
        state={state}
        setState={() => {}}
        onGoScaffoldExplore={vi.fn()}
        onGoBulkDownload={onGoBulkDownload}
        onReset={() => {}}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: /Download time series under this scope/ }))
    expect(onGoBulkDownload).toHaveBeenCalledWith('Bacteria;Proteobacteria;Gammaproteobacteria')
  })

  it('has no shortcut before a scope is chosen', () => {
    render(
      <TaxonomyPage
        state={makeDefaultTaxonomyState()}
        setState={() => {}}
        onGoScaffoldExplore={vi.fn()}
        onGoBulkDownload={vi.fn()}
        onReset={() => {}}
      />,
    )
    expect(screen.queryByRole('button', { name: /Download time series under this scope/ })).toBeNull()
  })
})

describe('TaxonomyPage — download the checked taxa', () => {
  const ALPHA = 'Bacteria;Proteobacteria;Alphaproteobacteria'
  const FAMILY_A = `${ALPHA};Holosporales;Holosporaceae`
  const FAMILY_B = `${ALPHA};Caulobacterales;Caulobacteraceae`

  function renderChecked(selectionMode: 'keep' | 'remove', checked: string[]) {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))
    const state = {
      ...makeDefaultTaxonomyState(), rootId: ALPHA, selectionMode, excludedIds: new Set(checked),
    }
    render(<TaxonomyPage state={state} setState={() => {}} onGoScaffoldExplore={vi.fn()} onReset={() => {}} />)
  }
  const form = () => screen.queryByTestId('checked-taxa-download-form') as HTMLFormElement | null

  it('posts exactly the kept taxa to the checked-taxa export, scoped to the page', () => {
    renderChecked('keep', [FAMILY_A, FAMILY_B])
    const f = form()!
    expect(f.getAttribute('method')).toBe('post')
    expect(f.getAttribute('enctype')).toBe('text/plain')
    const action = new URL(f.getAttribute('action')!, 'http://x')
    expect(action.pathname).toBe('/api/series/export/taxa')
    expect(Object.fromEntries(action.searchParams)).toEqual({ parent: ALPHA })
    expect(JSON.parse((f.querySelector('input[name="selection"]') as HTMLInputElement).value))
      .toEqual({ taxa: [FAMILY_A, FAMILY_B] })
    expect(screen.getByRole('button', { name: /Download checked taxa \(2\)/ })).toBeInTheDocument()
  })

  it('leaves out a checked taxon inside another checked one, like the kept line does', () => {
    renderChecked('keep', [`${ALPHA};Holosporales`, FAMILY_A])
    expect(JSON.parse((form()!.querySelector('input[name="selection"]') as HTMLInputElement).value))
      .toEqual({ taxa: [`${ALPHA};Holosporales`] })
    expect(screen.getByRole('button', { name: /Download checked taxa \(1\)/ })).toBeInTheDocument()
  })

  it('its help says a taxon checked inside another checked one is left out, and why', async () => {
    renderChecked('keep', [FAMILY_A])
    fireEvent.click(within(form()!).getByTitle('Help'))
    const help = await screen.findByText(/only the higher one is downloaded/)
    expect(help.textContent).toMatch(/already includes everything under it/)
    expect(help.textContent).toMatch(/check only the families/)
  })

  it('is not offered in Remove mode, where the checked taxa are the ones taken out', () => {
    renderChecked('remove', [FAMILY_A])
    expect(form()).toBeNull()
  })

  it('is not offered before anything is checked', () => {
    renderChecked('keep', [])
    expect(form()).toBeNull()
  })
})
