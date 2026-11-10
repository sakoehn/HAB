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

// The export box limits its date pickers to the dataset's range from the
// shared samples hook; stubbed so its own fetch doesn't use up the mocked
// responses below.
vi.mock('../utils/useAllSamples', () => ({
  useAllSamples: () => ({
    // 128 samples, the real dataset's size, from 5/27 to 6/10.
    allSamples: Array.from({ length: 128 }, (_, i) => ({
      sample:   `s${i + 1}`,
      datetime: i === 0 ? '5/27/21 8:00' : i === 127 ? '6/10/21 20:00' : '6/1/21 12:00',
    })),
    allSamplesLoading: false,
    allSamplesError: false,
  }),
}))

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

  it('shows each row gene and its scaffold', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [{ ...makeRow('5/27/21 8:00'), gene_id: 'Ga01_0000003_25253_27703', contig_id: 'Ga01_0000003' }],
    }))
    render(<MappingsPanel annotationId="COG0001" source="cog" />)
    await open()
    await waitFor(() => expect(screen.getByText('Ga01_0000003_25253_27703')).toBeInTheDocument())
    expect(screen.getByText('Ga01_0000003')).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Gene/ })).toBeInTheDocument()
    expect(screen.getByRole('columnheader', { name: /Scaffold/ })).toBeInTheDocument()
  })
})

describe('MappingsPanel — the count says what a row is', () => {
  const count = () => document.querySelector('.toggle-count')?.textContent

  it('counts genes when unique pairs is off', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('5/27/21 8:00'), makeRow('5/28/21 8:00')] }))
    render(<MappingsPanel annotationId="K00001" source="kegg" />)
    await open()
    await waitFor(() => expect(count()).toBe('2 genes'))
  })

  it('counts unique combinations when unique pairs is on, and says which gene is shown', async () => {
    mockFetch.mockResolvedValue(jsonResponse({ data: [makeRow('5/27/21 8:00')] }))
    render(<MappingsPanel annotationId="09101" source="kegg" />)
    await open()
    await waitFor(() => expect(count()).toBe('1 unique combination'))
    expect(screen.getByText(/earliest gene with that combination/i)).toBeInTheDocument()
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
    // COG0001 is a leaf id, so it defaults to unique_pairs=false (see the
    // isLikelyLeafAnnotation default tests below); toggling the
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

    // Typed, then Load clicked straight away: the click applies what was typed.
    const sampleInput = screen.getByRole('spinbutton')
    await user.clear(sampleInput)
    await user.type(sampleInput, '10')
    await user.click(screen.getByRole('button', { name: 'Load' }))

    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(2))
    expect(mockFetch.mock.calls[1][0]).toContain('sample_count=10')
  })
})

