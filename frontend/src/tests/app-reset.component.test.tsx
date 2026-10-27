/**
 * app-reset.component.test.tsx
 * ==============================
 * Tests the per-page reset buttons added alongside the existing global
 * reset button. The whole point of adding them: a user resetting one
 * page's state (e.g. Analyze) should NOT wipe out state they've built up
 * on another page (e.g. an in-progress Explore lookup query) -- that's
 * exactly what the single global reset button currently does, and why it
 * was flagged as too broad.
 *
 * Run: npx vitest run src/tests/app-reset.component.test.tsx
 */

import { describe, it, expect, beforeEach, vi } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const DEFAULT_TIMEPOINTS = { total: 128, data: [] }
const DEFAULT_STATUS  = { index_ready: true, date_min: '2021-05-01', date_max: '2021-06-30' }
const DEFAULT_SEARCH  = {
  data: [{ annotation_id: 'K00001', source: 'kegg', name: 'a', parent: null, mean_egc: 1, max_egc: 1, sample_count: 1 }],
  total: 1,
}
const DEFAULT_SERIES  = { data: [] }

function setupMocks() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/timepoints'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
    if (url.includes('/api/status'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    if (url.includes('/api/search/annotations'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SEARCH })
    if (url.includes('/api/series/annotations'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

let App: React.ComponentType

beforeEach(async () => {
  vi.clearAllMocks()
  setupMocks()
  const module = await import('../App')
  App = module.default
})

describe('per-page reset isolation', () => {
  it("resetting Analyze's own state does not clear Explore's in-progress lookup query", async () => {
    render(<App />)

    // Set some Explore state first: open the Lookup section and type a query.
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const lookupCard = await screen.findByText('Annotation Lookup', { selector: '.explore-card-label' })
    await userEvent.click(lookupCard)
    const lookupInput = await screen.findByPlaceholderText(/ID \(K02014\)/i)
    await userEvent.type(lookupInput, 'siderophore')
    expect(lookupInput).toHaveValue('siderophore')

    // Go to Analyze, run a search, then hit ITS OWN reset button (not the
    // global one) -- title text distinguishes it from the global reset's
    // "Reset all page states".
    await userEvent.click(await screen.findByText('Analyze'))
    const searchInput = await screen.findByPlaceholderText(/e\.g\. iron/i)
    await userEvent.type(searchInput, 'K00001')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => expect(document.querySelector('.al-row-id')).toBeTruthy())

    const analyzeResetBtn = screen.getByTitle('Clear All Results')
    await userEvent.click(analyzeResetBtn)
    await waitFor(() => expect(document.querySelector('.al-row-id')).toBeNull())

    // Explore's lookup query must have survived the Analyze-only reset --
    // openSection is part of exploreState too, so the lookup panel should
    // still be open without needing to click the card again.
    await userEvent.click(await screen.findByText('Explore'))
    const lookupInputAgain = await screen.findByPlaceholderText(/ID \(K02014\)/i)
    expect(lookupInputAgain).toHaveValue('siderophore')
  })
})

describe('App::handleSendToAnalyze (real navigation, not a hand-mocked simulation)', () => {
  it('"View Timeseries in Analyze" from an Explore lookup result lands on Analyze with that id as the only query field', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: [{
              annotation_id: 'K02014', source: 'kegg', name: 'TonB-dependent receptor',
              parent: null, mean_egc: 1, max_egc: 1, sample_count: 1,
            }],
            total: 1,
          }),
        })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<App />)

    // Pre-pollute Analyze state so a stale value surviving the navigation
    // (instead of being reset by the real handleSendToAnalyze) would show
    // up as a visible failure, not just an empty-by-coincidence pass.
    await userEvent.click(await screen.findByText('Analyze'))
    const searchInput = await screen.findByPlaceholderText(/e\.g\. iron/i)
    await userEvent.type(searchInput, 'some-stale-query')

    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const lookupCard = await screen.findByText('Annotation Lookup', { selector: '.explore-card-label' })
    await userEvent.click(lookupCard)
    await userEvent.type(await screen.findByPlaceholderText(/ID \(K02014\)/i), 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /^Search$/i }))
    await waitFor(() => expect(document.querySelector('.lookup-result')).toBeTruthy())

    await userEvent.click(screen.getByRole('button', { name: /View Timeseries in Analyze/i }))

    // Real navigation: lands on Analyze (not still on Explore). Pages stay
    // mounted (hidden, not unmounted) when switching -- the content alone
    // can't prove navigation happened, since it's present either way -- so
    // check the thing that actually changes: the sidebar's active nav item.
    await waitFor(() => {
      const analyzeNavItem = screen.getByText('Analyze', { selector: '.nav-label' }).closest('.nav-item')
      expect(analyzeNavItem).toHaveClass('active')
    })
    const analyzeInputAfterNav = await screen.findByPlaceholderText(/e\.g\. iron/i)
    // Real reset: queryFields is [annotationId], not the stale text typed
    // into Analyze before navigating away, and it's the only field.
    expect(analyzeInputAfterNav).toHaveValue('K02014')
    expect(screen.queryAllByPlaceholderText(/Term \d/i)).toHaveLength(0)

    // ...and the search actually runs, so the user sees the result rather
    // than a pre-filled box and an empty page.
    await waitFor(() => {
      expect(mockFetch.mock.calls.some(([u]) => String(u).includes('/api/search/annotations?q=K02014'))).toBe(true)
      expect(document.querySelector('.al-row-id')?.textContent).toContain('K02014')
    })
  })
})

describe('App::handleGoBulkDownload (real navigation)', () => {
  it('the Taxonomy page shortcut lands on Explore > Bulk Download starting from that scope', async () => {
    const GAMMA = 'Bacteria;Proteobacteria;Gammaproteobacteria'
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ data: [{ annotation_id: GAMMA, source: 'taxonomy', name: 'Gammaproteobacteria', depth: 3 }], total: 1 }),
        })
      if (url.includes('/api/series/export/summary'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ source: 'taxonomy', parent: GAMMA, rank: 'order', taxa: 20, samples: 128, max_rows: 2560, sparse: false }),
        })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<App />)
    await userEvent.click(await screen.findByText('Taxonomy', { selector: '.nav-label' }))
    await userEvent.type(await screen.findByPlaceholderText(/Search for a taxon \(e\.g\. Bacteria\)/), 'Gammaproteobacteria')
    await userEvent.click(screen.getByRole('button', { name: /^Find$/ }))
    await userEvent.click(await screen.findByText('Gammaproteobacteria', { selector: '[title], span, div' }))
    await userEvent.click(await screen.findByRole('button', { name: /Download time series under this scope/ }))

    await waitFor(() => {
      const exploreNavItem = screen.getByText('Explore', { selector: '.nav-label' }).closest('.nav-item')
      expect(exploreNavItem).toHaveClass('active')
    })
    expect(screen.getByTestId('bulk-start')).toHaveTextContent('Bacteria › Proteobacteria › Gammaproteobacteria')
    await waitFor(() => expect(screen.getByTestId('bulk-size')).toHaveTextContent('20 orders'))
  })
})
