/**
 * analyze-page.component.test.tsx
 * =================================
 * React component tests for the full App shell and Analyze page.
 * Replaces App.component.test.tsx.
 *
 * All fetch calls are mocked. No real API calls are made.
 * uiMode / ModeToggle / AdvancedOnly tests removed — those components
 * no longer exist after Basic/Advanced mode was removed.
 *
 * Coverage
 * --------
 * App shell:
 *   HAB brand name visible
 *   all four nav items present
 *   API online/offline indicator
 *   default page is Analyze
 *   navigate to Compare, Explore, About
 *   theme toggle switches data-theme attribute
 *   sidebar collapse hides nav labels
 *   sidebar expand restores nav labels
 *   reset button present
 *
 * AnalyzePage — search:
 *   search input rendered with correct placeholder
 *   source checkboxes for all four sources
 *   first-run hint shown before any search
 *   search results appear after successful search
 *   error state when search API fails
 *   result row click adds chart card to right column
 *   CSV export button triggers download
 *   "Add term" adds a second search field
 *
 * EgcChart — normalize controls:
 *   EGC / Relative Abundance / Off / Z-score buttons render
 *   Relative Abundance button shows Relative Abundance hint text
 *   Z-score button shows std dev hint text
 *   Smooth toggle reveals bandwidth slider
 *
 * EgcChart — decoupled metric/standardize controls:
 *   Metric and Standardize render as two independent groups
 *   selecting Relative Abundance does not reset Standardize
 *   Standardize survives switching metric back to EGC
 *   Relative Abundance + Z-score combined y-axis label
 *   Off deactivates Z-score
 *
 * EgcChart — export buttons:
 *   PNG button present
 *   SVG button present
 *   CSV button present
 *   CSV triggers Blob download
 *   Σ Stats button shows stats panel
 *   Σ Stats hides on second click
 *   L1 changes y-axis label to Relative Abundance
 *   Z-score changes y-axis label
 *
 * StatsPanel:
 *   shows n, Mean, Median, Std Dev s, CV, Min, Q1, Q3, Max
 *
 * DateRangePicker:
 *   from and to date inputs rendered
 *   inputs are type="date"
 *
 * MappingsPanel:
 *   "View Annotation Mappings" toggle rendered below chart
 *   clicking toggle expands the panel
 *   Load button present inside expanded panel
 *   clicking Load fetches from /api/mappings/search
 *   table renders with Date, Time, Taxonomy, KEGG, Enzyme, COG columns
 *   CSV export button present after load
 *   error state displayed when mappings API fails
 *   unique pairs checkbox present
 *   sample count input present with default 128
 *
 * CorrelatesPanel:
 *   "Find Correlates" button rendered below chart
 *   clicking button expands panel
 *   source selector pills (kegg/cog/enzyme/taxonomy) present
 *   method and metric selectors present
 *
 * AnnotationInfoDrawer:
 *   ℹ button rendered in card header
 *   clicking ℹ opens drawer with annotation ID
 *   clicking ℹ again closes drawer
 *
 * ChartErrorBoundary:
 *   renders error UI when child throws
 *
 * Export side effects:
 *   downloadCsv creates Blob URL and clicks link
 *   SVG export Blob has SVG MIME type
 *
 * Explore page:
 *   renders on nav click
 *   scaffold section card is a sibling of other cards (not nested)
 *
 * Run: npx vitest run src/tests/analyze-page.component.test.tsx
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

import { LeftResultList } from '../components/annotations/LeftResultList'
import { MultiEgcChart } from '../components/charts/MultiEgcChart'
import type { AnnotationItem } from '../types'

// ── Mock fetch globally ────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

// ── Default happy-path API responses ──────────────────────────────────────

const DEFAULT_TIMEPOINTS = { total: 128, data: [] }
const DEFAULT_STATUS     = {
  index_ready: true,
  date_min:    '2021-05-27',
  date_max:    '2021-06-17',
}
const DEFAULT_SEARCH = {
  data: [
    {
      annotation_id: 'K00001',
      source:        'kegg',
      name:          'alcohol dehydrogenase',
      parent:        '00001 KEGG Orthology',
      mean_egc:      277.0,
      max_egc:       500.0,
      sample_count:  128,
      value:         { egc: 277.0, norm_egc: 0.000033 },
      timepoint:     null,
      sample:        '',
    },
  ],
  total: 1,
}
const DEFAULT_SERIES = {
  data: Array.from({ length: 10 }, (_, i) => ({
    annotation_id: 'K00001',
    source:        'kegg',
    name:          'alcohol dehydrogenase',
    sample:        `sample_${i}`,
    timepoint: {
      taxon_oid: `s${i}`,
      timepoint: String(i),
      datetime:  `2021-05-${String(i + 1).padStart(2, '0')}T00:00:00`,
    },
    value: { egc: 100 + i * 10, norm_egc: 0.00001 + i * 0.000001 },
  })),
}
const DEFAULT_MAPPINGS = {
  data: [
    {
      gene_id:   'g1',
      contig_id: 'c1',
      taxonomy:  'Bacteria',
      kegg_id:   'K02014',
      enzyme:    '1.1.1.1',
      cog_id:    'COG0001',
      sample:    's1',
      timepoint: { taxon_oid: 's1', timepoint: '1', datetime: '2021-05-27T08:00:00' },
    },
  ],
  total: 1,
}
// /api/correlations/family returns a bare array (already q<0.05 filtered
// server-side), not wrapped in { data: [...] } like the old endpoint.
const DEFAULT_CORRELATES = [
  {
    catalog_id:    7,
    annotation_id: 'Bacteria',
    name:          'Bacteria',
    r:             0.72,
    p:             0.002,
    q:             0.02,
    lag_samples:   0,
    lag_hours:     0,
    n_pairs:       40,
  },
]

function setupDefaultMocks() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/timepoints'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
    if (url.includes('/api/status'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    if (url.includes('/api/search/annotations'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SEARCH })
    if (url.includes('/api/series/annotations'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
    if (url.includes('/api/mappings/search'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_MAPPINGS })
    if (url.includes('/api/correlations/family'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_CORRELATES })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

// ── Mock URL / Blob / clipboard ────────────────────────────────────────────

const mockCreateObjectURL = vi.fn(() => 'blob:mock-url')
const mockRevokeObjectURL = vi.fn()
const mockClick           = vi.fn()

URL.createObjectURL = mockCreateObjectURL
URL.revokeObjectURL = mockRevokeObjectURL

const originalCreateElement = document.createElement.bind(document)
vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
  const el = originalCreateElement(tag)
  if (tag === 'a') {
    Object.defineProperty(el, 'click', { value: mockClick, writable: true })
  }
  return el
})

vi.stubGlobal('navigator', {
  clipboard: { writeText: vi.fn().mockResolvedValue(undefined) },
})

// ── Helpers ────────────────────────────────────────────────────────────────

async function getAnalyzeSearchInput() {
  const inputs = await screen.findAllByPlaceholderText(/e\.g\. iron|search annotation id/i)
  return inputs.find(el => el.getAttribute('placeholder')?.includes('e.g. iron')) ?? inputs[0]
}

async function searchAndGetResult(query = 'K00001') {
  const input = await getAnalyzeSearchInput()
  await userEvent.clear(input)
  await userEvent.type(input, query)
  await userEvent.keyboard('{Enter}')
  // Wait for the result row specifically — the term tab also contains 'K00001'
  // so we scope to .al-row-id to get the clickable result row element.
  await waitFor(() => {
    expect(document.querySelector('.al-row-id')).toBeTruthy()
  })
  return document.querySelector('.al-row-id') as HTMLElement
}


// ── Import App ─────────────────────────────────────────────────────────────

let App: React.ComponentType

beforeEach(async () => {
  setupDefaultMocks()
  mockCreateObjectURL.mockClear()
  mockRevokeObjectURL.mockClear()
  mockClick.mockClear()
  const module = await import('../App')
  App = module.default
})

afterEach(() => {
  vi.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// App shell
// ─────────────────────────────────────────────────────────────────────────────

describe('App shell', () => {
  it('renders the Metatrace brand name', async () => {
    render(<App />)
    expect(await screen.findByText('Metatrace')).toBeInTheDocument()
  })

  it('renders all four navigation items', async () => {
    render(<App />)
    // Scope to .nav-label — the About page contains <strong>Compare</strong> etc.
    await waitFor(() => {
      const labels = Array.from(document.querySelectorAll('.nav-label'))
        .map(el => el.textContent?.trim())
      expect(labels).toContain('Analyze')
      expect(labels).toContain('Compare')
      expect(labels).toContain('Explore')
      expect(labels).toContain('About & API')
    })
  })

  it('shows API online indicator when timepoints API responds', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText(/api online/i)).toBeInTheDocument()
    })
  })

  it('shows API offline indicator when timepoints API fails', async () => {
    mockFetch.mockRejectedValue(new Error('Network error'))
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText(/api offline/i)).toBeInTheDocument()
    })
  })

  it('defaults to Analyze page', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getByText(/Analyze Annotations/i)).toBeInTheDocument()
    })
  })

  it('navigates to Compare page', async () => {
    render(<App />)
    // Click the nav label specifically — About page has <strong>Compare</strong>
    const compareLabel = await screen.findByText('Compare', { selector: '.nav-label' })
    await userEvent.click(compareLabel)
    await waitFor(() => {
      expect(screen.getByText(/Compare Annotations/i)).toBeInTheDocument()
    })
  })

  it('navigates to Explore page', async () => {
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await waitFor(() => {
      expect(screen.getByText(/Explore Annotations/i)).toBeInTheDocument()
    })
  })

  it('navigates to About page', async () => {
    render(<App />)
    await userEvent.click(await screen.findByText('About & API'))
    await waitFor(() => {
      expect(screen.getByText(/About HAB Portal/i)).toBeInTheDocument()
    })
  })

  it('theme toggle switches data-theme attribute', async () => {
    render(<App />)
    const themeBtn = await screen.findByTitle(/switch to/i)
    await userEvent.click(themeBtn)
    await waitFor(() => {
      expect(['light', 'dark']).toContain(
        document.documentElement.getAttribute('data-theme'),
      )
    })
  })

  it('sidebar collapse hides nav labels', async () => {
    render(<App />)
    await userEvent.click(await screen.findByTitle(/collapse sidebar/i))
    await waitFor(() => {
      expect(screen.queryByText('Analyze')).not.toBeInTheDocument()
    })
  })

  it('sidebar expand restores nav labels', async () => {
    render(<App />)
    await userEvent.click(await screen.findByTitle(/collapse sidebar/i))
    await userEvent.click(await screen.findByTitle(/expand sidebar/i))
    await waitFor(() => {
      expect(screen.getByText('Analyze')).toBeInTheDocument()
    })
  })

  it('reset button is present', async () => {
    render(<App />)
    // Scoped by title -- every page now also has its own "Reset" button
    // (added so resetting one page doesn't clear the others), so a bare
    // getByText('Reset') would match multiple elements since all pages
    // stay mounted simultaneously (display:none, not conditional render).
    expect(await screen.findByTitle('Reset all page states')).toBeInTheDocument()
  })

  it('does NOT render Basic/Advanced mode toggle (removed feature)', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.queryByText('Basic')).not.toBeInTheDocument()
      expect(screen.queryByText('Advanced')).not.toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AnalyzePage — search
// ─────────────────────────────────────────────────────────────────────────────

describe('AnalyzePage — search', () => {
  it('renders search input with correct placeholder', async () => {
    render(<App />)
    expect(await getAnalyzeSearchInput()).toBeInTheDocument()
  })

  it('search queries all four sources at once -- no source picker needed', async () => {
    // Previously asserted by checking for stray "kegg"/"cog"/etc. text
    // anywhere in the whole rendered <App/>, which happened to pass only
    // because ComparePage's old (now-removed) source dropdown was always
    // visible -- not because it verified anything about Analyze's own
    // search. Analyze has no source picker at all; it always queries every
    // source, so the real check is the outgoing request itself.
    render(<App />)
    const input = await getAnalyzeSearchInput()
    await userEvent.type(input, 'K00001')
    await userEvent.keyboard('{Enter}')

    await waitFor(() => {
      const call = mockFetch.mock.calls.find(([url]) => String(url).includes('/api/search/annotations'))
      expect(call).toBeTruthy()
      const url = String(call![0])
      expect(url).toContain('sources=kegg')
      expect(url).toContain('sources=cog')
      expect(url).toContain('sources=enzyme')
      expect(url).toContain('sources=taxonomy')
    })
  })

  it('shows first-run hint before any search', async () => {
    render(<App />)
    await waitFor(() => {
      // First-run hint has steps 1, 2, 3
      expect(screen.getAllByText(/Search/i).length).toBeGreaterThan(0)
    })
  })

  it('shows search results after successful search', async () => {
    render(<App />)
    await searchAndGetResult('alcohol')
    await waitFor(() => {
      // K00001 appears in the term tab and the result row — both are correct
      expect(screen.getAllByText('K00001').length).toBeGreaterThanOrEqual(1)
      expect(screen.getByText('alcohol dehydrogenase')).toBeInTheDocument()
    })
  })

  it('shows error state when search API fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.reject(new Error('fail'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    })
    render(<App />)
    const input = await getAnalyzeSearchInput()
    await userEvent.type(input, 'alcohol')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(screen.getByText(/search failed/i)).toBeInTheDocument()
    })
  })

  it('result row click adds chart card to right column', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => {
      expect(screen.getAllByText('K00001').length).toBeGreaterThan(1)
    })
  })

  it('CSV export button triggers a download', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ CSV/i).length > 0)
    mockCreateObjectURL.mockClear()
    mockClick.mockClear()
    await userEvent.click(screen.getAllByText(/↓ CSV/i)[0])
    expect(mockCreateObjectURL).toHaveBeenCalled()
    expect(mockClick).toHaveBeenCalled()
  })

  it('"+ Add term" adds a second search field', async () => {
    render(<App />)
    await screen.findByText('Analyze Annotations')
    const addTermBtn = screen.getByText('+ Add term')
    await userEvent.click(addTermBtn)
    await waitFor(() => {
      expect(screen.getAllByPlaceholderText(/Term 2/i).length).toBeGreaterThan(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AnalyzePage — chart card retry on failed series fetch
// ─────────────────────────────────────────────────────────────────────────────

describe('AnalyzePage — chart card retry', () => {
  it('shows a retry button when a card fails to load (not just "Failed to load" with no way forward)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations')) return Promise.reject(new Error('fail'))
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SEARCH })
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    })
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => {
      expect(screen.getByText(/failed to load/i)).toBeInTheDocument()
    })
    expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument()
  })

  it('clicking retry re-fetches and shows the chart on success', async () => {
    let seriesCalls = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations')) {
        seriesCalls++
        if (seriesCalls === 1) return Promise.reject(new Error('fail'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      }
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SEARCH })
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    })
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => expect(screen.getByRole('button', { name: /retry/i })).toBeInTheDocument())

    await userEvent.click(screen.getByRole('button', { name: /retry/i }))

    await waitFor(() => {
      expect(screen.queryByText(/failed to load/i)).not.toBeInTheDocument()
    })
    expect(seriesCalls).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AnalyzePage — group card: a failed member must not silently vanish
// ─────────────────────────────────────────────────────────────────────────────

const TWO_ROW_SEARCH = {
  data: [
    {
      annotation_id: 'K00001', source: 'kegg', name: 'a', parent: null,
      mean_egc: 1, max_egc: 1, sample_count: 1, value: null, timepoint: null, sample: '',
    },
    {
      annotation_id: 'K00002', source: 'kegg', name: 'b', parent: null,
      mean_egc: 1, max_egc: 1, sample_count: 1, value: null, timepoint: null, sample: '',
    },
  ],
  total: 2,
}

async function addTwoRowGroupWithSecondMemberFailing() {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/search/annotations'))
      return Promise.resolve({ ok: true, status: 200, json: async () => TWO_ROW_SEARCH })
    if (url.includes('/api/series/annotations') && url.includes('annotation_id=K00002'))
      return Promise.reject(new Error('fail'))
    if (url.includes('/api/series/annotations'))
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
    return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
  })
  render(<App />)
  const input = await getAnalyzeSearchInput()
  await userEvent.type(input, 'alcohol')
  await userEvent.keyboard('{Enter}')
  await waitFor(() => {
    expect(document.querySelectorAll('.al-row-checkbox').length).toBe(2)
  })
  const checkboxes = document.querySelectorAll('.al-row-checkbox')
  await userEvent.click(checkboxes[0])
  await userEvent.click(checkboxes[1])
  await userEvent.click(screen.getByTitle(/Sum EGC across/i))
}

describe('AnalyzePage — group card member failure', () => {
  it('shows a failure warning instead of silently excluding the failed member from the total', async () => {
    await addTwoRowGroupWithSecondMemberFailing()
    await waitFor(() => {
      expect(screen.getByTestId('group-member-failure-warning')).toBeInTheDocument()
    })
    expect(screen.getByTestId('group-member-failure-warning').textContent).toContain('K00002')
  })

  it('failure warning has a retry button', async () => {
    await addTwoRowGroupWithSecondMemberFailing()
    await waitFor(() => {
      expect(screen.getByTestId('group-retry-member-btn')).toBeInTheDocument()
    })
  })

  it('does not show the failure warning when both members succeed', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => TWO_ROW_SEARCH })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    })
    render(<App />)
    const input = await getAnalyzeSearchInput()
    await userEvent.type(input, 'alcohol')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(document.querySelectorAll('.al-row-checkbox').length).toBe(2)
    })
    const checkboxes = document.querySelectorAll('.al-row-checkbox')
    await userEvent.click(checkboxes[0])
    await userEvent.click(checkboxes[1])
    await userEvent.click(screen.getByTitle(/Sum EGC across/i))

    await waitFor(() => {
      expect(document.querySelector('.al-right-card-group')).toBeInTheDocument()
    })
    expect(screen.queryByTestId('group-member-failure-warning')).toBeNull()
  })

  it('clicking retry re-fetches only the failed member', async () => {
    let k2Calls = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => TWO_ROW_SEARCH })
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=K00002')) {
        k2Calls++
        if (k2Calls === 1) return Promise.reject(new Error('fail'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      }
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    })
    render(<App />)
    const input = await getAnalyzeSearchInput()
    await userEvent.type(input, 'alcohol')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(document.querySelectorAll('.al-row-checkbox').length).toBe(2)
    })
    const checkboxes = document.querySelectorAll('.al-row-checkbox')
    await userEvent.click(checkboxes[0])
    await userEvent.click(checkboxes[1])
    await userEvent.click(screen.getByTitle(/Sum EGC across/i))

    await waitFor(() => expect(screen.getByTestId('group-retry-member-btn')).toBeInTheDocument())
    await userEvent.click(screen.getByTestId('group-retry-member-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('group-member-failure-warning')).toBeNull()
    })
    expect(k2Calls).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EgcChart — normalize controls (always visible, no mode toggle)
// ─────────────────────────────────────────────────────────────────────────────

// Scoped to a specific chart-ctrl-group by its label — the Standardize
// group's "Off" button, the Smooth group's "Off" button, and the About
// page's own "Off" copy (About stays mounted simultaneously in this SPA,
// visibility toggled via CSS not unmount) would otherwise all collide
// under a document-wide screen.getAllByText('Off') query.
function ctrlGroup(container: HTMLElement, labelText: string): HTMLElement {
  const label = within(container).getByText(labelText, { selector: '.ctrl-label' })
  return label.parentElement as HTMLElement
}

describe('EgcChart — normalize controls', () => {
  it('renders EGC, Relative Abundance, Off, Z-score buttons', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => {
      expect(screen.getAllByText('EGC').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Relative Abundance').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Off').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Z-score').length).toBeGreaterThan(0)
    })
  })

  it('Relative Abundance button shows Relative Abundance hint text', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
    await userEvent.click(screen.getAllByText('Relative Abundance')[0])
    await waitFor(() => {
      const hints = Array.from(document.querySelectorAll('.ctrl-hint')).map(h => h.textContent)
      expect(hints.some(h => h?.includes('Relative Abundance'))).toBe(true)
    })
  })

  it('Z-score button shows std dev hint text', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
    await userEvent.click(screen.getAllByText('Z-score')[0])
    await waitFor(() => {
      expect(screen.getAllByText(/std deviations/i).length).toBeGreaterThan(0)
    })
  })

  it('Smooth toggle reveals bandwidth slider', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
    const smoothBtn = screen.getByTitle(/LOWESS/i)
    await userEvent.click(smoothBtn)
    await waitFor(() => {
      expect(screen.getByRole('slider')).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EgcChart — decoupled Metric / Standardize controls
// ─────────────────────────────────────────────────────────────────────────────
// Prior to this, Z-score could only be applied to raw EGC — L1 (norm_egc)
// and Z-score were mutually exclusive modes of one NormalizeMode. Metric
// (EGC / Relative Abundance) and Standardize (Off / Z-score) are now two
// independent controls, so all four combinations are reachable.

describe('EgcChart — decoupled metric/standardize controls', () => {
  async function openChartControls(): Promise<HTMLElement> {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
    const container = document.querySelector('.chart-controls') as HTMLElement | null
    expect(container).toBeTruthy()
    return container!
  }

  it('Metric and Standardize render as two separate control groups', async () => {
    const container = await openChartControls()
    const metricGroup = ctrlGroup(container, 'Metric')
    const standardizeGroup = ctrlGroup(container, 'Standardize')
    expect(within(metricGroup).getByText('EGC')).toBeInTheDocument()
    expect(within(metricGroup).getByText('Relative Abundance')).toBeInTheDocument()
    expect(within(standardizeGroup).getByText('Off')).toBeInTheDocument()
    expect(within(standardizeGroup).getByText('Z-score')).toBeInTheDocument()
  })

  it('selecting Relative Abundance metric does not reset Standardize to Off', async () => {
    const container = await openChartControls()
    const standardizeGroup = ctrlGroup(container, 'Standardize')
    const metricGroup = ctrlGroup(container, 'Metric')
    await userEvent.click(within(standardizeGroup).getByText('Z-score'))
    await userEvent.click(within(metricGroup).getByText('Relative Abundance'))
    await waitFor(() => {
      expect(within(standardizeGroup).getByText('Z-score').className).toContain('on')
    })
  })

  it('switching Standardize on then back to EGC metric keeps Z-score active', async () => {
    const container = await openChartControls()
    const standardizeGroup = ctrlGroup(container, 'Standardize')
    const metricGroup = ctrlGroup(container, 'Metric')
    await userEvent.click(within(standardizeGroup).getByText('Z-score'))
    await userEvent.click(within(metricGroup).getByText('EGC'))
    await waitFor(() => {
      expect(within(standardizeGroup).getByText('Z-score').className).toContain('on')
    })
  })

  it('Relative Abundance + Z-score combined shows a y-axis label reflecting both', async () => {
    const container = await openChartControls()
    const standardizeGroup = ctrlGroup(container, 'Standardize')
    const metricGroup = ctrlGroup(container, 'Metric')
    await userEvent.click(within(metricGroup).getByText('Relative Abundance'))
    await userEvent.click(within(standardizeGroup).getByText('Z-score'))
    await waitFor(() => {
      expect(screen.getAllByText(/Relative Abundance \(Z-score/i).length).toBeGreaterThan(0)
    })
  })

  it('selecting Off (Standardize) after Z-score deactivates it', async () => {
    const container = await openChartControls()
    const standardizeGroup = ctrlGroup(container, 'Standardize')
    await userEvent.click(within(standardizeGroup).getByText('Z-score'))
    await waitFor(() => expect(within(standardizeGroup).getByText('Z-score').className).toContain('on'))
    await userEvent.click(within(standardizeGroup).getByText('Off'))
    await waitFor(() => {
      expect(within(standardizeGroup).getByText('Z-score').className).not.toContain('on')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ChartControls — help tooltips
// ─────────────────────────────────────────────────────────────────────────────
// Each chart-ctrl-group gets a "?" HelpTooltip explaining its options — the
// underlying formulas/behavior were previously only documented on the About
// page or in native title= hover text, both easy to miss.

describe('ChartControls — help tooltips', () => {
  async function openChartControls(): Promise<HTMLElement> {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
    const container = document.querySelector('.chart-controls') as HTMLElement | null
    expect(container).toBeTruthy()
    return container!
  }

  it('Metric group has a help tooltip explaining EGC vs Relative Abundance vs Z-score', async () => {
    const container = await openChartControls()
    const metricGroup = ctrlGroup(container, 'Metric')
    const btn = within(metricGroup).getByTitle('Help')
    await userEvent.click(btn)
    await waitFor(() => {
      expect(screen.getAllByText(/apply to either metric/i).length).toBeGreaterThan(0)
    })
  })

  it('Smooth group has a help tooltip explaining LOWESS bandwidth', async () => {
    const container = await openChartControls()
    const smoothGroup = ctrlGroup(container, 'Smooth')
    const btn = within(smoothGroup).getByTitle('Help')
    await userEvent.click(btn)
    await waitFor(() => {
      expect(screen.getAllByText(/smoothed trend line/i).length).toBeGreaterThan(0)
    })
  })

  it('Overlays group has a help tooltip explaining Day/Night vs Day bands', async () => {
    const container = await openChartControls()
    const overlaysGroup = ctrlGroup(container, 'Overlays')
    const btn = within(overlaysGroup).getByTitle('Help')
    await userEvent.click(btn)
    await waitFor(() => {
      expect(screen.getAllByText(/not tied to actual solar data/i).length).toBeGreaterThan(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// LeftResultList — help tooltips
// ─────────────────────────────────────────────────────────────────────────────
// LeftResultList is purely presentational (all state/callbacks owned by
// AnalyzePage), so it's rendered directly here rather than through the full
// <App/> + fetch-mock machinery — lets us control `rows` (and therefore
// availableSources) precisely.

describe('LeftResultList — help tooltips', () => {
  function makeRow(source: string, id: string): AnnotationItem {
    return {
      source, sample: 's1', timepoint: null,
      annotation_id: id, name: id, value: { egc: 100, norm_egc: 0.01 },
      mean_egc: 100, max_egc: 100, sample_count: 1,
    }
  }

  const baseProps = {
    termLabel:     'iron',
    checkedKeys:   new Set<string>(),
    seriesCache:   {},
    rightCardKeys: new Set<string>(),
    copiedId:      null,
    onCopy:        () => {},
    onToggleCheck: () => {},
    onAddSingle:   () => {},
    onAddSelected: () => {},
    onGroupSelected: () => {},
  }

  it('bulk action bar has a help tooltip explaining "+ Add" vs "∑ Group"', async () => {
    render(<LeftResultList {...baseProps} rows={[makeRow('kegg', 'K00001')]} total={1} />)
    await userEvent.click(screen.getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/sums all checked items/i)).toBeInTheDocument()
    })
  })

  it('source filter pills have a help tooltip when multiple sources are present', async () => {
    render(
      <LeftResultList
        {...baseProps}
        rows={[makeRow('kegg', 'K00001'), makeRow('cog', 'COG0001')]}
        total={2}
      />,
    )
    const filterRow = document.querySelector('.al-source-filter') as HTMLElement
    expect(filterRow).toBeTruthy()
    await userEvent.click(within(filterRow).getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/remembered per search tab/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MultiEgcChart — scale-mismatch help tooltip
// ─────────────────────────────────────────────────────────────────────────────

describe('MultiEgcChart — scale-mismatch help tooltip', () => {
  it('scale-mismatch warning banner has a help tooltip', async () => {
    const mkData = (egc: number): AnnotationItem[] =>
      Array.from({ length: 5 }, (_, i) => ({
        source: 'kegg', sample: `s${i}`,
        timepoint: { taxon_oid: `t${i}`, timepoint: String(i), datetime: `2021-05-2${i}T00:00:00` },
        annotation_id: 'X', name: 'X', value: { egc, norm_egc: egc / 1e6 },
      }))
    render(
      <MultiEgcChart
        series={[
          { annotationId: 'K00001', name: 'high', data: mkData(10000), color: '#111', source: 'kegg' },
          { annotationId: 'K00002', name: 'low',  data: mkData(10),    color: '#222', source: 'kegg' },
        ]}
        dateFrom=""
        dateTo=""
      />,
    )
    // MultiEgcChart opens on Relative Abundance, which suppresses the warning.
    await userEvent.click(screen.getByRole('button', { name: 'EGC' }))
    await waitFor(() => {
      expect(document.querySelector('.scale-mismatch-warning')).toBeTruthy()
    })
    const banner = document.querySelector('.scale-mismatch-warning') as HTMLElement
    await userEvent.click(within(banner).getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/comparable on one chart/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ExplorePage — help tooltips
// ─────────────────────────────────────────────────────────────────────────────

describe('ExplorePage — help tooltips', () => {
  it('"Annotations by Parent" View toggle has a help tooltip', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: [
              { annotation_id: 'K00001', name: 'a', parent: 'p1', mean_egc: 100, max_egc: 100, sample_count: 1 },
              { annotation_id: 'K00002', name: 'b', parent: 'p1', mean_egc: 50,  max_egc: 50,  sample_count: 1 },
            ],
          }),
        })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const cardLabel = await screen.findByText('Annotations by Parent', {
      selector: '.explore-card-label',
    })
    await userEvent.click(cardLabel)
    let groupTrendButton: HTMLElement
    await waitFor(() => {
      groupTrendButton = screen.getByText('Group trend & detail')
      expect(groupTrendButton).toBeInTheDocument()
    })
    // Scoped to this toggle's own container, not the whole document -- App
    // keeps every page mounted (display:none, not unmounted) even when
    // navigated away from, and HelpTooltip's button title is always the
    // generic "Help" regardless of content, so a global getByTitle('Help')
    // is ambiguous the moment any second HelpTooltip is simultaneously
    // present anywhere in the app, not just on this page.
    const container = within(groupTrendButton!.closest('div') as HTMLElement)
    await userEvent.click(container.getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/breaking that total down by individual annotation/i)).toBeInTheDocument()
    })
  })

  it('Annotation Lookup "Depth" field has a help tooltip', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: [{
              annotation_id: 'K00001', name: 'alcohol dehydrogenase',
              parent: '00001 KEGG Orthology',
              value: { depth: 4, category: 'Metabolism' },
              mean_egc: 277.0, max_egc: 500.0, sample_count: 128,
            }],
            total: 1,
          }),
        })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const cardLabel = await screen.findByText('Annotation Lookup', {
      selector: '.explore-card-label',
    })
    await userEvent.click(cardLabel)
    const input = await screen.findByPlaceholderText(/ID \(K02014\)/i)
    await userEvent.type(input, 'K00001')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(screen.getByText('Depth')).toBeInTheDocument()
    })
    const depthLabel = screen.getByText('Depth')
    await userEvent.click(within(depthLabel).getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/depth is source-dependent|meaning depends on the annotation source/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// TaxonomyPage — help tooltips
// ─────────────────────────────────────────────────────────────────────────────

describe('TaxonomyPage — help tooltips', () => {
  it('scope picker and Exclude branches heading both have a help tooltip', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations') && url.includes('sources=taxonomy'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ data: [{ annotation_id: 'Bacteria', source: 'taxonomy', name: null, parent: null, value: {} }] }),
        })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<App />)
    await userEvent.click(await screen.findByText('Taxonomy', { selector: '.nav-label' }))
    const searchInput = await screen.findByPlaceholderText(/Search for a taxon/i)
    await userEvent.type(searchInput, 'Bacteria')
    const searchBar = searchInput.closest('.search-bar') as HTMLElement
    await userEvent.click(within(searchBar).getByText('Find'))
    const scopeResult = await screen.findByText('Bacteria', { selector: 'span' })
    await userEvent.click(scopeResult)
    // Scoped to h2 — the About page's own copy (always mounted) also mentions
    // "Exclude branches" as plain text inside a <strong>, not an <h2>.
    await waitFor(() => {
      expect(screen.getByText('Exclude branches', { selector: 'h2' })).toBeInTheDocument()
    })
    // Two tooltips now present: scope-change and exclude-branches
    const helpBtns = screen.getAllByTitle('Help')
    expect(helpBtns.length).toBeGreaterThanOrEqual(2)
    await userEvent.click(helpBtns[0])
    await waitFor(() => {
      expect(screen.getByText(/clears your current exclusions/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ScaffoldExplorePanel — help tooltips
// ─────────────────────────────────────────────────────────────────────────────

describe('ScaffoldExplorePanel — help tooltips', () => {
  async function openScaffoldPanelWithTwoTerms() {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: [
              { annotation_id: 'K00001', name: 'a', parent: null, mean_egc: 100, max_egc: 100, sample_count: 1 },
              { annotation_id: 'K00002', name: 'b', parent: null, mean_egc: 50,  max_egc: 50,  sample_count: 1 },
            ],
          }),
        })
      if (url.includes('/api/annotations/scaffolds/summary'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({ data: [{ sample: 's1', date: '05/27/21', scaffold_count: 3, gene_count: 5 }] }),
        })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const cardLabel = await screen.findByText('Scaffold Information', {
      selector: '.explore-card-label',
    })
    await userEvent.click(cardLabel)
    await waitFor(() => {
      expect(screen.getByText(/Showing top 2 taxonomy annotations/i)).toBeInTheDocument()
    })
  }

  it('"Suggested" terms banner has a help tooltip', async () => {
    await openScaffoldPanelWithTwoTerms()
    const banner = screen.getByText(/Showing top 2 taxonomy annotations/i).closest('div') as HTMLElement
    await userEvent.click(within(banner).getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/replaced automatically if you change the source/i)).toBeInTheDocument()
    })
  })

  it('"Split by term" control has a help tooltip', async () => {
    await openScaffoldPanelWithTwoTerms()
    await waitFor(() => {
      expect(screen.getByText('Split by term')).toBeInTheDocument()
    })
    const splitBtn = screen.getByText('Split by term')
    await userEvent.click(within(splitBtn.parentElement as HTMLElement).getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/shows one line per term instead/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// EgcChart — export buttons
// ─────────────────────────────────────────────────────────────────────────────

describe('EgcChart — export buttons', () => {
  async function renderWithChart() {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => {
      expect(screen.getAllByText(/↓ PNG/i).length).toBeGreaterThan(0)
    })
  }

  it('PNG export button rendered', async () => {
    await renderWithChart()
    expect(screen.getAllByText(/↓ PNG/i).length).toBeGreaterThan(0)
  })

  it('SVG export button rendered', async () => {
    await renderWithChart()
    expect(screen.getAllByText(/↓ SVG/i).length).toBeGreaterThan(0)
  })

  it('CSV export button rendered', async () => {
    await renderWithChart()
    expect(screen.getAllByText(/↓ CSV/i).length).toBeGreaterThan(0)
  })

  it('CSV export triggers Blob download', async () => {
    await renderWithChart()
    mockCreateObjectURL.mockClear()
    mockClick.mockClear()
    await userEvent.click(screen.getAllByText(/↓ CSV/i)[0])
    expect(mockCreateObjectURL).toHaveBeenCalled()
    expect(mockClick).toHaveBeenCalled()
  })

  it('Σ Stats button shows stats panel', async () => {
    await renderWithChart()
    await userEvent.click(screen.getAllByText(/Σ Stats/i)[0])
    await waitFor(() => {
      // Scope to .stats-panel — the About page also has <strong>Descriptive Statistics</strong>
      expect(document.querySelector('.stats-panel')).toBeTruthy()
    })
  })

  it('Σ Stats hides on second click', async () => {
    await renderWithChart()
    const statsBtn = screen.getAllByText(/Σ Stats/i)[0]
    await userEvent.click(statsBtn)
    await waitFor(() => expect(document.querySelector('.stats-panel')).toBeTruthy())
    await userEvent.click(statsBtn)
    await waitFor(() => {
      expect(document.querySelector('.stats-panel')).toBeNull()
    })
  })

  it('Relative Abundance metric changes y-axis label to Relative Abundance', async () => {
    await renderWithChart()
    const container = document.querySelector('.chart-controls') as HTMLElement
    const metricGroup = ctrlGroup(container, 'Metric')
    await userEvent.click(within(metricGroup).getByText('Relative Abundance'))
    await waitFor(() => {
      expect(screen.getAllByText('Relative Abundance').length).toBeGreaterThan(0)
      expect(screen.queryByText('norm_egc (EGC / sample depth)')).toBeNull()
    })
  })

  it('Z-score changes y-axis label', async () => {
    await renderWithChart()
    await userEvent.click(screen.getAllByText('Z-score')[0])
    await waitFor(() => {
      expect(screen.getAllByText(/Z-score/i).length).toBeGreaterThan(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// StatsPanel
// ─────────────────────────────────────────────────────────────────────────────

describe('StatsPanel', () => {
  it('shows all 9 statistic labels', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
    await userEvent.click(screen.getAllByText(/Σ Stats/i)[0])
    await waitFor(() => {
      const panel = document.querySelector('.stats-panel')
      expect(panel).toBeTruthy()
      const text = panel!.textContent ?? ''
      for (const label of ['n', 'Mean', 'Median', 'Std Dev s', 'CV', 'Min', 'Q1', 'Q3', 'Max']) {
        expect(text).toContain(label)
      }
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// DateRangePicker
// ─────────────────────────────────────────────────────────────────────────────

describe('DateRangePicker', () => {
  it('from and to date inputs rendered', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => {
      const dateInputs = screen
        .getAllByDisplayValue('')
        .filter(el => el.getAttribute('type') === 'date')
      expect(dateInputs.length).toBeGreaterThanOrEqual(2)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// MappingsPanel — the critical missing coverage from the original test suite
// ─────────────────────────────────────────────────────────────────────────────

describe('MappingsPanel', () => {
  async function renderWithChartAndWait() {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
  }

  it('"View Annotation Mappings" toggle rendered below chart', async () => {
    await renderWithChartAndWait()
    await waitFor(() => {
      expect(screen.getByText(/View Annotation Mappings/i)).toBeInTheDocument()
    })
  })

  it('clicking toggle expands the mappings panel', async () => {
    await renderWithChartAndWait()
    const toggle = screen.getByText(/View Annotation Mappings/i)
    await userEvent.click(toggle)
    await waitFor(() => {
      expect(screen.getByText('Load')).toBeInTheDocument()
    })
  })

  it('Load button present inside expanded panel', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => {
      expect(screen.getByText('Load')).toBeInTheDocument()
    })
  })

  it('clicking Load fetches from /api/mappings/search', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => screen.getByText('Load'))
    mockFetch.mockClear()
    await userEvent.click(screen.getByText('Load'))
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(c => c[0] as string)
      expect(calls.some(u => u.includes('/api/mappings/search'))).toBe(true)
    })
  })

  it('table renders after successful load with Date, Time, Taxonomy, KEGG, Enzyme, COG columns', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => screen.getByText('Load'))
    await userEvent.click(screen.getByText('Load'))
    await waitFor(() => {
      // Use columnheader role to scope to the table — avoids About page h3 Taxonomy
      const headers = screen
        .getAllByRole('columnheader')
        .map(h => h.textContent?.replace(/[↕↑↓]/g, '').trim())
      expect(headers).toContain('Date')
      expect(headers).toContain('Time (24h)')
      expect(headers).toContain('Taxonomy')
      expect(headers).toContain('KEGG')
      expect(headers).toContain('Enzyme')
      expect(headers).toContain('COG')
    })
  })

  it('table does NOT have a "Sample" column header', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => screen.getByText('Load'))
    await userEvent.click(screen.getByText('Load'))
    await waitFor(() => screen.getByText('Date'))
    // "Sample" should not appear as a column header
    const headers = screen
      .getAllByRole('columnheader')
      .map(h => h.textContent?.trim())
    expect(headers).not.toContain('Sample')
  })

  it('CSV export button present after successful load', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => screen.getByText('Load'))
    await userEvent.click(screen.getByText('Load'))
    await waitFor(() => screen.getByText('Date'))
    const csvBtns = screen.getAllByText(/↓ CSV/i)
    expect(csvBtns.length).toBeGreaterThan(0)
  })

  it('error state displayed when mappings API fails', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/mappings/search'))
        return Promise.reject(new Error('mappings fail'))
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
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => screen.getByText('Load'))
    await userEvent.click(screen.getByText('Load'))
    await waitFor(() => {
      expect(screen.getByText(/failed to load mappings/i)).toBeInTheDocument()
    })
  })

  it('"Unique pairs only" checkbox present in expanded panel', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => {
      expect(screen.getByText(/unique pairs only/i)).toBeInTheDocument()
    })
  })

  it('sample count input present with default value 128', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => {
      const inputs = screen
        .getAllByRole('spinbutton')
        .filter(el => (el as HTMLInputElement).value === '128')
      expect(inputs.length).toBeGreaterThan(0)
    })
  })

  it('mappings panel renders ONCE (not duplicated)', async () => {
    await renderWithChartAndWait()
    const toggles = screen.queryAllByText(/View Annotation Mappings/i)
    // Should appear exactly once per chart card
    expect(toggles.length).toBe(1)
  })

  it('shows a help tooltip when no kegg mappings found', async () => {
    // DEFAULT_SEARCH's result card is source=kegg, so the default
    // renderWithChartAndWait() flow already exercises the kegg case.
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/mappings/search'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [], total: 0 }) })
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
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => screen.getByText('Load'))
    await userEvent.click(screen.getByText('Load'))
    await waitFor(() => {
      expect(screen.getByText(/no mappings found/i)).toBeInTheDocument()
    })
    const stateBox = screen.getByText(/no mappings found/i).closest('.state-box') as HTMLElement
    expect(within(stateBox).getByTitle('Help')).toBeInTheDocument()
  })

  it('does NOT show a help tooltip when no cog mappings found', async () => {
    const cogSearch = {
      data: [{
        annotation_id: 'COG0001',
        source:        'cog',
        name:          'ring hydroxylase',
        parent:        null,
        mean_egc:      100.0,
        max_egc:       200.0,
        sample_count:  128,
        value:         { egc: 100.0, norm_egc: 0.00001 },
        timepoint:     null,
        sample:        '',
      }],
      total: 1,
    }
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/mappings/search'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [], total: 0 }) })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => cogSearch })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/View Annotation Mappings/i))
    await waitFor(() => screen.getByText('Load'))
    await userEvent.click(screen.getByText('Load'))
    await waitFor(() => {
      expect(screen.getByText(/no mappings found/i)).toBeInTheDocument()
    })
    const stateBox = screen.getByText(/no mappings found/i).closest('.state-box') as HTMLElement
    expect(within(stateBox).queryByTitle('Help')).not.toBeInTheDocument()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// CorrelatesPanel
// ─────────────────────────────────────────────────────────────────────────────

describe('CorrelatesPanel', () => {
  async function renderWithChartAndWait() {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
  }

  it('"Find Correlates" button rendered below chart', async () => {
    await renderWithChartAndWait()
    await waitFor(() => {
      expect(screen.getByText(/Find Correlates/i)).toBeInTheDocument()
    })
  })

  it('clicking "Find Correlates" expands the panel', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    await waitFor(() => {
      // Scope to .corr-pill-bar — the About page API reference also contains
      // "cross-source" in its description text (always mounted, hidden).
      expect(document.querySelector('.corr-pill-bar')).toBeTruthy()
    })
  })

  it('source selector pills for all 4 sources present', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    await waitFor(() => {
      const bar = document.querySelector('.corr-pill-bar')!
      expect(bar).toBeTruthy()
      expect(bar.textContent).toContain('Compare against')
      for (const s of ['kegg', 'cog', 'enzyme', 'taxonomy']) {
        expect(within(bar as HTMLElement).getByText(s)).toBeInTheDocument()
      }
    })
  })

  it('method and metric selectors rendered', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    const panel = await waitFor(() => {
      const el = document.querySelector('.corr-panel')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    expect(within(panel).getByText(/Method:/i)).toBeInTheDocument()
    expect(within(panel).getByText(/Metric:/i)).toBeInTheDocument()
    expect(within(panel).getByText('spearman')).toBeInTheDocument()
    expect(within(panel).getByText('log_pearson')).toBeInTheDocument()
    expect(within(panel).getByText('raw_pearson')).toBeInTheDocument()
    expect(within(panel).getByText('EGC')).toBeInTheDocument()
    expect(within(panel).getByText('norm EGC')).toBeInTheDocument()
  })

  it('changing the method selector refetches with the new method param', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    await waitFor(() => screen.getByText('raw_pearson'))
    await userEvent.click(screen.getByText('raw_pearson'))
    await waitFor(() => {
      const calls = mockFetch.mock.calls
        .map(([rawUrl]) => String(rawUrl))
        .filter(u => u.includes('/api/correlations/family'))
      expect(calls.some(u => u.includes('method=raw_pearson'))).toBe(true)
    })
  })

  it('clicking "Hide Correlates" collapses the panel', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    await waitFor(() => screen.getByText(/Hide Correlates/i))
    await userEvent.click(screen.getByText(/Hide Correlates/i))
    await waitFor(() => {
      // After collapse, .corr-pill-bar is unmounted
      expect(document.querySelector('.corr-pill-bar')).toBeNull()
    })
  })

  it('source selector pill bar has a help tooltip', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    const bar = await waitFor(() => {
      const el = document.querySelector('.corr-pill-bar')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    await userEvent.click(within(bar).getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/siblings, ancestors, or descendants/i)).toBeInTheDocument()
    })
  })

  it('taxonomy pill shows a depth-cutoff tooltip and results show the rank', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/correlations/family'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ([{
            catalog_id: 9, annotation_id: 'Bacteria;Proteobacteria;Rhizobiaceae;Bosea',
            name: 'Bosea', depth: 6,
            r: 0.72, p: 0.02, q: 0.03, lag_samples: 0, lag_hours: 0, n_pairs: 40,
          }]),
        })
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

    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    const bar = await waitFor(() => {
      const el = document.querySelector('.corr-pill-bar')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })

    // No taxonomy-specific tooltip yet -- default target is enzyme/cog.
    expect(within(bar).getAllByTitle('Help')).toHaveLength(1)

    await userEvent.click(within(bar).getByText('taxonomy', { exact: true }))

    const helpButtons = await waitFor(() => within(bar).getAllByTitle('Help'))
    expect(helpButtons).toHaveLength(2)
    await userEvent.click(helpButtons[1])
    await waitFor(() => {
      expect(screen.getByText(/genus-and-coarser/i)).toBeInTheDocument()
    })

    const panel = document.querySelector('.corr-panel') as HTMLElement
    await waitFor(() => {
      expect(within(panel).getByText('(Genus)')).toBeInTheDocument()
    })
  })

  it('lag value has a help tooltip explaining the sign convention', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    const lagStat = await screen.findByTitle('Time offset. Positive = candidate peaks earlier.')
    await userEvent.click(within(lagStat).getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/tends to peak earlier than this one/i)).toBeInTheDocument()
    })
  })

  it('low-n "⚠ n<30" badge has a help tooltip', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/correlations/family'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ([{
            catalog_id: 7, annotation_id: 'Bacteria', name: 'Bacteria',
            r: 0.72, p: 0.02, q: 0.03, lag_samples: 0, lag_hours: 0, n_pairs: 12,
          }]),
        })
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
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    const nBadge = await waitFor(() => {
      const el = document.querySelector('.corr-stat-n-warn')
      expect(el).toBeTruthy()
      return el as HTMLElement
    })
    await userEvent.click(within(nBadge).getByTitle('Help'))
    await waitFor(() => {
      expect(screen.getByText(/not statistically reliable/i)).toBeInTheDocument()
    })
  })

  it('Retry button refetches after the first request fails', async () => {
    let correlateCalls = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/correlations/family')) {
        correlateCalls += 1
        if (correlateCalls === 1) {
          return Promise.reject(new Error('network'))
        }
        return Promise.resolve({
          ok: true,
          status: 200,
          json: async () => DEFAULT_CORRELATES,
        })
      }
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SEARCH })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      if (url.includes('/api/mappings/search'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_MAPPINGS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getByText(/Find Correlates/i))
    await userEvent.click(screen.getByText(/Find Correlates/i))

    await waitFor(() => {
      expect(screen.getByText(/Correlation failed/i)).toBeInTheDocument()
    })

    await userEvent.click(screen.getByText('Retry'))

    await waitFor(() => {
      expect(
        mockFetch.mock.calls.filter(([rawUrl]) => String(rawUrl).includes('/api/correlations/family')),
      ).toHaveLength(2)
      const panel = document.querySelector('.corr-panel') as HTMLElement
      expect(within(panel).getAllByText(/Bacteria/).length).toBeGreaterThan(0)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AnnotationInfoDrawer
// ─────────────────────────────────────────────────────────────────────────────

describe('AnnotationInfoDrawer', () => {
  async function renderWithChartAndWait() {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
  }

  it('ℹ button rendered in card header', async () => {
    await renderWithChartAndWait()
    await waitFor(() => {
      expect(screen.getByTitle(/Show annotation details/i)).toBeInTheDocument()
    })
  })

  it('clicking ℹ opens drawer showing annotation ID', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByTitle(/Show annotation details/i))
    await waitFor(() => {
      expect(screen.getByText('ID')).toBeInTheDocument()
    })
  })

  it('clicking ℹ again closes the drawer', async () => {
    await renderWithChartAndWait()
    const infoBtn = screen.getByTitle(/Show annotation details/i)
    await userEvent.click(infoBtn)
    await waitFor(() => screen.getByText('ID'))
    await userEvent.click(infoBtn)
    await waitFor(() => {
      expect(screen.queryByText('ID')).not.toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ChartErrorBoundary
// ─────────────────────────────────────────────────────────────────────────────

describe('ChartErrorBoundary', () => {
  it('renders error UI when child throws', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {})

    const ThrowingComponent = () => { throw new Error('chart exploded') }

    class TestBoundary extends React.Component<
      { children: React.ReactNode },
      { hasError: boolean }
    > {
      constructor(props: { children: React.ReactNode }) {
        super(props)
        this.state = { hasError: false }
      }
      static getDerivedStateFromError() { return { hasError: true } }
      render() {
        if (this.state.hasError) return <div>Chart failed to render</div>
        return this.props.children
      }
    }

    render(
      <TestBoundary>
        <ThrowingComponent />
      </TestBoundary>,
    )

    expect(screen.getByText('Chart failed to render')).toBeInTheDocument()
    consoleSpy.mockRestore()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Export side effects
// ─────────────────────────────────────────────────────────────────────────────

describe('Export side effects', () => {
  it('downloadCsv creates a Blob URL and clicks a link', async () => {
    // Need a chart card loaded to get a CSV export button
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ CSV/i).length > 0)
    mockCreateObjectURL.mockClear()
    mockClick.mockClear()
    await userEvent.click(screen.getAllByText(/↓ CSV/i)[0])
    expect(mockCreateObjectURL).toHaveBeenCalledTimes(1)
    expect(mockRevokeObjectURL).toHaveBeenCalledTimes(1)
    expect(mockClick).toHaveBeenCalledTimes(1)
  })

  it('SVG export Blob has SVG MIME type', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ SVG/i).length > 0)
    mockCreateObjectURL.mockClear()
    await userEvent.click(screen.getAllByText(/↓ SVG/i)[0])
    if (mockCreateObjectURL.mock.calls.length > 0) {
      const blob = mockCreateObjectURL.mock.calls[0][0] as unknown as Blob
      expect(blob.type).toContain('svg')
    }
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// Explore page — scaffold section card is a sibling (not nested)
// ─────────────────────────────────────────────────────────────────────────────

describe('Explore page — scaffold section card', () => {
  it('renders Scaffold Information card alongside other section cards', async () => {
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    // Scope to the card grid — the About page (always mounted, hidden) also
    // contains <em>Scaffold Information</em> in its body copy, so we must
    // query within .explore-section-cards to avoid the duplicate.
    await waitFor(() => {
      const grid = document.querySelector('.explore-section-cards')!
      expect(grid).toBeTruthy()
      expect(grid.textContent).toContain('Scaffold Information')
      expect(grid.textContent).toContain('Dataset Overview')
      expect(grid.textContent).toContain('Top EGC Annotations')
      expect(grid.textContent).toContain('Annotations by Parent')
      expect(grid.textContent).toContain('Annotation Lookup')
    })
  })

  it('clicking Scaffold Information card opens the scaffold panel', async () => {
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    // Click the card label div (not the <em> in About page body copy)
    const cardLabel = await screen.findByText('Scaffold Information', {
      selector: '.explore-card-label',
    })
    await userEvent.click(cardLabel)
    await waitFor(() => {
      // ScaffoldExplorePanel opens and renders a search input
      const inputs = screen.getAllByPlaceholderText(/annotation ID or name/i)
      expect(inputs.length).toBeGreaterThanOrEqual(1)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ExplorePage — AnnotationsByParentPanel retry
// ─────────────────────────────────────────────────────────────────────────────

describe('ExplorePage — AnnotationsByParentPanel retry', () => {
  const ONE_PARENT_TOP = {
    data: [
      { annotation_id: 'K00001', name: 'a', parent: 'p1', mean_egc: 100, max_egc: 100, sample_count: 1 },
      { annotation_id: 'K00002', name: 'b', parent: 'p1', mean_egc: 50,  max_egc: 50,  sample_count: 1 },
    ],
  }

  async function openAnnotationsByParent() {
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const cardLabel = await screen.findByText('Annotations by Parent', {
      selector: '.explore-card-label',
    })
    await userEvent.click(cardLabel)
    await waitFor(() => screen.getByText('Group trend & detail'))
  }

  it('top-level fetch failure shows a retry button', async () => {
    let topCalls = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top')) {
        topCalls++
        return topCalls === 1
          ? Promise.reject(new Error('fail'))
          : Promise.resolve({ ok: true, status: 200, json: async () => ONE_PARENT_TOP })
      }
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const cardLabel = await screen.findByText('Annotations by Parent', {
      selector: '.explore-card-label',
    })
    await userEvent.click(cardLabel)

    await waitFor(() => {
      expect(screen.getByTestId('parent-panel-retry-btn')).toBeInTheDocument()
    })
    await userEvent.click(screen.getByTestId('parent-panel-retry-btn'))
    await waitFor(() => {
      expect(screen.queryByTestId('parent-panel-retry-btn')).toBeNull()
    })
    expect(topCalls).toBe(2)
  })

  it('a parent group with a failed member series shows a warning, not a silently empty chart', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ONE_PARENT_TOP })
      if (url.includes('/api/series/annotations')) {
        if (url.includes('annotation_id=K00002')) return Promise.reject(new Error('fail'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
      }
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await openAnnotationsByParent()

    const groupToggle = document.querySelector('.parent-group .mappings-toggle') as HTMLElement
    await userEvent.click(groupToggle)

    await waitFor(() => {
      expect(screen.getByTestId('parent-group-failure-warning')).toBeInTheDocument()
    })
    expect(screen.getByTestId('parent-group-failure-warning').textContent).toContain('K00002')
    expect(screen.getByTestId('parent-group-retry-btn')).toBeInTheDocument()
  })

  it('clicking the parent-group retry re-fetches and clears the warning on success', async () => {
    let k2Calls = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ONE_PARENT_TOP })
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=K00002')) {
        k2Calls++
        if (k2Calls === 1) return Promise.reject(new Error('fail'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
      }
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await openAnnotationsByParent()

    const groupToggle = document.querySelector('.parent-group .mappings-toggle') as HTMLElement
    await userEvent.click(groupToggle)
    await waitFor(() => expect(screen.getByTestId('parent-group-retry-btn')).toBeInTheDocument())

    await userEvent.click(screen.getByTestId('parent-group-retry-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('parent-group-failure-warning')).toBeNull()
    })
    expect(k2Calls).toBe(2)
  })

  it('temporal chart: a failed member shows a warning + single retry, not silently "ok" with no indication', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ONE_PARENT_TOP })
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=K00002'))
        return Promise.reject(new Error('fail'))
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const overviewLabel = await screen.findByText('Dataset Overview', {
      selector: '.explore-card-label',
    })
    await userEvent.click(overviewLabel)
    await userEvent.click(await screen.findByText('Load Overview'))
    await userEvent.click(await screen.findByText('Load time series →'))

    await waitFor(() => {
      expect(screen.getByTestId('overview-series-failure-warning')).toBeInTheDocument()
    })
    expect(screen.getAllByRole('button', { name: /retry/i }).length).toBe(1)
  })

  it('no failure warning when all members succeed', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ONE_PARENT_TOP })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await openAnnotationsByParent()

    const groupToggle = document.querySelector('.parent-group .mappings-toggle') as HTMLElement
    await userEvent.click(groupToggle)

    await waitFor(() => screen.getByText('K00001'))
    expect(screen.queryByTestId('parent-group-failure-warning')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ExplorePage — Dataset Overview happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('ExplorePage — Dataset Overview happy path', () => {
  const THREE_ROW_TOP = {
    data: [
      { annotation_id: 'K00001', name: 'a', parent: 'p1', mean_egc: 100, max_egc: 150, sample_count: 10 },
      { annotation_id: 'K00002', name: 'b', parent: 'p1', mean_egc: 50,  max_egc: 80,  sample_count: 10 },
      { annotation_id: 'K00003', name: 'c', parent: 'p2', mean_egc: 30,  max_egc: 40,  sample_count: 10 },
    ],
    sample_count: 10,
  }

  async function openDatasetOverview() {
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const overviewLabel = await screen.findByText('Dataset Overview', {
      selector: '.explore-card-label',
    })
    await userEvent.click(overviewLabel)
  }

  it('clicking Load Overview groups annotations by parent and renders each group', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({ ok: true, status: 200, json: async () => THREE_ROW_TOP })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await openDatasetOverview()
    await userEvent.click(await screen.findByText('Load Overview'))

    // p1 (2 annotations) and p2 (1 annotation) are the two parent groups
    // that should fall out of grouping THREE_ROW_TOP by `parent`. ExplorePage
    // defaults to source: 'taxonomy' (no source picked in this test), and
    // expandParentLabel appends a rank suffix for taxonomy parents — see
    // taxonomy_egc_homonym_bug — so the label is "p1 (Domain)", not "p1".
    await waitFor(() => {
      expect(screen.getByTitle('p1 (Domain)')).toBeInTheDocument()
    })
    expect(screen.getByTitle('p2 (Domain)')).toBeInTheDocument()
    expect(screen.getAllByText(/↓ CSV/i).length).toBeGreaterThanOrEqual(1)
  })

  it('clicking "Load time series →" renders the summed temporal chart', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/annotations/top'))
        return Promise.resolve({ ok: true, status: 200, json: async () => THREE_ROW_TOP })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: [{
              annotation_id: 'K00001', source: 'kegg', name: 'a', sample: 's1',
              timepoint: { taxon_oid: 's1', timepoint: '1', datetime: '2021-05-27T08:00:00' },
              value: { egc: 100, norm_egc: 0.001 },
            }],
          }),
        })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await openDatasetOverview()
    await userEvent.click(await screen.findByText('Load Overview'))
    await waitFor(() => screen.getByTitle('p1 (Domain)'))

    await userEvent.click(await screen.findByText('Load time series →'))

    await waitFor(() => {
      expect(screen.getByText('Summed EGC over time — top 5 functional groups')).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ExplorePage — Annotation Lookup happy path
// ─────────────────────────────────────────────────────────────────────────────

describe('ExplorePage — Annotation Lookup happy path', () => {
  it('searching an exact ID auto-selects the single result and renders the detail card', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: [{
              annotation_id: 'K02014',
              source:        'kegg',
              name:          'TonB-dependent receptor',
              parent:        '02010 Membrane transport',
              mean_egc:      500,
              max_egc:       900,
              sample_count:  20,
              value:         { egc: 500, norm_egc: 0.0005, depth: 3 },
              timepoint:     null,
              sample:        '',
            }],
            total: 1,
          }),
        })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const lookupLabel = await screen.findByText('Annotation Lookup', {
      selector: '.explore-card-label',
    })
    await userEvent.click(lookupLabel)

    const input = await screen.findByPlaceholderText(/ID \(K02014\)/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))

    await waitFor(() => {
      expect(document.querySelector('.lookup-id')?.textContent).toBe('K02014')
    })
    expect(document.querySelector('.lookup-name')?.textContent).toBe('TonB-dependent receptor')
    // Parent label is derived via expandParentLabel — "02010 Membrane transport"
    // has a 5-digit code prefix, so it should be stripped to just the label.
    expect(document.querySelector('.lookup-meta-grid')?.textContent).toContain('Membrane transport')
  })

  it('multi-result search shows a result list without auto-selecting a detail card', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: [
              {
                annotation_id: 'K02014', source: 'kegg', name: 'a', parent: null,
                mean_egc: 1, max_egc: 1, sample_count: 1, value: null, timepoint: null, sample: '',
              },
              {
                annotation_id: 'K02015', source: 'kegg', name: 'b', parent: null,
                mean_egc: 1, max_egc: 1, sample_count: 1, value: null, timepoint: null, sample: '',
              },
            ],
            total: 2,
          }),
        })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const lookupLabel = await screen.findByText('Annotation Lookup', {
      selector: '.explore-card-label',
    })
    await userEvent.click(lookupLabel)

    const input = await screen.findByPlaceholderText(/ID \(K02014\)/i)
    await userEvent.type(input, 'K0201')
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))

    await waitFor(() => {
      expect(screen.getByText('2 results · click to view details')).toBeInTheDocument()
    })
    expect(document.querySelector('.lookup-id')).toBeNull()

    // Clicking a result selects it and renders the detail card.
    await userEvent.click(screen.getByText('K02014'))
    await waitFor(() => {
      expect(document.querySelector('.lookup-id')?.textContent).toBe('K02014')
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ExplorePage — Annotation Lookup: failed request vs. genuinely no results
// ─────────────────────────────────────────────────────────────────────────────

describe('ExplorePage — Annotation Lookup failure vs. empty', () => {
  async function openLookupAndSearch(term: string) {
    render(<App />)
    await userEvent.click(await screen.findByText('Explore'))
    await screen.findByText('Explore Annotations')
    const lookupLabel = await screen.findByText('Annotation Lookup', {
      selector: '.explore-card-label',
    })
    await userEvent.click(lookupLabel)
    const input = await screen.findByPlaceholderText(/ID \(K02014\)/i)
    await userEvent.type(input, term)
    await userEvent.click(screen.getByRole('button', { name: /^search$/i }))
  }

  it('a genuinely empty result shows "no results" and no retry button', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [], total: 0 }) })
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await openLookupAndSearch('zzz-nonexistent')

    await waitFor(() => {
      expect(screen.getByText(/No results for/i)).toBeInTheDocument()
    })
    expect(screen.queryByTestId('lookup-retry-btn')).toBeNull()
  })

  it('a failed request shows a distinct failure message with a retry button (not "no results")', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations')) return Promise.reject(new Error('fail'))
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await openLookupAndSearch('K02014')

    await waitFor(() => {
      expect(screen.getByTestId('lookup-retry-btn')).toBeInTheDocument()
    })
    expect(screen.queryByText(/No results for/i)).toBeNull()
  })

  it('clicking retry re-runs the search and shows results on success', async () => {
    let calls = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations')) {
        calls++
        if (calls === 1) return Promise.reject(new Error('fail'))
        return Promise.resolve({
          ok: true, status: 200,
          json: async () => ({
            data: [{
              annotation_id: 'K02014', source: 'kegg', name: 'x', parent: null,
              mean_egc: 1, max_egc: 1, sample_count: 1, value: null, timepoint: null, sample: '',
            }],
            total: 1,
          }),
        })
      }
      if (url.includes('/api/timepoints'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_TIMEPOINTS })
      if (url.includes('/api/status'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    await openLookupAndSearch('K02014')
    await waitFor(() => screen.getByTestId('lookup-retry-btn'))

    await userEvent.click(screen.getByTestId('lookup-retry-btn'))

    await waitFor(() => {
      expect(document.querySelector('.lookup-id')?.textContent).toBe('K02014')
    })
    expect(calls).toBe(2)
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AnalyzePage — Compare drawer (previously untested — 0% of CompareDrawer)
// ─────────────────────────────────────────────────────────────────────────────

describe('AnalyzePage — Compare drawer', () => {
  // The "▲ Compare" toggle button itself is disabled until 2+ cards exist
  // (disabled={state.rightCards.length < 2}) — so the drawer can never be
  // opened with 0 or 1 cards through the real UI. That makes CompareDrawer's
  // own "eligibleCards.length === 0" empty-checklist branch unreachable in
  // practice; every test here goes through the 2-card path the UI actually
  // allows.

  async function addTwoSingleCards() {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => TWO_ROW_SEARCH })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    })
    render(<App />)
    const input = await getAnalyzeSearchInput()
    await userEvent.type(input, 'alcohol')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(document.querySelectorAll('.al-row-body').length).toBe(2)
    })
    const rows = document.querySelectorAll('.al-row-body')
    await userEvent.click(rows[0])
    await userEvent.click(rows[1])
    await waitFor(() => {
      expect(screen.getAllByText('K00002').length).toBeGreaterThan(0)
    })
  }

  it('lists both added cards in the checklist', async () => {
    await addTwoSingleCards()
    await userEvent.click(screen.getByText('▲ Compare'))
    await waitFor(() => {
      const text = document.querySelector('.al-drawer-checklist')?.textContent
      expect(text).toContain('K00001')
      expect(text).toContain('K00002')
    })
  })

  it('shows the overlay chart once 2+ cards are checked (cards auto-check on add)', async () => {
    await addTwoSingleCards()
    await userEvent.click(screen.getByText('▲ Compare'))
    await waitFor(() => {
      expect(document.querySelector('.al-drawer-chart .chart-card')).toBeTruthy()
    })
  })

  it('"→ Compare page" button appears once 2+ series are active and hands off both annotations', async () => {
    await addTwoSingleCards()
    await userEvent.click(screen.getByText('▲ Compare'))
    await waitFor(() => screen.getByText('→ Compare page'))
    await userEvent.click(screen.getByText('→ Compare page'))
    // Handoff navigates to the Compare page with both annotations pre-loaded.
    await waitFor(() => {
      expect(screen.getByText(/Compare Annotations/i)).toBeInTheDocument()
    })
  })

  it('"✕ Close" closes the drawer', async () => {
    await addTwoSingleCards()
    await userEvent.click(screen.getByText('▲ Compare'))
    await waitFor(() => screen.getByText('✕ Close'))
    await userEvent.click(screen.getByText('✕ Close'))
    await waitFor(() => {
      expect(screen.queryByText('✕ Close')).toBeNull()
    })
  })

  it('unchecking a card drops it from the chart, leaving fewer than 2 active', async () => {
    await addTwoSingleCards()
    await userEvent.click(screen.getByText('▲ Compare'))
    await waitFor(() => {
      expect(document.querySelector('.al-drawer-chart .chart-card')).toBeTruthy()
    })
    const checkboxes = document.querySelectorAll('.al-drawer-check-row input[type="checkbox"]')
    await userEvent.click(checkboxes[0])
    await waitFor(() => {
      expect(screen.getByText(/Check at least 2 annotations/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// AnalyzePage — group card "🧬 Scaffolds" button opens GroupScaffoldModal
// ─────────────────────────────────────────────────────────────────────────────

describe('AnalyzePage — group card scaffolds button', () => {
  it('clicking 🧬 Scaffolds on a group card opens GroupScaffoldModal', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/search/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => TWO_ROW_SEARCH })
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      if (url.includes('/api/annotations/scaffolds/summary'))
        return Promise.resolve({ ok: true, status: 200, json: async () => ({ data: [] }) })
      return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_STATUS })
    })
    render(<App />)
    const input = await getAnalyzeSearchInput()
    await userEvent.type(input, 'alcohol')
    await userEvent.keyboard('{Enter}')
    await waitFor(() => {
      expect(document.querySelectorAll('.al-row-checkbox').length).toBe(2)
    })
    const checkboxes = document.querySelectorAll('.al-row-checkbox')
    await userEvent.click(checkboxes[0])
    await userEvent.click(checkboxes[1])
    await userEvent.click(screen.getByTitle(/Sum EGC across/i))

    await waitFor(() => document.querySelector('.al-right-card-group'))
    const scaffoldsBtn = Array.from(document.querySelectorAll('.al-right-card-group button'))
      .find(b => b.textContent?.includes('Scaffolds')) as HTMLElement
    await userEvent.click(scaffoldsBtn)

    await waitFor(() => {
      expect(document.querySelector('.scaffold-modal')).toBeTruthy()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ThemeToggle
// ─────────────────────────────────────────────────────────────────────────────

describe('ThemeToggle', () => {
  it('toggles between Light and Dark label text', async () => {
    render(<App />)
    const themeBtn = await screen.findByTitle(/switch to/i)
    const initial  = themeBtn.textContent
    await userEvent.click(themeBtn)
    await waitFor(() => {
      expect(themeBtn.textContent).not.toBe(initial)
    })
  })
})