describe('MappingsPanel — broad-category cap', () => {
  it('reflects the effective (capped) sample count back into the Samples field, not just the banner', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('5/27/21 8:00')],
      sample_count: 5,
      samples_were_capped: true,
      leaf_count: 25, // "H" is a real, many-member COG category
    }))
    render(<MappingsPanel annotationId="H" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    expect(screen.getByText(/broad category/i)).toBeInTheDocument()
    const sampleInput = screen.getByRole('spinbutton') as HTMLInputElement
    expect(sampleInput.value).toBe('5')
  })

  it('does NOT call a single high-volume leaf id "a broad category" (2026-09-25 fix: COG only has 2 hierarchy levels -- a leaf has no members to be broad)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('5/27/21 8:00')],
      sample_count: 5,
      samples_were_capped: true,
      leaf_count: 1, // e.g. COG2801: one specific COG, just individually high-volume
    }))
    render(<MappingsPanel annotationId="COG2801" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    expect(screen.queryByText(/broad category/i)).not.toBeInTheDocument()
    expect(screen.getByText(/matches a very large number of gene records/i)).toBeInTheDocument()
  })

  it('discloses results_were_truncated separately from samples_were_capped -- a single abundant leaf organism that was never sample-capped at all (2026-09-25 fix: this case first crashed the whole server via OOM before the row limit existed)', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('5/27/21 8:00')],
      sample_count: 128,
      samples_were_capped: false,
      results_were_truncated: true,
      leaf_count: 1,
    }))
    render(<MappingsPanel annotationId="Marine gamma proteobacterium sp. HTCC2207" source="taxonomy" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    expect(screen.queryByText(/broad category/i)).not.toBeInTheDocument()
    expect(screen.getByText(/extremely large number of individual gene records/i)).toBeInTheDocument()
    expect(screen.getByText(/first 50,000/i)).toBeInTheDocument()
  })

  it('a capped preview offers Export all, which shows the full size and links to the streamed export', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [makeRow('5/27/21 8:00')], sample_count: 5, samples_were_capped: true,
    }))
    render(<MappingsPanel annotationId="H" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    expect(screen.queryByRole('button', { name: /^↓ CSV/i })).not.toBeInTheDocument()
    expect(screen.getByTestId('mappings-export-all-note')).toHaveTextContent(/every gene record/i)

    mockFetch.mockResolvedValue(jsonResponse({
      annotation_id: 'H', source: 'cog', samples: 128, rows: 253_121, max_rows: 5_000_000,
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Export all/i }))

    await waitFor(() => expect(screen.getByTestId('mappings-export-size')).toHaveTextContent('253,121'))
    expect(mockFetch.mock.calls.some(c => String(c[0]).startsWith('/api/mappings/export/summary?annotation_id=H&source=cog'))).toBe(true)
    // The download is a plain link the browser streams to disk -- never a
    // capped JSON fetch turned into a CSV in the page.
    const link = screen.getByRole('link', { name: /Download CSV/i })
    expect(link).toHaveAttribute('href', '/api/mappings/export?annotation_id=H&source=cog&unique_pairs=true')
    expect(link).toHaveAttribute('download')
    expect(mockFetch.mock.calls.some(c => String(c[0]).includes('bypass_cap'))).toBe(false)
    expect(mockDownloadCsv).not.toHaveBeenCalled()
  })

  it('a preview cut at the 50,000-row limit (not sample-capped) also offers Export all, and says it has every record', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [makeRow('5/27/21 8:00')], sample_count: 128, samples_were_capped: false,
      results_were_truncated: true, leaf_count: 1,
    }))
    render(<MappingsPanel annotationId="Bacteria;Proteobacteria" source="taxonomy" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    expect(screen.getByText(/first 50,000/i)).toBeInTheDocument()
    expect(screen.queryByText(/isn't available/i)).not.toBeInTheDocument()
    expect(screen.getByRole('button', { name: /Export all/i })).toBeInTheDocument()
  })

  it('above 1,000,000 rows the download asks for confirmation first, naming the size and the Excel limit', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [makeRow('5/27/21 8:00')], sample_count: 5, samples_were_capped: true,
    }))
    render(<MappingsPanel annotationId="H" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    mockFetch.mockResolvedValue(jsonResponse({
      annotation_id: 'H', source: 'cog', samples: 128, rows: 2_400_000, max_rows: 5_000_000,
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Export all/i }))
    await waitFor(() => expect(screen.getByTestId('mappings-export-size')).toHaveTextContent('2,400,000'))

    expect(screen.queryByRole('link', { name: /Download/i })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: /Download CSV/i }))
    const warning = screen.getByTestId('mappings-export-confirm')
    expect(warning).toHaveTextContent(/2,400,000/)
    expect(warning).toHaveTextContent(/Excel/)
    expect(within(warning).getByRole('link', { name: /Download anyway/i }))
      .toHaveAttribute('href', '/api/mappings/export?annotation_id=H&source=cog&unique_pairs=true')

    await user.click(within(warning).getByRole('button', { name: /Cancel/i }))
    expect(screen.queryByTestId('mappings-export-confirm')).not.toBeInTheDocument()
  })

  it("above the server's limit there is no download, only a way to narrow it", async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [makeRow('5/27/21 8:00')], sample_count: 5, samples_were_capped: true,
    }))
    render(<MappingsPanel annotationId="Bacteria" source="taxonomy" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    mockFetch.mockResolvedValue(jsonResponse({
      annotation_id: 'Bacteria', source: 'taxonomy', samples: 128, rows: 59_780_871, max_rows: 5_000_000,
    }))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Export all/i }))

    const tooBig = await screen.findByTestId('mappings-export-too-big')
    expect(tooBig).toHaveTextContent('59,780,871')
    expect(tooBig).toHaveTextContent('5,000,000')
    expect(tooBig).toHaveTextContent(/date range/i)
    expect(screen.queryByRole('link', { name: /Download/i })).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: /Download CSV/i })).not.toBeInTheDocument()
  })

  it('a date range re-asks for the size and goes into the download link', async () => {
    mockFetch.mockResolvedValueOnce(jsonResponse({
      data: [makeRow('5/27/21 8:00')], sample_count: 5, samples_were_capped: true,
    }))
    render(<MappingsPanel annotationId="H" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))
    mockFetch.mockImplementation(async (url: string) => jsonResponse(
      url.includes('date_from')
        ? { annotation_id: 'H', source: 'cog', samples: 18, rows: 30_000, max_rows: 5_000_000 }
        : { annotation_id: 'H', source: 'cog', samples: 128, rows: 253_121, max_rows: 5_000_000 },
    ))
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /Export all/i }))
    await waitFor(() => expect(screen.getByTestId('mappings-export-size')).toHaveTextContent('253,121'))

    const [fromInput] = screen.getByTestId('mappings-export').querySelectorAll('input[type="date"]')
    fireEvent.change(fromInput, { target: { value: '2021-06-02' } })

    await waitFor(() => expect(screen.getByTestId('mappings-export-size')).toHaveTextContent('30,000'))
    expect(screen.getByTestId('mappings-export-size')).toHaveTextContent('18 samples')
    expect(screen.getByRole('link', { name: /Download CSV/i }).getAttribute('href')).toContain('date_from=2021-06-02')
  })

  it('CSV export does NOT re-fetch when the preview was never capped -- uses the already-loaded rows', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [makeRow('5/27/21 8:00')], sample_count: 128, samples_were_capped: false,
    }))
    render(<MappingsPanel annotationId="COG0055" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    // Not limited: the button stays "CSV" and there's no export-all line.
    expect(screen.queryByRole('button', { name: /Export all/i })).not.toBeInTheDocument()
    expect(screen.queryByTestId('mappings-export-all-note')).not.toBeInTheDocument()
    const user = userEvent.setup()
    await user.click(screen.getByRole('button', { name: /CSV/i }))

    await waitFor(() => expect(mockDownloadCsv).toHaveBeenCalledTimes(1))
    expect(mockFetch).toHaveBeenCalledTimes(1) // no second fetch
  })
})

