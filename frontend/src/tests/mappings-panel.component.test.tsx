/**
 * mappings-panel.component.test.tsx
 * ====================================
 * Component tests for MappingsPanel (components/mappings/MappingsPanel.tsx)
 * -- found with zero direct component coverage. mappings-panel.unit.test.ts
 * already covers this file's real exported pure logic (sortMappingRows,
 * paginateRows, totalPages, buildMappingsUrl, buildMappingCsvRow) directly
 * and meaningfully -- these tests cover the remaining gap: the actual
 * render/fetch/interaction layer wired around that logic.
 *
 * Coverage
 * --------
 *   collapsed by default; opening it triggers the first load exactly once
 *     (re-opening after data is already loaded does not re-fetch)
 *   loading / error / empty states
 *   table renders real row data
 *   clicking a sort column header re-sorts the real rows (not just a class
 *     change) and clicking the same column again reverses direction
 *   pagination buttons are correctly enabled/disabled at each boundary and
 *     actually change which rows are shown
 *   the "Unique pairs only" checkbox re-fetches immediately on toggle
 *   Load re-fetches with whatever sample count is currently in the input
 *
 * Run: npx vitest run src/tests/mappings-panel.component.test.tsx
 */

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, within, fireEvent } from '@testing-library/react'
import userEvent from '@testing-library/user-event'

import { MappingsPanel } from '../components/mappings/MappingsPanel'
import type { MappingSearchRow } from '../types'

// downloadCsv itself is a thin browser-download side effect (Blob/anchor
// click) with nothing meaningful to assert on in jsdom -- mocked so these
// tests can assert on WHAT it was called with (i.e. which rows, from
// which fetch) without depending on jsdom's Blob/URL.createObjectURL
// support. apiFetch is left real so the existing global-fetch-mock
// pattern below still drives it normally. vi.mock's factory is hoisted
// above imports/const declarations, so the mock fn itself must be
// created via vi.hoisted rather than a plain top-level const.
const { mockDownloadCsv } = vi.hoisted(() => ({ mockDownloadCsv: vi.fn() }))
vi.mock('../utils/api', async importOriginal => {
  const actual = await importOriginal<typeof import('../utils/api')>()
  return { ...actual, downloadCsv: mockDownloadCsv }
})

const mockFetch = vi.fn()
vi.stubGlobal('fetch', mockFetch)

function jsonResponse(data: unknown) {
  return { ok: true, status: 200, json: async () => data }
}

beforeEach(() => {
  mockFetch.mockReset()
  mockDownloadCsv.mockReset()
})

function makeRow(datetime: string, kegg_id: string | null = 'K00001'): MappingSearchRow {
  return {
    gene_id: 'g1', contig_id: 'c1', taxonomy: 'Bacteria', kegg_id, enzyme: null, cog_id: null,
    sample: 's1', timepoint: { taxon_oid: 's1', timepoint: 'T1', datetime },
  }
}

async function open() {
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: /View Annotation Mappings/i }))
  return user
}

describe('MappingsPanel — collapsed by default, loads once on open', () => {
  it('does not fetch until opened', () => {
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    expect(mockFetch).not.toHaveBeenCalled()
  })

  it('fetches on first open', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('5/27/21 8:00')] }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
  })

  it('does not re-fetch when closed and re-opened after data already loaded', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('5/27/21 8:00')] }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    const user = await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    await user.click(screen.getByRole('button', { name: /View Annotation Mappings/i })) // close
    await user.click(screen.getByRole('button', { name: /View Annotation Mappings/i })) // re-open

    expect(mockFetch).toHaveBeenCalledTimes(1)
  })
})

describe('MappingsPanel — loading, error, empty states', () => {
  it('shows a loading state while the fetch is pending', async () => {
    mockFetch.mockReturnValue(new Promise(() => {}))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    expect(screen.getByText(/Searching mappings across/i)).toBeInTheDocument()
  })

  it('shows an error state on fetch failure', async () => {
    mockFetch.mockRejectedValue(new Error('network error'))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => expect(screen.getByText(/Failed to load mappings/i)).toBeInTheDocument())
  })

  it('shows an empty-state message with no rows', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [] }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => {
      expect(screen.getByText(/No mappings found for/i)).toBeInTheDocument()
    })
  })
})

describe('MappingsPanel — table rendering', () => {
  it('renders real row data in the table', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('5/27/21 8:00', 'K00001')],
    }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => expect(screen.getByText('K00001')).toBeInTheDocument())
    expect(screen.getByText('Bacteria')).toBeInTheDocument()
  })
})

