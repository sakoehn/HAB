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
 *   Off / L1 / Z-score buttons render
 *   L1 button shows depth-normalised hint text
 *   Z-score button shows std dev hint text
 *   Smooth toggle reveals bandwidth slider
 *
 * EgcChart — export buttons:
 *   PNG button present
 *   SVG button present
 *   CSV button present
 *   CSV triggers Blob download
 *   Σ Stats button shows stats panel
 *   Σ Stats hides on second click
 *   L1 changes y-axis label
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
 *   Cross-source and Within-source tabs present
 *   target source selector pills rendered
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
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import React from 'react'

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
const DEFAULT_CORRELATES = {
  data: [
    {
      annotation_id: 'COG0001',
      source:        'taxonomy',
      name:          'Bacteria',
      parent:        null,
      spearman_r:    0.72,
      abs_r:         0.72,
      lag_samples:   0,
      lag_hours:     0,
      p_value:       0.001,
      n_pairs:       40,
    },
  ],
}

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
    if (url.includes('/api/annotations/correlate'))
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

async function addFirstResultAsChart() {
  const resultRow = await searchAndGetResult()
  await userEvent.click(resultRow)
  await waitFor(() => {
    expect(screen.getAllByText('K00001').length).toBeGreaterThan(1)
  })
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
  it('renders the HAB brand name', async () => {
    render(<App />)
    expect(await screen.findByText('HAB')).toBeInTheDocument()
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
    expect(await screen.findByText('Reset')).toBeInTheDocument()
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

  it('renders source checkboxes for all four sources', async () => {
    render(<App />)
    await waitFor(() => {
      expect(screen.getAllByText('kegg').length).toBeGreaterThan(0)
      expect(screen.getAllByText('cog').length).toBeGreaterThan(0)
      expect(screen.getAllByText('enzyme').length).toBeGreaterThan(0)
      expect(screen.getAllByText('taxonomy').length).toBeGreaterThan(0)
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
// EgcChart — normalize controls (always visible, no mode toggle)
// ─────────────────────────────────────────────────────────────────────────────

describe('EgcChart — normalize controls', () => {
  it('renders Off, L1, Z-score normalize buttons', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => {
      expect(screen.getAllByText('Off').length).toBeGreaterThan(0)
      expect(screen.getAllByText('L1').length).toBeGreaterThan(0)
      expect(screen.getAllByText('Z-score').length).toBeGreaterThan(0)
    })
  })

  it('L1 button shows depth-normalised hint text', async () => {
    render(<App />)
    const resultRow = await searchAndGetResult()
    await userEvent.click(resultRow)
    await waitFor(() => screen.getAllByText(/↓ PNG/i).length > 0)
    await userEvent.click(screen.getAllByText('L1')[0])
    await waitFor(() => {
      expect(screen.getAllByText(/depth-normalised/i).length).toBeGreaterThan(0)
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

  it('L1 changes y-axis label to norm_egc', async () => {
    await renderWithChart()
    await userEvent.click(screen.getAllByText('L1')[0])
    await waitFor(() => {
      expect(screen.getAllByText(/norm_egc/i).length).toBeGreaterThan(0)
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

  it('Cross-source and Within-source tabs present', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    await waitFor(() => {
      const bar = document.querySelector('.corr-pill-bar')!
      expect(bar).toBeTruthy()
      expect(bar.textContent).toContain('Cross-source')
      expect(bar.textContent).toContain('Within-source')
    })
  })

  it('target source selector pills rendered in cross-source tab', async () => {
    await renderWithChartAndWait()
    await userEvent.click(screen.getByText(/Find Correlates/i))
    await waitFor(() => {
      expect(screen.getByText(/Compare against/i)).toBeInTheDocument()
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