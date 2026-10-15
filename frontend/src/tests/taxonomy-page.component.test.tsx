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
import { render, screen, fireEvent, waitFor } from '@testing-library/react'

import { TaxonomyPage, makeDefaultTaxonomyState, type TaxonomyState } from '../pages/TaxonomyPage'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

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

describe('TaxonomyPage — W19 failed exclusion fetch', () => {
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

// G5 (docs/AUDIT-2026-10-05.md): a failed series fetch is cached as
// {status: 'error'} with nothing ever evicting it -- the page's own
// fetch effect only fetches a taxon with NO cache entry at all, so
// once that error entry exists it's permanent for the rest of the
// session, with no way to recover from what might be a one-off
// transient failure short of a full page reload.
describe('TaxonomyPage — G5 retry after a failed series fetch', () => {
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
})