describe('MappingsPanel — sorting', () => {
  it('clicking a column header sorts the real rows by that column', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [
        makeRow('5/27/21 8:00', 'K00099'), // earlier date -- sorted first under the default (date, asc)
        makeRow('6/1/21 8:00', 'K00001'),
      ],
    }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => expect(screen.getByText('K00099')).toBeInTheDocument())

    const table = screen.getByRole('table')
    const bodyRowsBefore = within(table).getAllByRole('row').slice(1) // skip header
    expect(within(bodyRowsBefore[0]).getByText('K00099')).toBeInTheDocument()

    const user = userEvent.setup()
    await user.click(screen.getByRole('columnheader', { name: /KEGG/i }))

    const bodyRowsAfter = within(table).getAllByRole('row').slice(1)
    // Ascending by kegg_id: K00001 before K00099.
    expect(within(bodyRowsAfter[0]).getByText('K00001')).toBeInTheDocument()
  })

  it('clicking the same column header twice reverses sort direction', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [
        makeRow('5/27/21 8:00', 'K00099'),
        makeRow('6/1/21 8:00', 'K00001'),
      ],
    }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => expect(screen.getByText('K00099')).toBeInTheDocument())

    const user = userEvent.setup()
    const table = screen.getByRole('table')
    await user.click(screen.getByRole('columnheader', { name: /KEGG/i })) // asc: K00001 first
    expect(within(within(table).getAllByRole('row')[1]).getByText('K00001')).toBeInTheDocument()

    await user.click(screen.getByRole('columnheader', { name: /KEGG/i })) // desc: K00099 first
    expect(within(within(table).getAllByRole('row')[1]).getByText('K00099')).toBeInTheDocument()
  })
})

describe('MappingsPanel — pagination', () => {
  function manyRows(n: number): MappingSearchRow[] {
    return Array.from({ length: n }, (_, i) =>
      makeRow(`5/27/21 ${(i % 12) + 1}:00`, `K${String(i).padStart(5, '0')}`))
  }

  it('does not show pagination controls when everything fits on one page', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: manyRows(25) }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => expect(screen.getByRole('table')).toBeInTheDocument())
    expect(screen.queryByText(/Page \d+ of/)).not.toBeInTheDocument()
  })

  it('shows pagination controls and Prev is disabled on page 1', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: manyRows(30) }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument())
    expect(screen.getByRole('button', { name: /Prev/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Next/ })).not.toBeDisabled()
  })

  it('Next advances to page 2 and disables itself at the last page', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: manyRows(30) }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    const user = await open()
    await waitFor(() => expect(screen.getByText(/Page 1 of 2/)).toBeInTheDocument())

    await user.click(screen.getByRole('button', { name: /Next/ }))

    expect(screen.getByText(/Page 2 of 2/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Next/ })).toBeDisabled()
    expect(screen.getByRole('button', { name: /Prev/ })).not.toBeDisabled()
  })
})

describe('MappingsPanel — controls trigger real re-fetches', () => {
  it('toggling "Unique pairs only" immediately re-fetches with the new value', async () => {
    // COG0001 is a leaf id, so it defaults to unique_pairs=false (W24 --
    // see the isLikelyLeafAnnotation default tests below); toggling the
    // checkbox on should flip that to true.
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('5/27/21 8:00')] }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    const user = await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    expect(mockFetch.mock.calls[0][0]).toContain('unique_pairs=false')

    await user.click(screen.getByRole('checkbox', { name: /Unique pairs only/i }))
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch.mock.calls[1][0]).toContain('unique_pairs=true')
  })

  it('Load re-fetches using the current sample-count input value', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('5/27/21 8:00')] }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    const user = await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // fireEvent.change (a single direct value set) instead of userEvent.type
    // (character-by-character) -- typing into this controlled, clamped
    // numeric input keystroke-by-keystroke is a known testing-library
    // timing quirk unrelated to what this test is actually checking (that
    // Load re-fetches with whatever value is currently in the field).
    const sampleInput = screen.getByRole('spinbutton')
    fireEvent.change(sampleInput, { target: { value: '10' } })
    await user.click(screen.getByRole('button', { name: 'Load' }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch.mock.calls[1][0]).toContain('sample_count=10')
  })
})

describe('MappingsPanel — broad-category cap (W24, docs/AUDIT-2026-09-22.md)', () => {
  it('reflects the effective (capped) sample count back into the Samples field, not just the banner', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('5/27/21 8:00')],
      sample_count: 5,
      samples_were_capped: true,
    }))
    render(<MappingsPanel annotationId="H" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    expect(screen.getByText(/broad category/i)).toBeInTheDocument()
    const sampleInput = screen.getByRole('spinbutton') as HTMLInputElement
    expect(sampleInput.value).toBe('5')
  })

  it('CSV export re-fetches uncapped (bypass_cap) when the preview was capped, and downloads that data, not the capped preview', async () => {
    const cappedRow = makeRow('5/27/21 8:00', 'K00001')
    const fullRow1   = makeRow('5/27/21 8:00', 'K00001')
    const fullRow2   = makeRow('6/1/21 8:00', 'K00002')

    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [cappedRow], sample_count: 5, samples_were_capped: true,
    }))
    render(<MappingsPanel annotationId="H" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    mockFetch.mockResolvedValueOnce(jsonResponse({ data: [fullRow1, fullRow2] }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /CSV/i }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch.mock.calls[1][0]).toContain('bypass_cap=true')
    expect(mockFetch.mock.calls[1][0]).toContain('sample_count=128')

    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1))
    const [rows] = mockDownloadCsv.mock.calls[0]
    expect(rows).toHaveLength(2) // the full uncapped fetch, not the 1-row capped preview
  })

  it('CSV export does NOT re-fetch when the preview was never capped -- uses the already-loaded rows', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('5/27/21 8:00')], sample_count: 128, samples_were_capped: false,
    }))
    render(<MappingsPanel annotationId="COG0055" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /CSV/i }))

    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1))
    expect(mockFetch).toHaveBeenCalledTimes(1) // no second fetch
  })
})
