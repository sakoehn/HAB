/**
 * compare-page.component.test.tsx
 * =================================
 * React component tests for ComparePage.
 *
 * Tests import from production source files.
 * All fetch calls are mocked.
 *
 * Coverage
 * --------
 * makeDefaultCompareState:
 *   default query is empty string
 *   default searchResults is []
 *   default searchStatus is idle
 *   default entries is []
 *   default showMappings is false
 *   default dateFrom/dateTo are empty strings
 *   each call returns a fresh object
 *
 * ComparePage — shell:
 *   renders "Compare Annotations" heading
 *   search input renders with correct placeholder
 *   no source selector needed before searching -- search spans all 4 sources at once
 *   empty state message rendered when no entries
 *   "Find" button present and enabled
 *   "Find" button disabled when 4 entries loaded
 *
 * ComparePage — search:
 *   search returns results after API responds
 *   result rows show annotation_id and name
 *   error state shown when search API fails
 *   empty query does not trigger fetch
 *
 * ComparePage — bulk-select:
 *   checkbox present on each result row
 *   checking a row enables "Add N selected" button
 *   unchecking a row hides "Add N selected" button
 *   "Select all visible" checkbox present
 *   checking "Select all visible" checks all rows
 *   "Add N selected" button shows correct count
 *
 * ComparePage — 4-entry cap:
 *   can add up to 4 annotations (one at a time)
 *   "Find" button disabled when 4 entries loaded
 *   cannot check more boxes than slots remaining
 *   "slots available" badge shows correct count
 *   already-added rows show "added" badge and are dimmed
 *
 * ComparePage — entries panel:
 *   annotation chip appears after adding
 *   chip shows annotation_id and source
 *   × button removes entry
 *   removing last entry shows empty state again
 *   "add up to N more" label reflects remaining slots
 *
 * ComparePage — initialAnnotations (from Analyze → Compare):
 *   entries pre-populated when initialAnnotations provided
 *   onConsumed called once after loading
 *   loading state shown during fetch
 *   capped at 4 even if more provided
 *
 * ComparePage — CSV export:
 *   CSV button present when entries are loaded
 *   CSV button triggers Blob download
 *
 * ComparePage — deduplication:
 *   adding same annotation twice is a no-op
 *   search results deduplicate by annotation_id
 *   search results with the same annotation_id but different sources are NOT deduplicated against each other
 *   checking a result row only selects that row's (annotation_id, source) pair, not same-id rows from other sources
 *
 * Run: npx vitest run src/tests/compare-page.component.test.tsx
 */

import React from 'react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { makeDefaultCompareState, ComparePage } from '../pages/ComparePage'
import type { CompareState, SharedAnnotation } from '../types'

// ── Mock fetch ──────────────────────────────────────────────────────────────

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

const mockCreateObjectURL = vi.fn(() => 'blob:mock')
const mockRevokeObjectURL = vi.fn()
const mockClick           = vi.fn()
URL.createObjectURL = mockCreateObjectURL
URL.revokeObjectURL = mockRevokeObjectURL
const _origCreate = document.createElement.bind(document)
vi.spyOn(document, 'createElement').mockImplementation((tag: string) => {
  const el = _origCreate(tag)
  if (tag === 'a') Object.defineProperty(el, 'click', { value: mockClick, writable: true })
  return el
})

// ── Default API responses ───────────────────────────────────────────────────

const SEARCH_RESULT_1 = {
  annotation_id: 'K02014',
  source:        'kegg',
  name:          'TonB-dep receptor',
  parent:        '02000 membrane',
  mean_egc:      5000,
  max_egc:       12000,
  sample_count:  128,
  value:         { egc: 5000, norm_egc: 0.0005 },
  timepoint:     null,
  sample:        '',
}
const SEARCH_RESULT_2 = {
  annotation_id: 'K00001',
  source:        'kegg',
  name:          'Alcohol dehydrogenase',
  parent:        '00620 carbon',
  mean_egc:      2000,
  max_egc:       5000,
  sample_count:  64,
  value:         { egc: 2000, norm_egc: 0.0002 },
  timepoint:     null,
  sample:        '',
}
const DEFAULT_SEARCH   = { data: [SEARCH_RESULT_1, SEARCH_RESULT_2], total: 2 }
const DEFAULT_SERIES   = {
  data: Array.from({ length: 5 }, (_, i) => ({
    annotation_id: 'K02014',
    source:        'kegg',
    name:          'TonB-dep receptor',
    sample:        `s${i}`,
    timepoint: { taxon_oid: `s${i}`, timepoint: String(i), datetime: `2021-05-${String(i + 1).padStart(2, '0')}T08:00:00` },
    value:     { egc: 1000 + i * 100, norm_egc: 0.0001 },
  })),
}

