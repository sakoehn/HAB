/**
 * scaffold-explore-panel.component.test.tsx
 * ============================================
 * Component tests for the real ScaffoldExplorePanel (Explore page's
 * "Scaffold Information" section) — driving actual render/interaction,
 * not just the pure-logic mirrors in scaffold-explore.unit.test.ts.
 *
 * Coverage
 * --------
 * Empty state & suggestions:
 *   shows the empty-state hint before any terms are loaded
 *   auto-loads top-10 annotations as suggested terms
 *   suggestions are replaced when switching source
 *   "Clear suggestions" removes only suggested terms
 *
 * Search:
 *   typing + Search shows results
 *   Enter key triggers search
 *   clicking a result adds it as a term
 *   already-added result shows "added" and is not re-added on click
 *   search failure shows an error state
 *   empty search result shows "no results" state
 *
 * Add / remove terms:
 *   a term that fails to load shows "failed to load"
 *   × removes a term
 *   "Clear scaffolds" removes all terms
 *
 * Chart controls:
 *   chart appears once a term is ok
 *   Genes / Scaffolds metric toggle
 *   Line / Bar type toggle
 *   Split by term only appears with 2+ terms
 *   CSV export button present
 *
 * Per-term detail table:
 *   expanding a term shows the description + table
 *   collapsing hides it again
 *   per-term "View chart" toggle shows/hides a chart
 *   "View chart" with an empty date range shows "No data" instead of a chart
 *
 * Drill-down detail:
 *   clicking a row loads and shows individual scaffolds
 *   clicking the same row again collapses it
 *   a failed detail fetch shows "Failed to load scaffolds"
 *   "Show all N scaffolds" appears only when > 10 rows
 *
 * Drill-down detail — pagination (2026-07-28, split-collection backend):
 *   detail fetch includes sample= for the clicked row
 *   detail fetch includes page=1 and page_size=500
 *   clicking Show all fetches additional pages when total exceeds what's loaded
 *
 * initialTerms:
 *   pre-loads terms passed in from navigation
 *
 * Run: npx vitest run src/tests/scaffold-explore-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, fireEvent, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { ScaffoldExplorePanel } from '../components/scaffolds/ScaffoldExplorePanel'

// ─────────────────────────────────────────────────────────────────────────────
// Mock fetch
// ─────────────────────────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const TOP_SUGGESTIONS = {
  data: [
    { annotation_id: 'K00001', source: 'kegg', name: 'a', parent: null, mean_egc: 1, max_egc: 1, sample_count: 1 },
  ],
}

const SEARCH_RESULTS = {
  data: [
    { annotation_id: 'COG0055', source: 'cog', name: 'ATP synthase', parent: null, mean_egc: 1, max_egc: 1, sample_count: 1 },
    { annotation_id: 'COG0056', source: 'cog', name: 'ATP synthase B', parent: null, mean_egc: 1, max_egc: 1, sample_count: 1 },
  ],
}

// Unpadded M/D/YY dates — same format the real backend returns — so these
// tests also guard against the earlier date-sort regression.
const SUMMARY_ROWS = {
  data: [
    { sample: 's1', date: '5/9/21 13:00',  scaffold_count: 3, gene_count: 7  },
    { sample: 's2', date: '5/10/21 5:00',  scaffold_count: 5, gene_count: 12 },
    { sample: 's3', date: '5/11/21 8:00',  scaffold_count: 1, gene_count: 2  },
  ],
}

const MANY_DETAIL_ROWS = {
  data: Array.from({ length: 15 }, (_, i) => ({
    sample: 's1', date: '5/9/21 13:00', scaffold: `scaffold_${i}`, count: i + 1,
  })),
  total: 15,
}

function setupMocks(opts: {
  topData?: object
  searchData?: object
  summaryData?: object
  detailData?: object
  summaryFail?: boolean
  detailFail?: boolean
  searchFail?: boolean
} = {}) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/annotations/top'))
      return Promise.resolve({ ok: true, status: 200, json: async () => opts.topData ?? { data: [] } })
    if (url.includes('/api/search/annotations')) {
      if (opts.searchFail) return Promise.reject(new Error('search fail'))
      return Promise.resolve({ ok: true, status: 200, json: async () => opts.searchData ?? SEARCH_RESULTS })
    }
    if (url.includes('/api/annotations/scaffolds/summary')) {
      if (opts.summaryFail) return Promise.reject(new Error('summary fail'))
      return Promise.resolve({ ok: true, status: 200, json: async () => opts.summaryData ?? SUMMARY_ROWS })
    }
    if (url.includes('/api/annotations/scaffolds')) {
      if (opts.detailFail) return Promise.reject(new Error('detail fail'))
      return Promise.resolve({ ok: true, status: 200, json: async () => opts.detailData ?? MANY_DETAIL_ROWS })
    }
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

beforeEach(() => {
  vi.clearAllMocks()
})

afterEach(() => {
  vi.restoreAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// Helpers
// ─────────────────────────────────────────────────────────────────────────────

async function addTermFromSearch(query = 'ATP') {
  const input = screen.getByPlaceholderText(/search annotation id or name/i)
  await userEvent.type(input, query)
  await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
  await waitFor(() => screen.getByText('COG0055'))
  await userEvent.click(screen.getByText('COG0055'))
  await waitFor(() => {
    expect(document.querySelector('.scaffold-summary-card')).toBeTruthy()
  })
}

// ─────────────────────────────────────────────────────────────────────────────
// Empty state & suggestions
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — empty state & suggestions', () => {
  it('shows the empty-state hint before any terms are loaded', () => {
    setupMocks({ topData: { data: [] } })
    render(<ScaffoldExplorePanel />)
    expect(screen.getByText(/Loading top taxonomy annotations…/i)).toBeInTheDocument()
  })

  it('auto-loads top-10 annotations as suggested terms', async () => {
    setupMocks({ topData: TOP_SUGGESTIONS })
    render(<ScaffoldExplorePanel />)
    await waitFor(() => {
      expect(screen.getByText(/Showing top 1 taxonomy annotations by mean EGC/i)).toBeInTheDocument()
    })
    // "K00001" legitimately appears twice — once in the active-terms row,
    // once in the (collapsed) per-term detail toggle button.
    expect(screen.getAllByText('K00001').length).toBeGreaterThan(0)
  })

  it('banner keeps reporting the suggested terms\' real source after the user changes the dropdown (which no longer refreshes them)', async () => {
    // Suggestions load for the default
    // source (taxonomy) -- each suggested term's own `.source` is set from
    // the live searchSrc AT FETCH TIME (addTerm(ann.annotation_id,
    // searchSrc, true)), so it stays "taxonomy" even after the dropdown
    // moves on, because adding a manual term freezes the suggested list
    // (the refresh effect only replaces suggestions when the list is
    // empty/all-suggested). The banner must keep reading the suggested
    // term's own stored source, not the live (now-stale-relative-to-it)
    // dropdown value.
    setupMocks({ topData: TOP_SUGGESTIONS, searchData: SEARCH_RESULTS })
    render(<ScaffoldExplorePanel />)
    await waitFor(() => screen.getByText(/Showing top 1 taxonomy annotations by mean EGC/i))

    // Add a manual term -- this freezes the suggested list.
    await addTermFromSearch()

    // Now switch the live dropdown to a different source. The suggested
    // term itself never changed, so the banner must still say "taxonomy",
    // not the now-current dropdown value.
    await userEvent.selectOptions(screen.getByRole('combobox'), 'cog')
    expect(screen.getByText(/Showing top 1 taxonomy annotations by mean EGC/i)).toBeInTheDocument()
  })

  it('"Clear suggestions" removes only suggested terms', async () => {
    setupMocks({ topData: TOP_SUGGESTIONS })
    render(<ScaffoldExplorePanel />)
    await waitFor(() => screen.getAllByText('K00001').length > 0)
    await userEvent.click(screen.getByText('Clear suggestions'))
    await waitFor(() => {
      expect(screen.queryByText('K00001')).toBeNull()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Search
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — search', () => {
  it('typing a query and clicking Search shows results', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    const input = screen.getByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'ATP')
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => {
      expect(screen.getByText('COG0055')).toBeInTheDocument()
      expect(screen.getByText('COG0056')).toBeInTheDocument()
    })
  })

  it("says when the server returned only part of the matches", async () => {
    setupMocks({ searchData: { data: SEARCH_RESULTS.data, total: 436 } })
    render(<ScaffoldExplorePanel />)
    await userEvent.type(screen.getByPlaceholderText(/search annotation id or name/i), 'ATP{Enter}')
    await waitFor(() => expect(screen.getByText('COG0055')).toBeInTheDocument())
    expect(screen.getByTestId('scaffold-search-count')).toHaveTextContent(
      `first ${SEARCH_RESULTS.data.length} of 436 results`,
    )
  })

  it('asks the server for more than 20 matches', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await userEvent.type(screen.getByPlaceholderText(/search annotation id or name/i), 'ATP{Enter}')
    await waitFor(() => expect(screen.getByText('COG0055')).toBeInTheDocument())
    const searchUrl = mockFetch.mock.calls.map(c => String(c[0])).find(u => u.includes('/api/search/annotations'))!
    expect(Number(new URL(searchUrl, 'http://x').searchParams.get('page_size'))).toBeGreaterThanOrEqual(500)
  })

  it('same-named taxa in the results are told apart', async () => {
    const bosea = (family: string) => ({
      annotation_id: `Bacteria;Proteobacteria;Alphaproteobacteria;Rhizobiales;${family};Bosea`,
      source: 'taxonomy', name: 'Bosea', parent: null, mean_egc: 1, max_egc: 1, sample_count: 1, depth: 6,
    })
    setupMocks({ searchData: { data: [bosea('Boseaceae'), bosea('Bradyrhizobiaceae')], total: 2 } })
    render(<ScaffoldExplorePanel />)
    await userEvent.type(screen.getByPlaceholderText(/search annotation id or name/i), 'Bosea{Enter}')
    expect(await screen.findByText('Bosea · Boseaceae')).toBeInTheDocument()
    expect(screen.getByText('Bosea · Bradyrhizobiaceae')).toBeInTheDocument()
  })

  it('Enter key triggers search', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    const input = screen.getByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'ATP{Enter}')
    await waitFor(() => {
      expect(screen.getByText('COG0055')).toBeInTheDocument()
    })
  })

  it('clicking a result adds it as a tracked term', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    expect(document.querySelector('.scaffold-summary-card')?.textContent).toContain('COG0055')
  })

  it('an already-added result shows "added" and clicking it again is a no-op', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    // Re-run the same search — COG0055 should now show "added"
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => screen.getAllByText('added').length > 0)
    expect(screen.getAllByText('added').length).toBeGreaterThan(0)
  })

  it('search failure shows an error state', async () => {
    setupMocks({ searchFail: true })
    render(<ScaffoldExplorePanel />)
    const input = screen.getByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'ATP')
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => {
      expect(screen.getByText(/Search failed/i)).toBeInTheDocument()
    })
  })

  it('empty search result shows "no results" state', async () => {
    setupMocks({ searchData: { data: [] } })
    render(<ScaffoldExplorePanel />)
    const input = screen.getByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'zzz')
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => {
      expect(screen.getByText(/No results found for "zzz" in taxonomy/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Add / remove terms
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — add/remove terms', () => {
  it('a term that fails to load shows "failed to load"', async () => {
    setupMocks({ summaryFail: true })
    render(<ScaffoldExplorePanel />)
    const input = screen.getByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'ATP')
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => screen.getByText('COG0055'))
    await userEvent.click(screen.getByText('COG0055'))
    await waitFor(() => {
      expect(screen.getByText('failed to load')).toBeInTheDocument()
    })
  })

  it('× removes a term', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    const closeBtn = document.querySelector('.scaffold-summary-card-row .al-card-close') as HTMLElement
    await userEvent.click(closeBtn)
    await waitFor(() => {
      expect(document.querySelector('.scaffold-summary-card')).toBeNull()
    })
  })

  it('"Clear scaffolds" removes all terms', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    await userEvent.click(screen.getByText('✕ Clear scaffolds'))
    await waitFor(() => {
      expect(document.querySelector('.scaffold-summary-card')).toBeNull()
    })
    expect(screen.getByText(/Loading top taxonomy annotations…/i)).toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Chart controls
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — chart controls', () => {
  it('chart card appears once a term is ok', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    await waitFor(() => {
      expect(document.querySelector('.chart-card')).toBeTruthy()
    })
  })

  it('Genes / Scaffolds metric toggle switches the chart title', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    await waitFor(() => screen.getByText('Scaffold count over time'))
    await userEvent.click(screen.getByRole('button', { name: 'Genes' }))
    expect(screen.getByText('Gene count over time')).toBeInTheDocument()
  })

  it('Line / Bar type toggle switches the "on" class', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    await waitFor(() => screen.getByRole('button', { name: 'Bar' }))
    const barBtn = screen.getByRole('button', { name: 'Bar' })
    await userEvent.click(barBtn)
    expect(barBtn.className).toContain('on')
  })

  it('"Split by term" only appears with 2+ terms', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    expect(screen.queryByText('Split by term')).toBeNull()

    // Add a second term
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
    await waitFor(() => screen.getByText('COG0056'))
    await userEvent.click(screen.getByText('COG0056'))
    await waitFor(() => {
      expect(screen.getByText('Split by term')).toBeInTheDocument()
    })
  })

  it('CSV export button is present once a chart is showing', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    await waitFor(() => {
      expect(screen.getAllByText(/↓ CSV/i).length).toBeGreaterThan(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Per-term detail table
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — per-term detail table', () => {
  async function expandTerm() {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    await waitFor(() => document.querySelector('.mappings-toggle'))
    await userEvent.click(document.querySelector('.mappings-toggle') as HTMLElement)
    await waitFor(() => {
      expect(document.querySelector('.expand-anim')).toBeTruthy()
    })
  }

  it('expanding a term shows the description and summary table', async () => {
    await expandTerm()
    expect(screen.getByText(/Each row is one sample/i)).toBeInTheDocument()
    expect(document.querySelector('.scaffold-summary-table')).toBeTruthy()
  })

  it('collapsing hides the detail panel again', async () => {
    await expandTerm()
    await userEvent.click(document.querySelector('.mappings-toggle') as HTMLElement)
    await waitFor(() => {
      expect(screen.queryByText(/Each row is one sample/i)).toBeNull()
    })
  })

  it('per-term "View chart" shows a chart, toggling again hides it', async () => {
    await expandTerm()
    await userEvent.click(screen.getByText('📈 View chart'))
    await waitFor(() => {
      expect(screen.getAllByText('Scaffolds').length).toBeGreaterThan(0)
    })
    await userEvent.click(screen.getByText('▲ Hide chart'))
    expect(screen.getByText('📈 View chart')).toBeInTheDocument()
  })

  it('"View chart" with a date range excluding all rows shows "No data"', async () => {
    setupMocks()
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    // All SUMMARY_ROWS dates are in May 2021 — filter to a range with no data.
    const dateInputs = document.querySelectorAll('.date-field')
    fireEvent.change(dateInputs[0], { target: { value: '2022-01-01' } })
    fireEvent.change(dateInputs[1], { target: { value: '2022-01-02' } })
    await waitFor(() => document.querySelector('.mappings-toggle'))
    await userEvent.click(document.querySelector('.mappings-toggle') as HTMLElement)
    await waitFor(() => screen.getByText('📈 View chart'))
    await userEvent.click(screen.getByText('📈 View chart'))
    await waitFor(() => {
      expect(screen.getByText('No data in the selected date range.')).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down detail
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — drill-down detail', () => {
  async function expandTermAndTable() {
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    await waitFor(() => document.querySelector('.mappings-toggle'))
    await userEvent.click(document.querySelector('.mappings-toggle') as HTMLElement)
    await waitFor(() => document.querySelector('.scaffold-summary-row'))
  }

  it('clicking a row loads and shows individual scaffolds', async () => {
    setupMocks()
    await expandTermAndTable()
    await userEvent.click(document.querySelector('.scaffold-summary-row') as HTMLElement)
    await waitFor(() => {
      expect(screen.getByText(/scaffolds? in this sample/i)).toBeInTheDocument()
    })
    expect(screen.getByText('scaffold_0')).toBeInTheDocument()
  })

  it('clicking the same row again collapses the drill-down', async () => {
    setupMocks()
    await expandTermAndTable()
    const row = document.querySelector('.scaffold-summary-row') as HTMLElement
    await userEvent.click(row)
    await waitFor(() => screen.getByText('scaffold_0'))
    await userEvent.click(row)
    await waitFor(() => {
      expect(screen.queryByText('scaffold_0')).toBeNull()
    })
  })

  it('a failed detail fetch shows "Failed to load scaffolds"', async () => {
    setupMocks({ detailFail: true })
    await expandTermAndTable()
    await userEvent.click(document.querySelector('.scaffold-summary-row') as HTMLElement)
    await waitFor(() => {
      expect(screen.getByText('Failed to load scaffolds.')).toBeInTheDocument()
    })
  })

  it("a slow answer for a sample you've moved away from doesn't replace the open sample's list", async () => {
    setupMocks()
    const base = mockFetch.getMockImplementation()!
    let releaseFirst!: () => void
    let detailCalls = 0
    mockFetch.mockImplementation((url: string) => {
      if (!url.includes('/api/annotations/scaffolds?')) return base(url)
      const sample = new URL(url, 'http://x').searchParams.get('sample')
      const body = { data: [{ sample, date: '5/9/21 13:00', scaffold: `from_${sample}`, count: 1 }], total: 1 }
      const respond = () => ({ ok: true, status: 200, json: async () => body })
      detailCalls += 1
      if (detailCalls === 1) return new Promise(resolve => { releaseFirst = () => resolve(respond()) })
      return Promise.resolve(respond())
    })
    await expandTermAndTable()
    const rows = document.querySelectorAll('.scaffold-summary-row')
    await userEvent.click(rows[0] as HTMLElement)   // slow
    await userEvent.click(rows[1] as HTMLElement)   // fast
    const second = await screen.findByText(/^from_s\d$/)
    const openSample = second.textContent
    releaseFirst()
    await new Promise(r => setTimeout(r, 50))
    expect(screen.getByText(openSample!)).toBeInTheDocument()
    expect(screen.getAllByText(/^from_s\d$/)).toHaveLength(1)
  })

  it('"Show all N scaffolds" appears only when there are more than 10 rows', async () => {
    setupMocks()
    await expandTermAndTable()
    await userEvent.click(document.querySelector('.scaffold-summary-row') as HTMLElement)
    await waitFor(() => {
      expect(screen.getByText('Show all 15 scaffolds ↓')).toBeInTheDocument()
    })
    await userEvent.click(screen.getByText('Show all 15 scaffolds ↓'))
    await waitFor(() => {
      expect(screen.getByText('scaffold_14')).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Drill-down detail — pagination
//
// This is the exact regression the earlier version of this component had:
// the detail fetch downloaded every sample and filtered client-side rather
// than requesting one sample directly. These tests pin the fixed behavior
// down so it can't silently reappear.
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — drill-down pagination', () => {
  async function expandTermAndTable() {
    render(<ScaffoldExplorePanel />)
    await addTermFromSearch()
    await waitFor(() => document.querySelector('.mappings-toggle'))
    await userEvent.click(document.querySelector('.mappings-toggle') as HTMLElement)
    await waitFor(() => document.querySelector('.scaffold-summary-row'))
  }

  it('detail fetch includes sample= for the clicked row', async () => {
    setupMocks()
    await expandTermAndTable()
    await userEvent.click(document.querySelector('.scaffold-summary-row') as HTMLElement)
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(c => c[0] as string)
      expect(calls.some(u => u.includes('/api/annotations/scaffolds?') && u.includes('sample=s1'))).toBe(true)
    })
  })

  it('detail fetch includes page=1 and page_size=500', async () => {
    setupMocks()
    await expandTermAndTable()
    await userEvent.click(document.querySelector('.scaffold-summary-row') as HTMLElement)
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(c => c[0] as string)
      expect(calls.some(u => u.includes('page=1') && u.includes('page_size=500'))).toBe(true)
    })
  })

  it('clicking Show all fetches additional pages when total exceeds what is loaded', async () => {
    let detailCallCount = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => SEARCH_RESULTS })
      if (url.includes('/api/annotations/scaffolds/summary'))
        return Promise.resolve({ ok: true, status: 200, json: async () => SUMMARY_ROWS })
      if (url.includes('/api/annotations/scaffolds')) {
        detailCallCount += 1
        // First page realistically short of `total` — the shape a sample
        // whose scaffold count exceeds one page actually returns.
        const data = detailCallCount === 1
          ? Array.from({ length: 3 }, (_, i) => ({ sample: 's1', date: '5/9/21 13:00', scaffold: `a_${i}`, count: 1 }))
          : Array.from({ length: 9 }, (_, i) => ({ sample: 's1', date: '5/9/21 13:00', scaffold: `b_${i}`, count: 1 }))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data, total: 12 }) })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    await expandTermAndTable()
    await userEvent.click(document.querySelector('.scaffold-summary-row') as HTMLElement)
    await waitFor(() => screen.getByText('Show all 12 scaffolds ↓'))

    await userEvent.click(screen.getByText('Show all 12 scaffolds ↓'))

    await waitFor(() => {
      expect(screen.getByText('b_8')).toBeInTheDocument()
    })
    expect(detailCallCount).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// initialTerms
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — initialTerms', () => {
  it('pre-loads terms passed in from navigation', async () => {
    setupMocks()
    render(
      <ScaffoldExplorePanel
        initialTerms={[{ annotationId: 'COG0055', source: 'cog' }]}
      />,
    )
    await waitFor(() => {
      expect(document.querySelector('.scaffold-summary-card')?.textContent).toContain('COG0055')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// The default "All terms" aggregated view sums every tracked term --
// scaffold/gene counts are hierarchical rollups, so tracking a category (H)
// and one of its own member COGs (COG0055) together would double-count
// COG0055's contribution unless the redundant one is dropped.
// ─────────────────────────────────────────────────────────────────────────────

function mockCogPath(url: string) {
  if (url.includes('/api/cog/path?id=H')) {
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({
        annotation_id: 'H', path_count: 1,
        paths: [[{ annotation_id: 'H', name: 'H', depth: 1 }]],
      }),
    })
  }
  if (url.includes('/api/cog/path?id=COG0055')) {
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => ({
        annotation_id: 'COG0055', path_count: 1,
        paths: [[
          { annotation_id: 'H', name: 'H', depth: 1 },
          { annotation_id: 'COG0055', name: 'COG0055', depth: 2 },
        ]],
      }),
    })
  }
  return null
}

describe('ScaffoldExplorePanel — redundant terms', () => {
  it('drops a redundant descendant from the aggregated "All terms" line and discloses it', async () => {
    mockFetch.mockImplementation((url: string) => {
      const cogPath = mockCogPath(url)
      if (cogPath) return cogPath
      if (url.includes('/api/annotations/scaffolds/summary'))
        return Promise.resolve({ ok: true, status: 200, json: async () => SUMMARY_ROWS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(
      <ScaffoldExplorePanel
        initialTerms={[
          { annotationId: 'H', source: 'cog' },
          { annotationId: 'COG0055', source: 'cog' },
        ]}
      />,
    )

    await waitFor(() => {
      expect(document.querySelectorAll('.scaffold-summary-card-row').length).toBe(2)
    })

    // COG0055's own value is already inside H's -- summing both would
    // double-count it, so it must be left out of the aggregated line.
    await waitFor(() => {
      expect(screen.getByText(/already counted inside another tracked term/i)).toBeInTheDocument()
    })
    expect(screen.getByText('All terms (1)')).toBeInTheDocument()

    // The subtitle below the legend must
    // agree with the legend's own post-redundancy-filter count (1), not
    // recompute its own pre-filter count (2) and contradict the banner
    // right above it that already names COG0055 as dropped.
    expect(screen.getByText(/across all 1 annotations listed below/i)).toBeInTheDocument()
    expect(screen.queryByText(/across all 2 annotations listed below/i)).not.toBeInTheDocument()
  })

  it('does not show the redundancy banner when split by term (nothing gets summed)', async () => {
    mockFetch.mockImplementation((url: string) => {
      const cogPath = mockCogPath(url)
      if (cogPath) return cogPath
      if (url.includes('/api/annotations/scaffolds/summary'))
        return Promise.resolve({ ok: true, status: 200, json: async () => SUMMARY_ROWS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(
      <ScaffoldExplorePanel
        initialTerms={[
          { annotationId: 'H', source: 'cog' },
          { annotationId: 'COG0055', source: 'cog' },
        ]}
      />,
    )
    await waitFor(() => {
      expect(document.querySelectorAll('.scaffold-summary-card-row').length).toBe(2)
    })
    await waitFor(() => {
      expect(screen.getByText(/already counted inside another tracked term/i)).toBeInTheDocument()
    })

    await userEvent.click(screen.getByText('Split by term'))

    expect(screen.queryByText(/already counted inside another tracked term/i)).not.toBeInTheDocument()
    expect(screen.getAllByText('H').length).toBeGreaterThan(0)
    expect(screen.getAllByText('COG0055').length).toBeGreaterThan(0)
  })
})

// Even with no nested terms, two terms can share a scaffold (a scaffold
// carries genes for several COGs/KOs) or a gene (a COG in two categories),
// and the aggregated line counts it once per term. The chart must say so.
describe('ScaffoldExplorePanel — aggregated sums disclose per-term counting', () => {
  it('notes that shared scaffolds/genes count once per term when 2+ terms are summed', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/cog/path?id=H'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ annotation_id: 'H', path_count: 1, paths: [[{ annotation_id: 'H', name: 'H', depth: 1 }]] }) })
      if (url.includes('/api/cog/path?id=E'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ annotation_id: 'E', path_count: 1, paths: [[{ annotation_id: 'E', name: 'E', depth: 1 }]] }) })
      if (url.includes('/api/annotations/scaffolds/summary'))
        return Promise.resolve({ ok: true, status: 200, json: async () => SUMMARY_ROWS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<ScaffoldExplorePanel initialTerms={[{ annotationId: 'H', source: 'cog' }, { annotationId: 'E', source: 'cog' }]} />)

    await waitFor(() => expect(screen.getByText('All terms (2)')).toBeInTheDocument())
    expect(screen.getByTestId('aggregated-overlap-note')).toHaveTextContent(/counted once for each/i)
  })
})