// The capped-request disclosure banner above the table is gated on
// `allRows.length > 0`, so a broad category capped down to a handful of
// samples that finds zero rows in that small real scope needs its own
// empty-state message -- the plain one names requestedSampleCount (the
// full, un-capped ask), so a capped 5-of-128 search with 0 hits would read
// "No mappings found... in the selected 128 samples", overstating the
// real search scope by ~25x.
describe('MappingsPanel — empty-state discloses the real cap scope', () => {
  it('names the real (capped) sample count, not the full request, when a capped search finds zero rows', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [],
      sample_count: 5,
      samples_were_capped: true,
      leaf_count: 25, // "H" is a real, many-member COG category
    }))
    render(<MappingsPanel annotationId="H" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    expect(screen.getByText(/No mappings found/i)).toBeInTheDocument()
    expect(screen.getByText(/the 5 samples actually searched/i)).toBeInTheDocument()
    expect(screen.getByText(/broad category/i)).toBeInTheDocument()
    expect(screen.getByText(/of the requested 128 samples/i)).toBeInTheDocument()
    // The pre-fix message named only the uncapped ask, with no real
    // scope disclosed at all -- must not still be present verbatim.
    expect(screen.queryByText(/in the\s*selected 128 samples/i)).not.toBeInTheDocument()
  })

  it('keeps the plain empty-state message when the search was never capped', async () => {
    mockFetch.mockResolvedValue(jsonResponse({
      data: [],
      sample_count: 128,
      samples_were_capped: false,
    }))
    render(<MappingsPanel annotationId="COG0055" source="cog" />)
    await open()
    await waitFor(() => expect(mockFetch).toHaveBeenCalledTimes(1))

    expect(screen.getByText(/No mappings found for/i)).toBeInTheDocument()
    expect(screen.getByText(/selected 128 samples/i)).toBeInTheDocument()
    expect(screen.queryByText(/actually searched/i)).not.toBeInTheDocument()
  })
})

describe('MappingsPanel — an older response never replaces a newer one', () => {
  it('keeps the latest request\'s rows when the earlier one finishes last', async () => {
    const resolvers: ((v: unknown) => void)[] = []
    mockFetch.mockImplementation((url: string) =>
      url.includes('/api/mappings/search')
        ? new Promise(resolve => resolvers.push(resolve))
        : Promise.resolve(jsonResponse({})),
    )
    render(<MappingsPanel annotationId="K00001" source="kegg" />)
    const user = await open()                                 // request 1 (all pairs)
    await user.click(screen.getByRole('checkbox', { name: /unique pairs only/i }))  // request 2
    await waitFor(() => expect(resolvers).toHaveLength(2))

    // The newer request (2 rows) answers first, then the older one (1 row).
    resolvers[1](jsonResponse({ data: [makeRow('5/27/21 8:00', 'K1'), makeRow('5/28/21 8:00', 'K2')] }))
    const rowCount = () => document.querySelector('.toggle-count')?.textContent
    await waitFor(() => expect(rowCount()).toBe('2 unique combinations'))
    resolvers[0](jsonResponse({ data: [makeRow('5/27/21 8:00', 'K9')] }))

    await new Promise(r => setTimeout(r, 50))
    expect(rowCount()).toBe('2 unique combinations')
  })
})