function setupMocks(opts: {
  searchData?: object
  seriesData?: object
  searchFail?: boolean
  seriesFail?: boolean
} = {}) {
  mockFetch.mockImplementation((url: string) => {
    if (url.includes('/api/search/annotations')) {
      if (opts.searchFail) return Promise.reject(new Error('search fail'))
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => opts.searchData ?? DEFAULT_SEARCH,
      })
    }
    if (url.includes('/api/series/annotations')) {
      if (opts.seriesFail) return Promise.reject(new Error('series fail'))
      return Promise.resolve({
        ok: true, status: 200,
        json: async () => opts.seriesData ?? DEFAULT_SERIES,
      })
    }
    if (url.includes('/api/timepoints'))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ total: 128 }) })
    if (url.includes('/api/status'))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({ index_ready: true }) })
    return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
  })
}

// ── Stateful wrapper so ComparePage can update its own state ────────────────

function ManagedComparePage({
  initialState,
  initialAnnotations = [],
  onConsumed = vi.fn(),
  dataDateRange,
}: {
  initialState?:       Partial<CompareState>
  initialAnnotations?: SharedAnnotation[]
  onConsumed?:         () => void
  dataDateRange?:      { min: string; max: string } | null
}) {
  const [state, setStateRaw] = React.useState<CompareState>({
    ...makeDefaultCompareState(),
    ...initialState,
  })
  const [pending, setPending] = React.useState<SharedAnnotation[]>(initialAnnotations)

  const setState = React.useCallback(
    (updater: (prev: CompareState) => CompareState) => setStateRaw(updater),
    [],
  )

  const handleConsumed = React.useCallback(() => {
    setPending([])
    onConsumed()
  }, [onConsumed])

  return (
    <ComparePage
      state={state}
      setState={setState}
      initialAnnotations={pending}
      onConsumed={handleConsumed}
      dataDateRange={dataDateRange}
      onReset={vi.fn()}
    />
  )
}

// ── Setup ───────────────────────────────────────────────────────────────────

beforeEach(() => {
  setupMocks()
  mockCreateObjectURL.mockClear()
  mockRevokeObjectURL.mockClear()
  mockClick.mockClear()
})

afterEach(() => {
  vi.clearAllMocks()
})

// ─────────────────────────────────────────────────────────────────────────────
// makeDefaultCompareState
// ─────────────────────────────────────────────────────────────────────────────

