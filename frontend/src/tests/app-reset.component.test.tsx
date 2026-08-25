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