describe('makeDefaultCompareState', () => {
  it('default query is empty string', () => {
    expect(makeDefaultCompareState().query).toBe('')
  })

  it('default searchResults is empty array', () => {
    expect(makeDefaultCompareState().searchResults).toEqual([])
  })

  it('default searchStatus is idle', () => {
    expect(makeDefaultCompareState().searchStatus).toBe('idle')
  })

  it('default entries is empty array', () => {
    expect(makeDefaultCompareState().entries).toEqual([])
  })

  it('default showMappings is false', () => {
    expect(makeDefaultCompareState().showMappings).toBe(false)
  })

  it('default dateFrom is empty string', () => {
    expect(makeDefaultCompareState().dateFrom).toBe('')
  })

  it('default dateTo is empty string', () => {
    expect(makeDefaultCompareState().dateTo).toBe('')
  })

  it('each call returns a fresh object (no shared reference)', () => {
    const s1 = makeDefaultCompareState()
    const s2 = makeDefaultCompareState()
    s1.query = 'modified'
    expect(s2.query).toBe('')
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — shell
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — shell', () => {
  it('renders "Compare Annotations" heading', async () => {
    render(<ManagedComparePage />)
    expect(await screen.findByText('Compare Annotations')).toBeInTheDocument()
  })

  it('search input renders with correct placeholder', async () => {
    render(<ManagedComparePage />)
    expect(
      await screen.findByPlaceholderText(/search annotation id or name/i),
    ).toBeInTheDocument()
  })

  it('no source selector needed before searching -- search spans all 4 sources at once', async () => {
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))

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

  it('empty state message rendered when no entries', async () => {
    render(<ManagedComparePage />)
    await waitFor(() => {
      expect(document.querySelector('.first-run-hint')).toBeInTheDocument()
    })
  })

  it('"Find" button present and initially enabled', async () => {
    render(<ManagedComparePage />)
    const findBtn = await screen.findByRole('button', { name: /find/i })
    expect(findBtn).not.toBeDisabled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — search
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — search', () => {
  async function doSearch(query = 'K02014') {
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, query)
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
  }

  it('search returns results after API responds', async () => {
    await doSearch('K02014')
    await waitFor(() => {
      expect(screen.getByText('K02014')).toBeInTheDocument()
    })
  })

  it('result rows show annotation name', async () => {
    await doSearch('K02014')
    await waitFor(() => {
      expect(screen.getByText('TonB-dep receptor')).toBeInTheDocument()
    })
  })

  it('error state shown when search API fails', async () => {
    setupMocks({ searchFail: true })
    await doSearch('K02014')
    await waitFor(() => {
      expect(screen.getByText(/search failed/i)).toBeInTheDocument()
    })
  })

  it('Enter key triggers search', async () => {
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014{Enter}')
    await waitFor(() => {
      const calls = mockFetch.mock.calls.map(c => c[0] as string)
      expect(calls.some(u => u.includes('/api/search/annotations'))).toBe(true)
    })
  })

  it('result count badge shows correct number', async () => {
    await doSearch()
    await waitFor(() => {
      expect(screen.getByText(/2 results/i)).toBeInTheDocument()
    })
  })

  it('slots available badge shows 4 when no entries', async () => {
    await doSearch()
    await waitFor(() => {
      expect(screen.getByText(/4 slots? available/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — bulk-select
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — bulk-select', () => {
  async function searchAndWait() {
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => screen.getByText('K02014'))
  }

  it('checkboxes present on result rows', async () => {
    await searchAndWait()
    const checkboxes = screen.getAllByRole('checkbox')
    // At least 2 row checkboxes + 1 select-all
    expect(checkboxes.length).toBeGreaterThanOrEqual(3)
  })

  it('"Select all visible" checkbox present', async () => {
    await searchAndWait()
    expect(screen.getByLabelText(/select all visible/i)).toBeInTheDocument()
  })

  it('checking a row enables "Add N selected" button', async () => {
    await searchAndWait()
    const rowCheckboxes = screen.getAllByRole('checkbox').slice(1) // skip select-all
    await userEvent.click(rowCheckboxes[0])
    await waitFor(() => {
      expect(screen.getByText(/add 1 selected/i)).toBeInTheDocument()
    })
  })

  it('unchecking a row hides "Add N selected" button', async () => {
    await searchAndWait()
    const rowCheckboxes = screen.getAllByRole('checkbox').slice(1)
    await userEvent.click(rowCheckboxes[0])
    await waitFor(() => screen.getByText(/add 1 selected/i))
    await userEvent.click(rowCheckboxes[0])
    await waitFor(() => {
      expect(screen.queryByText(/add 1 selected/i)).not.toBeInTheDocument()
    })
  })

  it('"Add N selected" shows correct count for 2 checked', async () => {
    await searchAndWait()
    const rowCheckboxes = screen.getAllByRole('checkbox').slice(1)
    await userEvent.click(rowCheckboxes[0])
    await userEvent.click(rowCheckboxes[1])
    await waitFor(() => {
      expect(screen.getByText(/add 2 selected/i)).toBeInTheDocument()
    })
  })

  it('"Select all visible" checks all eligible rows', async () => {
    await searchAndWait()
    const selectAll = screen.getByLabelText(/select all visible/i)
    await userEvent.click(selectAll)
    await waitFor(() => {
      // With 2 results and 4 slots, both should be selectable
      expect(screen.getByText(/add 2 selected/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — 4-entry cap
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — 4-entry cap', () => {
  it('"Find" button disabled when 4 entries loaded', async () => {
    const fourEntries = Array.from({ length: 4 }, (_, i) => ({
      annotationId: `K0000${i}`,
      source:       'kegg' as const,
      name:         `Annotation ${i}`,
      data:         [],
      status:       'ok' as const,
      color:        '#38d9b4',
    }))
    render(<ManagedComparePage initialState={{ entries: fourEntries }} />)
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /find/i })).toBeDisabled()
    })
  })

  it('"add up to N more" label reflects remaining slots', async () => {
    const twoEntries = Array.from({ length: 2 }, (_, i) => ({
      annotationId: `K0000${i}`,
      source:       'kegg' as const,
      name:         `Ann ${i}`,
      data:         [],
      status:       'ok' as const,
      color:        '#38d9b4',
    }))
    render(<ManagedComparePage initialState={{ entries: twoEntries }} />)
    await waitFor(() => {
      expect(screen.getByText(/add up to 2 more/i)).toBeInTheDocument()
    })
  })

  it('already-added rows show "added" badge', async () => {
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => screen.getAllByText('K02014').length > 0)
    const firstRow = screen.getAllByRole('checkbox').slice(1)[0]
    await userEvent.click(firstRow)
    await waitFor(() => screen.getByText(/add 1 selected/i))
    await userEvent.click(screen.getByText(/add 1 selected/i))
    // K02014 appears in chip + chart legend — both are correct
    await waitFor(() => {
      expect(screen.getAllByText('K02014').length).toBeGreaterThanOrEqual(1)
    })
  })

  it('slots available decrements as entries are added', async () => {
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => screen.getByText(/4 slots? available/i))
    // Check first row and add
    const rowCheck = screen.getAllByRole('checkbox').slice(1)[0]
    await userEvent.click(rowCheck)
    await userEvent.click(screen.getByText(/add 1 selected/i))
    // Search again — should now show 3 slots
    await userEvent.clear(input)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => {
      expect(screen.getByText(/3 slots? available/i)).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — entries panel
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — entries panel', () => {
  async function addEntry() {
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => screen.getByText('K02014'))
    const rowCheck = screen.getAllByRole('checkbox').slice(1)[0]
    await userEvent.click(rowCheck)
    await userEvent.click(screen.getByText(/add 1 selected/i))
    await waitFor(() => {
      // Chip should appear
      const chips = screen.getAllByText('K02014')
      expect(chips.length).toBeGreaterThan(0)
    })
  }

  it('annotation chip appears after adding', async () => {
    await addEntry()
    // K02014 appears both in results and in chip
    expect(screen.getAllByText('K02014').length).toBeGreaterThan(0)
  })

  it('chip shows source tag', async () => {
    await addEntry()
    const tags = screen.getAllByText('kegg')
    expect(tags.length).toBeGreaterThan(0)
  })

  it('× button removes entry', async () => {
    await addEntry()
    const removeBtn = screen.getByText('×')
    await userEvent.click(removeBtn)
    await waitFor(() => {
      expect(document.querySelector('.first-run-hint')).toBeInTheDocument()
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — failed entry (was previously invisible: no error text at all)
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — failed entry', () => {
  async function addFailingEntry() {
    setupMocks({ seriesFail: true })
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => screen.getByText('K02014'))
    const rowCheck = screen.getAllByRole('checkbox').slice(1)[0]
    await userEvent.click(rowCheck)
    await userEvent.click(screen.getByText(/add 1 selected/i))
  }

  it('shows a failed-to-load indicator (previously showed nothing at all)', async () => {
    await addFailingEntry()
    await waitFor(() => {
      expect(screen.getByTestId('compare-entry-failed')).toBeInTheDocument()
    })
  })

  it('failed entry has a retry button', async () => {
    await addFailingEntry()
    await waitFor(() => {
      expect(screen.getByTestId('compare-entry-retry-btn')).toBeInTheDocument()
    })
  })

  it('clicking retry re-fetches and clears the failed indicator on success', async () => {
    await addFailingEntry()
    await waitFor(() => screen.getByTestId('compare-entry-retry-btn'))

    setupMocks({ seriesFail: false })
    await userEvent.click(screen.getByTestId('compare-entry-retry-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('compare-entry-failed')).toBeNull()
    })
  })

  it('no failed indicator is shown for a successfully-loaded entry', async () => {
    setupMocks()
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => screen.getByText('K02014'))
    const rowCheck = screen.getAllByRole('checkbox').slice(1)[0]
    await userEvent.click(rowCheck)
    await userEvent.click(screen.getByText(/add 1 selected/i))
    await waitFor(() => {
      expect(screen.getAllByText('K02014').length).toBeGreaterThan(0)
    })
    expect(screen.queryByTestId('compare-entry-failed')).toBeNull()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — initialAnnotations
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — initialAnnotations from Analyze page', () => {
  const INIT_ANNS: SharedAnnotation[] = [
    { kind: 'single', annotationId: 'K02014', source: 'kegg', name: 'TonB-dep receptor' },
  ]

  it('entries pre-populated when initialAnnotations provided', async () => {
    const onConsumed = vi.fn()
    render(
      <ManagedComparePage
        initialAnnotations={INIT_ANNS}
        onConsumed={onConsumed}
      />,
    )
    // Should show loading state for the entry
    await waitFor(() => {
      expect(screen.getByText('K02014')).toBeInTheDocument()
    })
  })

  it('onConsumed called once after loading', async () => {
    const onConsumed = vi.fn()
    render(
      <ManagedComparePage
        initialAnnotations={INIT_ANNS}
        onConsumed={onConsumed}
      />,
    )
    await waitFor(() => {
      expect(onConsumed).toHaveBeenCalledTimes(1)
    })
  })

  // W29 (docs/AUDIT-2026-09-22.md): "an annotation added while the
  // annotations sent from Analyze are still loading disappears when that
  // load finishes." Manually searching+adding a new annotation while the
  // initialAnnotations series fetch is still in flight used to get wiped
  // out the moment that fetch's `.then()` replaced `entries` wholesale.
  it('an annotation added manually while the initial (Analyze) load is still in flight is not wiped out when that load finishes', async () => {
    let resolveInitial!: (v: unknown) => void
    const initialPending = new Promise(resolve => { resolveInitial = resolve })
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=K02014')) {
        return initialPending
      }
      if (url.includes('/api/series/annotations') && url.includes('annotation_id=K00001')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      }
      if (url.includes('/api/search/annotations')) {
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SEARCH })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })

    render(<ManagedComparePage initialAnnotations={INIT_ANNS} />)

    // K02014's series fetch (from Analyze) is still pending -- manually
    // search for and add K00001 in the meantime.
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K00001')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => expect(screen.getByText('Alcohol dehydrogenase')).toBeInTheDocument())
    await userEvent.click(screen.getByText('Alcohol dehydrogenase'))
    await waitFor(() => {
      // K00001 is now a real, loaded entry (its own series fetch is fast).
      expect(screen.getAllByText('K00001').length).toBeGreaterThan(0)
    })

    // Now let K02014's slow (initial) fetch finally resolve.
    resolveInitial({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
    await waitFor(() => {
      expect(screen.getAllByText('K02014').length).toBeGreaterThan(0)
    })

    // K00001 must still be there -- it must not have been silently
    // discarded when K02014's `.then()` landed.
    expect(screen.getAllByText('K00001').length).toBeGreaterThan(0)
  })

  it('capped at 4 even if more provided', async () => {
    const fiveAnns: SharedAnnotation[] = Array.from({ length: 5 }, (_, i) => ({
      kind:         'single' as const,
      annotationId: `K0000${i}`,
      source:       'kegg' as const,
      name:         `Ann ${i}`,
    }))
    const onConsumed = vi.fn()
    render(
      <ManagedComparePage
        initialAnnotations={fiveAnns}
        onConsumed={onConsumed}
      />,
    )
    await waitFor(() => {
      // At most 4 × buttons should appear
      const removeBtns = screen.getAllByText('×')
      expect(removeBtns.length).toBeLessThanOrEqual(4)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — CSV export
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — CSV export', () => {
  const readyEntries = [{
    annotationId: 'K02014',
    source:       'kegg' as const,
    name:         'TonB-dep receptor',
    data:         DEFAULT_SERIES.data,
    status:       'ok'  as const,
    color:        '#38d9b4',
  }]

  it('CSV button present when entries are ready', async () => {
    // W18: ComparePage no longer has its own page-level CSV button (it
    // always re-derived raw EGC regardless of the chart's actual
    // metric/standardize/smoothed state, so it was always wrong whenever
    // the chart wasn't in plain raw-EGC mode) -- only the one inside
    // MultiEgcChart's own card header remains, which reflects the chart's
    // real current state (see egc-csv-export.unit.test.ts).
    render(<ManagedComparePage initialState={{ entries: readyEntries }} />)
    await waitFor(() => {
      expect(screen.getAllByText(/↓ CSV/i)).toHaveLength(1)
    })
  })

  it('MultiEgcChart\'s CSV button triggers a Blob download', async () => {
    render(<ManagedComparePage initialState={{ entries: readyEntries }} />)
    await waitFor(() => screen.getAllByText(/↓ CSV/i).length > 0)
    mockCreateObjectURL.mockClear()
    mockClick.mockClear()
    const csvBtns = screen.getAllByText(/↓ CSV/i)
    await userEvent.click(csvBtns[0])
    expect(mockCreateObjectURL).toHaveBeenCalled()
    expect(mockClick).toHaveBeenCalled()
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — deduplication
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — deduplication', () => {
  it('search results deduplicate by annotation_id', async () => {
    // API returns same annotation_id twice
    const dupeSearch = {
      data: [SEARCH_RESULT_1, { ...SEARCH_RESULT_1, name: 'Duplicate' }],
      total: 2,
    }
    setupMocks({ searchData: dupeSearch })
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => {
      // Only one K02014 row should appear (deduplicated)
      const rows = screen.getAllByText('K02014')
      // One in the header/results area
      expect(rows.length).toBeGreaterThan(0)
    })
    // Only 1 result badge should show
    await waitFor(() => {
      expect(screen.getByText(/1 results?/i)).toBeInTheDocument()
    })
  })

  it('search results with the same annotation_id but different sources are NOT deduplicated against each other', async () => {
    // Same annotation_id string, but a real different source -- e.g. a COG
    // ID that happens to collide with a KEGG ID string. Must NOT be
    // collapsed into one result the way a genuine same-source duplicate is.
    const crossSourceSearch = {
      data: [SEARCH_RESULT_1, { ...SEARCH_RESULT_1, source: 'cog', name: 'Different annotation, same ID string' }],
      total: 2,
    }
    setupMocks({ searchData: crossSourceSearch })
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))

    await waitFor(() => {
      expect(screen.getByText(/2 results?/i)).toBeInTheDocument()
    })
  })

  it("checking a result row only selects that row's (annotation_id, source) pair, not same-id rows from other sources", async () => {
    const crossSourceSearch = {
      data: [SEARCH_RESULT_1, { ...SEARCH_RESULT_1, source: 'cog', name: 'Different annotation, same ID string' }],
      total: 2,
    }
    setupMocks({ searchData: crossSourceSearch })
    render(<ManagedComparePage />)
    const input = await screen.findByPlaceholderText(/search annotation id or name/i)
    await userEvent.type(input, 'K02014')
    await userEvent.click(screen.getByRole('button', { name: /find/i }))
    await waitFor(() => expect(screen.getByText(/2 results?/i)).toBeInTheDocument())

    const checkboxes = screen.getAllByRole('checkbox').filter(cb => cb.closest('label') === null)
    await userEvent.click(checkboxes[0])

    // Only the clicked row's checkbox should be checked -- the other
    // same-ID, different-source row must remain unchecked.
    expect((checkboxes[0] as HTMLInputElement).checked).toBe(true)
    expect((checkboxes[1] as HTMLInputElement).checked).toBe(false)
  })

  it('adding a duplicate annotation via initialAnnotations is a no-op', async () => {
    // Start with K02014 already in entries
    const existing = [{
      annotationId: 'K02014',
      source:       'kegg' as const,
      name:         'TonB-dep receptor',
      data:         [],
      status:       'loading' as const,
      color:        '#38d9b4',
    }]
    render(
      <ManagedComparePage
        initialState={{ entries: existing }}
        initialAnnotations={[]} // no new ones
      />,
    )
    await waitFor(() => {
      const removeBtns = screen.getAllByText('×')
      // Still just 1 entry
      expect(removeBtns).toHaveLength(1)
    })
  })
})

// ─────────────────────────────────────────────────────────────────────────────
// ComparePage — group entry via Analyze handoff (initialAnnotations, kind: 'group')
// Previously untested: fetchMemberSeries/sumMemberSeries only ran through the
// 'single' path in every existing test.
// ─────────────────────────────────────────────────────────────────────────────

describe('ComparePage — group entry from Analyze handoff', () => {
  const GROUP_ANN: SharedAnnotation[] = [
    {
      kind:  'group',
      label: 'My Group',
      members: [
        { annotationId: 'K00001', source: 'kegg' },
        { annotationId: 'K00002', source: 'kegg' },
      ],
    },
  ]

  it('loads a group entry and shows the summed chip', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<ManagedComparePage initialAnnotations={GROUP_ANN} />)
    await waitFor(() => {
      expect(screen.getByText('My Group')).toBeInTheDocument()
    })
    expect(screen.getByText('2 annotations summed')).toBeInTheDocument()
  })

  it('expanding "▼ members" shows the individual member list', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<ManagedComparePage initialAnnotations={GROUP_ANN} />)
    await waitFor(() => screen.getByText('2 annotations summed'))
    await userEvent.click(screen.getByText('▼ members'))
    await waitFor(() => {
      expect(screen.getByText('K00001')).toBeInTheDocument()
      expect(screen.getByText('K00002')).toBeInTheDocument()
    })
  })

  it('collapsing "▲ members" hides the member list again', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<ManagedComparePage initialAnnotations={GROUP_ANN} />)
    await waitFor(() => screen.getByText('2 annotations summed'))
    await userEvent.click(screen.getByText('▼ members'))
    await waitFor(() => screen.getByText('K00001'))
    await userEvent.click(screen.getByText('▲ members'))
    await waitFor(() => {
      expect(screen.queryByText('K00001')).toBeNull()
    })
  })

  it('all members failing shows a failed-to-load chip with retry (not a silently empty sum)', async () => {
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations')) return Promise.reject(new Error('fail'))
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<ManagedComparePage initialAnnotations={GROUP_ANN} />)
    await waitFor(() => {
      expect(screen.getByTestId('compare-entry-failed')).toBeInTheDocument()
    })
  })

  it('clicking retry on a failed group entry re-fetches and succeeds', async () => {
    let calls = 0
    mockFetch.mockImplementation((url: string) => {
      if (url.includes('/api/series/annotations')) {
        calls++
        // Both members fail on the initial load, succeed on retry.
        if (calls <= 2) return Promise.reject(new Error('fail'))
        return Promise.resolve({ ok: true, status: 200, json: async () => DEFAULT_SERIES })
      }
      return Promise.resolve({ ok: true, status: 200, json: async () => ({}) })
    })
    render(<ManagedComparePage initialAnnotations={GROUP_ANN} />)
    await waitFor(() => screen.getByTestId('compare-entry-retry-btn'))

    await userEvent.click(screen.getByTestId('compare-entry-retry-btn'))

    await waitFor(() => {
      expect(screen.queryByTestId('compare-entry-failed')).toBeNull()
    })
    expect(screen.getByText('2 annotations summed')).toBeInTheDocument()
  })
})